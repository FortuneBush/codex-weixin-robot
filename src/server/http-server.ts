import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { resolveCodexCommand } from "../codex/exec-runner.js";
import { calculateTokenCost } from "../codex/pricing.js";
import { loadConfig, saveConfig } from "../state/config.js";
import type { StatePaths } from "../state/paths.js";
import type { CodexModelOption, CodexRuntimeInfo } from "../codex/app-server-runner.js";
import type { AccountManager, AccountSession, SessionAttachmentFile, SessionHistoryMessage, SessionUpload } from "./account-manager.js";
import { LoginManager } from "./login-manager.js";
import { UpdateManager, type UpdateService } from "./update-manager.js";

type UsageNumbers = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  lastUsedAt?: string;
};

type UsageMetrics = UsageNumbers & {
  /** Ratio of cached input tokens to all input tokens, in the range 0..1. */
  cacheHitRate: number;
  estimatedCostUsd?: number;
};

type UsageRecordView = {
  at: string;
  threadId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheHitRate: number;
  accountId: string;
  sessionId: string;
  title: string;
  model?: string;
  estimatedCostUsd?: number;
};

type UsageSessionView = {
  accountId: string;
  sessionId: string;
  title: string;
  workspace: string;
  usage: UsageMetrics;
  records: Array<Omit<UsageRecordView, "accountId" | "sessionId" | "title">>;
};

type UsageQuery = {
  accountId?: string;
  sessionId?: string;
  sort: "total" | "input" | "output" | "cache" | "recent";
  sessionPage: number;
  recentPage: number;
  pageSize: number;
  recentPageSize: number;
  from?: string;
  to?: string;
};

const bodySchema = z.record(z.string(), z.unknown());
const accountDisplayNameSchema = z.object({
  displayName: z.string().max(40)
});
const accountDeleteSchema = z.object({
  retainHistory: z.boolean().optional()
});
const sessionPatchSchema = z.object({
  title: z.string().max(80).optional(),
  model: z.string().max(200).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
  streamReplies: z.boolean().nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "Session update is empty");
const configSchema = z.object({
  defaultCwd: z.string().min(1),
  allowedWorkspaces: z.array(z.string().min(1)).min(1),
  codexBackend: z.enum(["auto", "app-server", "exec"]),
  codexExecSandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullable().optional(),
  codexTimeoutMs: z.number().int().min(60_000).max(86_400_000).nullable().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  modelPricing: z.record(z.string().min(1).max(200), z.object({
    inputPerMillionUsd: z.number().finite().min(0).max(1_000_000),
    outputPerMillionUsd: z.number().finite().min(0).max(1_000_000),
    cachedInputPerMillionUsd: z.number().finite().min(0).max(1_000_000).optional()
  })).optional(),
  streamReplies: z.boolean().optional()
});
const MAX_WEB_UPLOAD_FILES = 10;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

const webRoot = fileURLToPath(new URL("../web", import.meta.url));
const execFileAsync = promisify(execFile);

export type LocalHttpServerOptions = {
  paths: StatePaths;
  accountManager: AccountManager;
  loginManager?: LoginManager;
  productVersion?: string;
  port?: number;
  codexCheck?: () => Promise<{ ready: boolean; version?: string; error?: string }>;
  codexRuntimeCheck?: () => Promise<CodexRuntimeInfo>;
  codexModelsCheck?: () => Promise<CodexModelOption[]>;
  updateService?: UpdateService;
  onUpdateInstalled?: (version: string) => void;
};

export type LocalHttpServer = {
  url: string;
  requestToken: string;
  close: () => Promise<void>;
};

export async function startLocalHttpServer(options: LocalHttpServerOptions): Promise<LocalHttpServer> {
  const requestToken = crypto.randomBytes(24).toString("base64url");
  const productVersion = options.productVersion ?? readProductVersion();
  const loginManager = options.loginManager ?? new LoginManager({
    paths: options.paths,
    accountManager: options.accountManager
  });
  const updateService = options.updateService ?? new UpdateManager({ currentVersion: productVersion });
  let actualPort = options.port ?? 8787;
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      loginManager,
      productVersion,
      requestToken,
      updateService,
      port: actualPort
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, errorStatus(message), { error: message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine local server address");
  }
  actualPort = address.port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    requestToken,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

type HandlerContext = LocalHttpServerOptions & {
  loginManager: LoginManager;
  productVersion: string;
  requestToken: string;
  updateService: UpdateService;
  port: number;
};

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: HandlerContext): Promise<void> {
  setSecurityHeaders(response);
  if (!isAllowedHost(request.headers.host, context.port)) {
    sendJson(response, 403, { error: "Local host required" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const method = request.method ?? "GET";
  if (isMutation(method)) {
    if (!isAllowedOrigin(request.headers.origin, context.port)) {
      sendJson(response, 403, { error: "Local origin required" });
      return;
    }
    if (request.headers["x-codex-weixin-token"] !== context.requestToken) {
      sendJson(response, 403, { error: "Invalid request token" });
      return;
    }
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const config = loadConfig(context.paths);
    const [codex, codexRuntime, codexModels] = await Promise.all([
      (context.codexCheck ?? (() => checkCodex(config.codexBin)))(),
      readCodexRuntime(context),
      readCodexModels(context)
    ]);
    sendJson(response, 200, {
      product: "codex-weixin",
      version: context.productVersion,
      requestToken: context.requestToken,
      config,
      codex,
      codexRuntime,
      codexModels,
      accounts: context.accountManager.listAccounts(),
      sessions: publicSessionSummaries(context.accountManager.listSessions())
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/update") {
    const force = url.searchParams.get("force") === "1";
    if (force && (
      !isAllowedOrigin(request.headers.origin, context.port)
      || request.headers["x-codex-weixin-token"] !== context.requestToken
    )) {
      sendJson(response, 403, { error: "Invalid manual update check" });
      return;
    }
    sendJson(response, 200, await context.updateService.check(force));
    return;
  }
  if (method === "POST" && url.pathname === "/api/update") {
    const result = await context.updateService.installLatest();
    sendJson(response, 200, { ok: true, ...result, restarting: Boolean(context.onUpdateInstalled) });
    if (context.onUpdateInstalled) {
      const timer = setTimeout(() => {
        try {
          context.onUpdateInstalled?.(result.version);
        } catch (error) {
          console.error(`[codex-weixin] unable to schedule restart: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, 250);
      timer.unref();
    }
    return;
  }
  if (method === "GET" && url.pathname === "/api/accounts") {
    sendJson(response, 200, { accounts: context.accountManager.listAccounts() });
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions") {
    sendJson(response, 200, { sessions: publicSessionSummaries(context.accountManager.listSessions()) });
    return;
  }
  if (method === "GET" && url.pathname === "/api/usage") {
    const config = loadConfig(context.paths);
    sendJson(response, 200, buildUsageResponse(
      context.accountManager.listSessions(),
      url.searchParams,
      config.modelPricing
    ));
    return;
  }
  if (method === "POST" && url.pathname === "/api/logins") {
    sendJson(response, 201, await context.loginManager.start());
    return;
  }
  const loginMatch = matchPath(url.pathname, "/api/logins/:id");
  if (method === "GET" && loginMatch) {
    sendJson(response, 200, await context.loginManager.poll(loginMatch.id));
    return;
  }

  const accountAction = matchPath(url.pathname, "/api/accounts/:accountId/:action");
  if (method === "POST" && accountAction?.action === "start") {
    sendJson(response, 200, await context.accountManager.startAccount(accountAction.accountId));
    return;
  }
  if (method === "POST" && accountAction?.action === "stop") {
    sendJson(response, 200, await context.accountManager.stopAccount(accountAction.accountId));
    return;
  }
  const accountMatch = matchPath(url.pathname, "/api/accounts/:accountId");
  if (method === "PATCH" && accountMatch) {
    const body = accountDisplayNameSchema.parse(await readJsonBody(request));
    sendJson(response, 200, {
      account: context.accountManager.renameAccount(accountMatch.accountId, body.displayName)
    });
    return;
  }
  if (method === "DELETE" && accountMatch) {
    const body = accountDeleteSchema.parse(await readJsonBody(request));
    await context.accountManager.removeAccount(accountMatch.accountId, {
      retainHistory: body.retainHistory === true
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  const accessMatch = matchPath(url.pathname, "/api/accounts/:accountId/senders/:senderId/:action");
  if (method === "POST" && accessMatch?.action === "allow") {
    context.accountManager.allowSender(accessMatch.accountId, accessMatch.senderId);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "POST" && accessMatch?.action === "remove") {
    context.accountManager.removeSender(accessMatch.accountId, accessMatch.senderId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/sessions") {
    const body = bodySchema.parse(await readJsonBody(request));
    const session = context.accountManager.createSession(
      requiredString(body.accountId, "accountId"),
      requiredString(body.senderId, "senderId"),
      optionalString(body.workspace),
      optionalString(body.title)
    );
    sendJson(response, 201, { session });
    return;
  }
  const attachmentMatch = matchPath(
    url.pathname,
    "/api/sessions/:accountId/:sessionId/messages/:messageId/attachments/:attachmentIndex"
  );
  if ((method === "GET" || method === "HEAD") && attachmentMatch) {
    const attachmentIndex = Number(attachmentMatch.attachmentIndex);
    if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0) {
      throw new Error("Invalid session attachment index");
    }
    const attachment = await context.accountManager.getSessionAttachment(
      attachmentMatch.accountId,
      attachmentMatch.sessionId,
      attachmentMatch.messageId,
      attachmentIndex
    );
    serveSessionAttachment(
      request,
      response,
      attachment,
      url.searchParams.get("download") === "1",
      method === "HEAD"
    );
    return;
  }
  const sessionAction = matchPath(url.pathname, "/api/sessions/:accountId/:sessionId/:action");
  if (method === "GET" && sessionAction?.action === "messages") {
    const messages = await context.accountManager.getSessionMessages(sessionAction.accountId, sessionAction.sessionId);
    sendJson(response, 200, {
      messages: withAttachmentUrls(messages, sessionAction.accountId, sessionAction.sessionId)
    });
    return;
  }
  if (method === "POST" && sessionAction?.action === "messages") {
    const body = await readSessionMessageBody(request, loadConfig(context.paths).maxInboundBytes);
    const stream = url.searchParams.get("stream") === "1"
      && context.accountManager.isSessionStreamEnabled(sessionAction.accountId, sessionAction.sessionId);
    if (stream) {
      startNdjson(response);
      try {
        const result = await context.accountManager.continueSession(
          sessionAction.accountId,
          sessionAction.sessionId,
          body.text,
          body.uploads,
          async (message) => writeNdjson(response, { type: "progress", message })
        );
        await writeNdjson(response, { type: "done", result });
      } catch (error) {
        await writeNdjson(response, {
          type: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (!response.writableEnded) response.end();
      }
      return;
    }
    sendJson(response, 200, {
      result: await context.accountManager.continueSession(
        sessionAction.accountId,
        sessionAction.sessionId,
        body.text,
        body.uploads
      )
    });
    return;
  }
  if (method === "POST" && sessionAction?.action === "activate") {
    sendJson(response, 200, { session: context.accountManager.activateSession(sessionAction.accountId, sessionAction.sessionId) });
    return;
  }
  if (method === "POST" && sessionAction?.action === "reset") {
    sendJson(response, 200, { session: context.accountManager.resetSession(sessionAction.accountId, sessionAction.sessionId) });
    return;
  }
  const sessionMatch = matchPath(url.pathname, "/api/sessions/:accountId/:sessionId");
  if (method === "PATCH" && sessionMatch) {
    const body = sessionPatchSchema.parse(await readJsonBody(request));
    let session;
    if (body.title !== undefined) {
      session = context.accountManager.renameSession(
        sessionMatch.accountId,
        sessionMatch.sessionId,
        body.title
      );
    }
    if (body.model !== undefined || body.effort !== undefined || body.streamReplies !== undefined) {
      session = context.accountManager.updateSessionRuntime(
        sessionMatch.accountId,
        sessionMatch.sessionId,
        {
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          ...(body.streamReplies !== undefined ? { streamReplies: body.streamReplies } : {})
        }
      );
    }
    sendJson(response, 200, {
      session
    });
    return;
  }
  if (method === "DELETE" && sessionMatch) {
    context.accountManager.deleteSession(sessionMatch.accountId, sessionMatch.sessionId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "PUT" && url.pathname === "/api/config") {
    const input = configSchema.parse(await readJsonBody(request));
    const current = loadConfig(context.paths);
    const defaultCwd = path.resolve(input.defaultCwd);
    const allowedWorkspaces = [...new Set([...input.allowedWorkspaces.map((workspace) => path.resolve(workspace)), defaultCwd])];
    const nextConfig = {
      ...current,
      ...input,
      defaultCwd,
      allowedWorkspaces,
      codexExecSandbox: input.codexExecSandbox ?? undefined,
      codexTimeoutMs: input.codexTimeoutMs !== undefined ? input.codexTimeoutMs : current.codexTimeoutMs,
      model: optionalString(input.model),
      effort: optionalString(input.effort),
      modelPricing: input.modelPricing ?? current.modelPricing
    };
    const runtimeChanged = current.defaultCwd !== nextConfig.defaultCwd
      || current.codexBackend !== nextConfig.codexBackend
      || current.codexExecSandbox !== nextConfig.codexExecSandbox
      || current.codexTimeoutMs !== nextConfig.codexTimeoutMs
      || current.model !== nextConfig.model
      || current.effort !== nextConfig.effort
      || current.streamReplies !== nextConfig.streamReplies
      || current.allowedWorkspaces.length !== nextConfig.allowedWorkspaces.length
      || current.allowedWorkspaces.some((workspace, index) => workspace !== nextConfig.allowedWorkspaces[index]);
    saveConfig(context.paths, nextConfig);
    if (runtimeChanged) await context.accountManager.restartRunning();
    sendJson(response, 200, {
      config: loadConfig(context.paths),
      codexRuntime: await readCodexRuntime(context),
      codexModels: await readCodexModels(context)
    });
    return;
  }

  if (method === "GET" && !url.pathname.startsWith("/api/")) {
    serveStatic(response, url.pathname);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

/**
 * Build the usage dashboard response on the server. Keeping filtering,
 * aggregation and pagination here prevents the browser from downloading every
 * session and every request record on each refresh.
 */
function buildUsageResponse(
  sessions: AccountSession[],
  searchParams: URLSearchParams,
  modelPricing: import("../codex/pricing.js").ModelPricingTable = {}
): {
  totals: UsageMetrics;
  timeline: Array<{ date: string } & UsageMetrics>;
  sessions: Array<Omit<UsageSessionView, "records">>;
  recent: Array<UsageRecordView & { session: { accountId: string; sessionId: string; title: string } }>;
  pagination: {
    sessions: UsagePagination;
    recent: UsagePagination;
  };
  filters: Omit<UsageQuery, "sessionPage" | "recentPage" | "pageSize" | "recentPageSize"> & {
    sessionPage: number;
    recentPage: number;
    pageSize: number;
    recentPageSize: number;
  };
} {
  const query = parseUsageQuery(searchParams);
  const candidates = sessions
    .filter((session) => !query.accountId || session.accountId === query.accountId)
    .filter((session) => !query.sessionId || session.id === query.sessionId);
  const views = candidates.flatMap((session): UsageSessionView[] => {
    const sourceRecords = session.tokenUsageRecords ?? [];
    const records = sourceRecords
      .filter((record) => usageDateInRange(record.at, query.from, query.to))
      .map((record) => ({
        at: record.at,
        ...(record.threadId ? { threadId: record.threadId } : {}),
        ...(record.model ? { model: record.model } : {}),
        inputTokens: finiteUsageNumber(record.inputTokens),
        outputTokens: finiteUsageNumber(record.outputTokens),
        totalTokens: finiteUsageNumber(record.totalTokens),
        cachedInputTokens: finiteUsageNumber(record.cachedInputTokens),
        cacheHitRate: cacheHitRate(record.inputTokens, record.cachedInputTokens),
        ...(() => {
          const cost = calculateTokenCost(record, record.model ?? session.model, modelPricing);
          return cost ? { estimatedCostUsd: cost.totalCostUsd } : {};
        })()
      }));
    const estimatedCostUsd = records.some((record) => record.estimatedCostUsd !== undefined)
      ? records.reduce((sum, record) => sum + (record.estimatedCostUsd ?? 0), 0)
      : undefined;
    if (!records.length && (!session.tokenUsage || finiteUsageNumber(session.tokenUsage.totalTokens) <= 0)) {
      return [];
    }

    let usage: UsageMetrics;
    if (query.from || query.to) {
      if (!records.length) return [];
      usage = withCacheHitRate(records.reduce((sum, record) => {
        sum.inputTokens += record.inputTokens;
        sum.outputTokens += record.outputTokens;
        sum.totalTokens += record.totalTokens;
        sum.cachedInputTokens += record.cachedInputTokens;
        sum.turnCount += 1;
        return sum;
      }, emptyUsageNumbers()));
      usage.lastUsedAt = records
        .map((record) => record.at)
        .sort((a, b) => b.localeCompare(a))[0];
    } else if (session.tokenUsage) {
      usage = withCacheHitRate({
        inputTokens: finiteUsageNumber(session.tokenUsage.inputTokens),
        outputTokens: finiteUsageNumber(session.tokenUsage.outputTokens),
        totalTokens: finiteUsageNumber(session.tokenUsage.totalTokens),
        cachedInputTokens: finiteUsageNumber(session.tokenUsage.cachedInputTokens),
        turnCount: finiteUsageNumber(session.tokenUsage.turnCount),
        lastUsedAt: session.tokenUsage.lastUsedAt
      });
    } else {
      if (!records.length) return [];
      usage = withCacheHitRate(records.reduce((sum, record) => {
        sum.inputTokens += record.inputTokens;
        sum.outputTokens += record.outputTokens;
        sum.totalTokens += record.totalTokens;
        sum.cachedInputTokens += record.cachedInputTokens;
        sum.turnCount += 1;
        return sum;
      }, emptyUsageNumbers()));
      usage.lastUsedAt = records
        .map((record) => record.at)
        .sort((a, b) => b.localeCompare(a))[0];
    }
    if (estimatedCostUsd !== undefined) usage.estimatedCostUsd = estimatedCostUsd;

    return [{
      accountId: session.accountId,
      sessionId: session.id,
      title: session.title,
      workspace: session.workspace,
      usage,
      records
    }];
  });

  const totals = withCacheHitRate(views.reduce((sum, session) => {
    sum.inputTokens += session.usage.inputTokens;
    sum.outputTokens += session.usage.outputTokens;
    sum.totalTokens += session.usage.totalTokens;
    sum.cachedInputTokens += session.usage.cachedInputTokens;
    sum.turnCount += session.usage.turnCount;
    return sum;
  }, emptyUsageNumbers()));
  const totalEstimatedCostUsd = views.some((session) => session.usage.estimatedCostUsd !== undefined)
    ? views.reduce((sum, session) => sum + (session.usage.estimatedCostUsd ?? 0), 0)
    : undefined;
  if (totalEstimatedCostUsd !== undefined) totals.estimatedCostUsd = totalEstimatedCostUsd;

  const timeline = new Map<string, UsageNumbers>();
  const allRecords: UsageRecordView[] = [];
  for (const session of views) {
    for (const record of session.records) {
      const date = record.at.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const bucket = timeline.get(date) ?? emptyUsageNumbers();
      bucket.inputTokens += record.inputTokens;
      bucket.outputTokens += record.outputTokens;
      bucket.totalTokens += record.totalTokens;
      bucket.cachedInputTokens += record.cachedInputTokens;
      bucket.turnCount += 1;
      timeline.set(date, bucket);
      allRecords.push({
        ...record,
        accountId: session.accountId,
        sessionId: session.sessionId,
        title: session.title
      });
    }
  }

  const sortedSessions = [...views].sort((a, b) => compareUsageSessions(a, b, query.sort));
  const sortedRecords = allRecords.sort((a, b) => b.at.localeCompare(a.at));
  const sessionPage = paginate(sortedSessions, query.sessionPage, query.pageSize);
  const recentPage = paginate(sortedRecords, query.recentPage, query.recentPageSize);

  return {
    totals,
    timeline: [...timeline.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, usage]) => ({ date, ...withCacheHitRate(usage) })),
    sessions: sessionPage.items.map(({ records: _records, ...session }) => session),
    recent: recentPage.items.map((record) => ({
      ...record,
      session: {
        accountId: record.accountId,
        sessionId: record.sessionId,
        title: record.title
      }
    })),
    pagination: {
      sessions: sessionPage.meta,
      recent: recentPage.meta
    },
    filters: query
  };
}

function publicSessionSummaries(sessions: AccountSession[]): Array<Omit<AccountSession, "tokenUsageRecords">> {
  return sessions.map(({ tokenUsageRecords: _records, ...session }) => session);
}

type UsagePagination = {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
};

function paginate<T>(items: T[], requestedPage: number, pageSize: number): { items: T[]; meta: UsagePagination } {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    meta: { page, pageSize, total: items.length, pageCount }
  };
}

function parseUsageQuery(searchParams: URLSearchParams): UsageQuery {
  const accountId = firstQueryValue(searchParams, "accountId", "account");
  const sessionId = firstQueryValue(searchParams, "sessionId", "session");
  const sortValue = firstQueryValue(searchParams, "sort") ?? "total";
  if (!(["total", "input", "output", "cache", "recent"] as const).includes(sortValue as UsageQuery["sort"])) {
    throw new Error("Invalid usage sort");
  }
  const pageSize = queryInteger(searchParams, "pageSize", 10, 1, 100);
  const recentPageSize = queryInteger(searchParams, "recentPageSize", pageSize, 1, 100);
  const sessionPage = queryInteger(
    searchParams,
    "sessionPage",
    queryInteger(searchParams, "page", 1, 1, 10_000),
    1,
    10_000
  );
  const recentPage = queryInteger(searchParams, "recentPage", 1, 1, 10_000);
  const from = parseDateQuery(firstQueryValue(searchParams, "from", "dateFrom", "startDate"), "from");
  const to = parseDateQuery(firstQueryValue(searchParams, "to", "dateTo", "endDate"), "to");
  if (from && to && from > to) throw new Error("Usage date range is invalid");
  return {
    ...(accountId ? { accountId } : {}),
    ...(sessionId ? { sessionId } : {}),
    sort: sortValue as UsageQuery["sort"],
    sessionPage,
    recentPage,
    pageSize,
    recentPageSize,
    ...(from ? { from } : {}),
    ...(to ? { to } : {})
  };
}

function firstQueryValue(searchParams: URLSearchParams, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = searchParams.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function queryInteger(searchParams: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`Invalid usage ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid usage ${name}`);
  return value;
}

function parseDateQuery(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid usage ${name} date`);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid usage ${name} date`);
  }
  return value;
}

function usageDateInRange(value: string, from?: string, to?: string): boolean {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return (!from || date >= from) && (!to || date <= to);
}

function compareUsageSessions(a: UsageSessionView, b: UsageSessionView, sort: UsageQuery["sort"]): number {
  if (sort === "input") return compareNumbers(b.usage.inputTokens, a.usage.inputTokens) || compareUsageIdentity(a, b);
  if (sort === "output") return compareNumbers(b.usage.outputTokens, a.usage.outputTokens) || compareUsageIdentity(a, b);
  if (sort === "cache") return compareNumbers(b.usage.cacheHitRate, a.usage.cacheHitRate) || compareUsageIdentity(a, b);
  if (sort === "recent") return String(b.usage.lastUsedAt ?? "").localeCompare(String(a.usage.lastUsedAt ?? "")) || compareUsageIdentity(a, b);
  return compareNumbers(b.usage.totalTokens, a.usage.totalTokens) || compareUsageIdentity(a, b);
}

function compareUsageIdentity(a: UsageSessionView, b: UsageSessionView): number {
  return `${a.title}\u0000${a.sessionId}`.localeCompare(`${b.title}\u0000${b.sessionId}`, "zh-CN");
}

function compareNumbers(a: number, b: number): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

function readProductVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readCodexRuntime(context: HandlerContext): Promise<CodexRuntimeInfo> {
  return (context.codexRuntimeCheck ?? (() => context.accountManager.getCodexRuntimeInfo()))();
}

function readCodexModels(context: HandlerContext): Promise<CodexModelOption[]> {
  return (context.codexModelsCheck ?? (() => context.accountManager.getCodexModels()))();
}

function serveStatic(response: ServerResponse, pathname: string): void {
  const files: Record<string, { name: string; type: string }> = {
    "/": { name: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
    "/favicon.ico": { name: "favicon.svg", type: "image/svg+xml" },
    "/favicon.svg": { name: "favicon.svg", type: "image/svg+xml" },
    "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
    "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
    "/vendor/lucide.min.js": { name: "vendor/lucide.min.js", type: "text/javascript; charset=utf-8" },
    "/vendor/marked.umd.js": { name: "vendor/marked.umd.js", type: "text/javascript; charset=utf-8" },
    "/vendor/purify.min.js": { name: "vendor/purify.min.js", type: "text/javascript; charset=utf-8" }
  };
  const asset = files[pathname];
  if (!asset) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const filePath = path.join(webRoot, asset.name);
  if (!fs.existsSync(filePath)) {
    sendJson(response, 503, { error: "Web assets are not built" });
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.type);
  response.end(fs.readFileSync(filePath));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function matchPath(pathname: string, pattern: string): Record<string, string> | undefined {
  const actual = pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (actual.length !== expected.length) return undefined;
  const values: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (segment.startsWith(":")) {
      values[segment.slice(1)] = decodeURIComponent(actual[index]);
    } else if (segment !== actual[index]) {
      return undefined;
    }
  }
  return values;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBodyBuffer(request, 1024 * 1024);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

async function readBodyBuffer(request: IncomingMessage, maxBytes: number, limitMessage = "Request body is too large"): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(limitMessage);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(limitMessage);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readSessionMessageBody(
  request: IncomingMessage,
  maxUploadBytes: number
): Promise<{ text: string; uploads: SessionUpload[] }> {
  const contentType = request.headers["content-type"];
  const normalizedContentType = Array.isArray(contentType) ? contentType[0] : contentType ?? "";
  if (!normalizedContentType.toLowerCase().startsWith("multipart/form-data")) {
    const body = bodySchema.parse(await readJsonBody(request));
    return { text: requiredString(body.text, "text"), uploads: [] };
  }

  const limitMessage = `Attachments exceed the ${formatByteLimit(maxUploadBytes)} limit`;
  const raw = await readBodyBuffer(request, maxUploadBytes + MULTIPART_OVERHEAD_BYTES, limitMessage);
  let formData: FormData;
  try {
    formData = await new Response(new Uint8Array(raw), {
      headers: { "Content-Type": normalizedContentType }
    }).formData();
  } catch {
    throw new Error("Invalid multipart form data");
  }
  const textEntry = formData.get("text");
  const text = typeof textEntry === "string" ? textEntry.trim() : "";
  const fileEntries = formData.getAll("files");
  if (fileEntries.length > MAX_WEB_UPLOAD_FILES) {
    throw new Error(`Too many attachments; maximum is ${MAX_WEB_UPLOAD_FILES}`);
  }
  const uploads: SessionUpload[] = [];
  let totalBytes = 0;
  for (const entry of fileEntries) {
    if (typeof entry === "string") {
      throw new Error("Invalid attachment");
    }
    const data = Buffer.from(await entry.arrayBuffer());
    totalBytes += data.length;
    if (totalBytes > maxUploadBytes) {
      throw new Error(limitMessage);
    }
    uploads.push({ name: entry.name, data });
  }
  if (!text && !uploads.length) {
    throw new Error("Message text or attachment is required");
  }
  return { text, uploads };
}

function formatByteLimit(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} byte${bytes === 1 ? "" : "s"}`;
}

function emptyUsageNumbers(): UsageNumbers {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, turnCount: 0 };
}

function cacheHitRate(inputTokens: number, cachedInputTokens: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return 0;
  return Math.min(1, Math.max(0, cachedInputTokens / inputTokens));
}

function finiteUsageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function withCacheHitRate(usage: UsageNumbers): UsageMetrics {
  return { ...usage, cacheHitRate: cacheHitRate(usage.inputTokens, usage.cachedInputTokens) };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorStatus(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/already in progress|no newer/i.test(message)) return 409;
  if (/unable to verify|timed out/i.test(message)) return 503;
  return /required|invalid|allowed|empty|too large|too many|exceed/i.test(message) ? 400 : 500;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function startNdjson(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Accel-Buffering", "no");
}

async function writeNdjson(response: ServerResponse, value: unknown): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  if (response.write(`${JSON.stringify(value)}\n`)) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
  });
}

function withAttachmentUrls(
  messages: SessionHistoryMessage[],
  accountId: string,
  sessionId: string
): Array<SessionHistoryMessage & { attachments: Array<SessionHistoryMessage["attachments"][number] & { url?: string }> }> {
  return messages.map((message) => ({
    ...message,
    attachments: (message.attachments ?? []).map((attachment) => ({
      ...attachment,
      ...(attachment.available ? {
        url: [
          "/api/sessions",
          encodeURIComponent(accountId),
          encodeURIComponent(sessionId),
          "messages",
          encodeURIComponent(message.id),
          "attachments",
          String(attachment.index)
        ].join("/")
      } : {})
    }))
  }));
}

function serveSessionAttachment(
  request: IncomingMessage,
  response: ServerResponse,
  attachment: SessionAttachmentFile,
  download: boolean,
  headOnly: boolean
): void {
  const stat = fs.statSync(attachment.path);
  if (!stat.isFile()) {
    throw new Error("Session attachment not found");
  }
  const range = parseByteRange(request.headers.range, stat.size);
  if (range === null) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${stat.size}`);
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  response.statusCode = range ? 206 : 200;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", mediaContentType(attachment.name));
  response.setHeader("Content-Length", String(Math.max(0, end - start + 1)));
  response.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`
  );
  if (range) {
    response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  }
  if (headOnly || stat.size === 0) {
    response.end();
    return;
  }
  const stream = fs.createReadStream(attachment.path, { start, end });
  stream.on("error", (error) => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: error.message });
    } else {
      response.destroy(error);
    }
  });
  stream.pipe(response);
}

function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function mediaContentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return ({
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".zip": "application/zip"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

export async function checkCodex(codexBin: string): Promise<{ ready: boolean; version?: string; error?: string }> {
  try {
    const command = resolveCodexCommand(codexBin);
    const result = await execFileAsync(command.command, [...command.argsPrefix, "--version"], {
      timeout: 5_000,
      windowsHide: true
    });
    return { ready: true, version: result.stdout.trim() || result.stderr.trim() || codexBin };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}
