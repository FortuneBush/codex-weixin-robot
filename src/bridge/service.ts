import path from "node:path";

import { AccessController } from "./access.js";
import { parseActionBlocks } from "./actions.js";
import { buildPrompt, buildPromptPreview, chunkText, parsePrompt } from "./format.js";
import { PromptBuffer } from "./prompt-buffer.js";
import type { CodexModelOption, CodexRuntimeInfo } from "../codex/app-server-runner.js";
import { HybridCodexRunner, isUnavailableCodexThreadError } from "../codex/runner.js";
import { isWorkspaceAllowed, type CodexWeixinConfig } from "../state/config.js";
import { RuntimeStateStore, type ManagedSession } from "../state/runtime-state.js";
import { WeixinApiClient, isStaleContextError, type FetchLike } from "../weixin/api.js";
import { downloadInboundAttachments, InboundMediaTooLargeError, sendLocalMediaFile } from "../weixin/media.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { PromptBufferItem } from "./prompt-buffer.js";

export type BridgeServiceOptions = {
  config: CodexWeixinConfig;
  stateStore: RuntimeStateStore;
  weixin: WeixinApiClient;
  runner?: HybridCodexRunner;
  listCodexModels?: () => Promise<CodexModelOption[]>;
  inboundDir?: string;
  mediaFetch?: FetchLike;
  onTurnStatus?: (status: { senderId: string; sessionId: string; active: boolean }) => void;
};

const PROGRESS_SEND_INTERVAL_MS = 4_000;
const PROGRESS_IMPORTANT_INTERVAL_MS = 2_000;
const PROGRESS_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_PROGRESS_MESSAGES_PER_TURN = 6;

/**
 * Coalesces fast Codex progress events before sending them to WeChat.
 * The callback from the Codex runner stays synchronous, so a slow WeChat
 * request cannot hold up the app-server turn or the final answer.
 */
class ProgressNotifier {
  private pending?: { text: string; important: boolean; heartbeat: boolean };
  private timer?: NodeJS.Timeout;
  private timerDueAt = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private sendChain = Promise.resolve();
  private sending = false;
  private lastSentAt = 0;
  private lastSentText?: string;
  private lastEventAt = Date.now();
  private progressCount = 0;
  private deliveryUnavailable = false;
  private closed = false;

  constructor(
    private readonly send: (text: string) => Promise<boolean | void>,
    private readonly intervalMs = PROGRESS_SEND_INTERVAL_MS,
    private readonly heartbeatMs = PROGRESS_HEARTBEAT_INTERVAL_MS,
    private readonly maxMessages = MAX_PROGRESS_MESSAGES_PER_TURN
  ) {
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || Date.now() - this.lastEventAt < this.heartbeatMs || this.pending) return;
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - this.lastEventAt) / 1_000));
      this.push(`已持续处理 ${elapsedSeconds} 秒，任务仍在进行中…`, { heartbeat: true });
    }, this.heartbeatMs);
  }

  push(text: string, options: { important?: boolean; heartbeat?: boolean } = {}): void {
    const normalized = normalizeProgressText(text);
    const important = options.important ?? isImportantProgress(normalized);
    const heartbeat = options.heartbeat === true;
    if (this.closed || this.deliveryUnavailable || (!heartbeat && this.progressCount >= this.maxMessages)) return;
    if (!normalized || (!heartbeat && !important && !isMeaningfulProgress(normalized, this.lastSentText, this.pending?.text))) return;
    if (normalized === this.lastSentText || normalized === this.pending?.text) return;
    if (!heartbeat) this.lastEventAt = Date.now();
    this.pending = { text: normalized, important, heartbeat };
    this.schedule();
    this.rescheduleIfNeeded();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.timerDueAt = 0;
    }
    // A heartbeat queued at the exact moment a turn completes is stale; the
    // final answer is the useful update in that case.
    if (this.pending?.heartbeat) this.pending = undefined;
    while (this.pending) {
      this.flushPending();
      await this.sendChain;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.timer = undefined;
    this.timerDueAt = 0;
    this.heartbeatTimer = undefined;
    if (this.pending?.heartbeat) this.pending = undefined;
    while (this.pending) {
      this.flushPending();
      await this.sendChain;
    }
  }

  private schedule(): void {
    if (
      this.timer
      || !this.pending
      || this.closed
      || this.deliveryUnavailable
      || this.sending
      || (!this.pending.heartbeat && this.progressCount >= this.maxMessages)
    ) return;
    const interval = this.pending.important
      ? PROGRESS_IMPORTANT_INTERVAL_MS
      : this.intervalMs;
    const targetAt = this.lastSentAt === 0
      ? Date.now()
      : this.lastSentAt + interval;
    const delay = Math.max(0, targetAt - Date.now());
    this.timerDueAt = targetAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDueAt = 0;
      this.flushPending();
      if (!this.sending) this.schedule();
    }, delay);
  }

  private rescheduleIfNeeded(): void {
    if (
      !this.pending
      || !this.timer
      || this.closed
      || this.deliveryUnavailable
      || this.sending
      || (!this.pending.heartbeat && this.progressCount >= this.maxMessages)
    ) return;
    const interval = this.pending.important
      ? PROGRESS_IMPORTANT_INTERVAL_MS
      : this.intervalMs;
    const targetAt = this.lastSentAt === 0
      ? Date.now()
      : this.lastSentAt + interval;
    if (this.timerDueAt === targetAt) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDueAt = 0;
    this.schedule();
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const text = pending.text;
    if (!pending.heartbeat) this.progressCount += 1;
    this.lastSentAt = Date.now();
    this.lastSentText = text;
    this.sending = true;
    this.sendChain = this.sendChain
      .then(() => this.send(text))
      .then((sent) => {
        if (sent === false) this.deliveryUnavailable = true;
      })
      .catch((error) => {
        console.warn(`WeChat progress reply failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .then(() => {
        this.sending = false;
        if (!this.deliveryUnavailable) this.schedule();
      });
  }
}

function normalizeProgressText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isImportantProgress(text: string): boolean {
  return /^(?:已收到|正在执行命令|正在修改文件|正在调用|正在搜索|正在协调|失败|错误|中断)/u.test(text);
}

function isMeaningfulProgress(text: string, lastSent?: string, pending?: string): boolean {
  if (text.length < 4) return false;
  if (text === lastSent || text === pending) return false;
  if (/[。！？.!?…]$/u.test(text)) return true;
  if (lastSent && text.startsWith(lastSent) && text.length - lastSent.length < 40) return false;
  // A complete sentence or a sufficiently large new snapshot is useful to a
  // human; partial punctuation-only deltas are intentionally held back.
  return !lastSent || text.length >= 40;
}

export class BridgeService {
  private readonly access: AccessController;
  private readonly buffers: PromptBuffer;
  private readonly runner: HybridCodexRunner;

  constructor(private readonly options: BridgeServiceOptions) {
    this.access = new AccessController({
      allowedSenderIds: options.config.allowedSenderIds,
      pairedSenderIds: options.stateStore.listPairedSenderIds()
    });
    this.buffers = new PromptBuffer({
      maxItems: options.config.maxBufferItems,
      ttlMs: options.config.promptBufferTtlMs
    });
    this.runner = options.runner ?? new HybridCodexRunner({
      backend: options.config.codexBackend,
      codexBin: options.config.codexBin,
      execSandbox: options.config.codexExecSandbox,
      timeoutMs: options.config.codexTimeoutMs
    });
  }

  async handleMessage(message: NormalizedWeixinMessage): Promise<void> {
    if (message.contextToken) {
      this.options.stateStore.rememberContextToken(message.senderId, message.contextToken);
    }

    const access = this.access.requireAccess(message.senderId);
    if (!access.allowed) {
      await this.reply(message.senderId, access.message);
      return;
    }
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
    await this.flushPendingDeliveries(message.senderId);
    this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);

    const command = parseCommand(message.text);
    if (command) {
      await this.handleCommand(message, command);
      return;
    }

    const items = await this.promptItemsFromMessageWithNotice(message);
    if (!items) return;

    if (this.buffers.isActive(message.senderId)) {
      for (const item of items) {
        this.buffers.append(message.senderId, item);
      }
      await this.reply(message.senderId, "Buffered. Send /prompt done when ready.");
      return;
    }

    await this.runCodexTurn(message, "", items);
  }

  private async handleCommand(message: NormalizedWeixinMessage, command: { name: string; arg: string }): Promise<void> {
    switch (command.name) {
      case "help":
      case "h":
        await this.reply(message.senderId, helpText());
        return;
      case "status":
      case "where":
        await this.reply(message.senderId, await this.statusText(message.senderId));
        return;
      case "bind":
        await this.bindWorkspace(message.senderId, command.arg);
        return;
      case "new":
        this.options.stateStore.createSession(
          message.senderId,
          this.options.config.sessionWorkspaceRoot ?? this.options.config.defaultCwd
        );
        await this.reply(message.senderId, "Created a new Codex session for the next message.");
        return;
      case "resume":
        await this.handleResumeCommand(message.senderId, command.arg);
        return;
      case "model":
        await this.handleModelCommand(message.senderId, command.arg);
        return;
      case "effort":
        await this.handleEffortCommand(message.senderId, command.arg);
        return;
      case "stream":
        await this.handleStreamCommand(message.senderId, command.arg);
        return;
      case "prompt":
        await this.handlePromptCommand(message.senderId, command.arg);
        return;
      case "stop":
        await this.runner.stop(this.options.stateStore.getThread(message.senderId));
        await this.reply(message.senderId, "Stop signal sent.");
        return;
      default:
        await this.reply(message.senderId, `Unknown command: /${command.name}. Send /help.`);
    }
  }

  private async bindWorkspace(senderId: string, rawPath: string): Promise<void> {
    if (!rawPath.trim()) {
      await this.reply(senderId, "Usage: /bind <absolute-workspace-path>");
      return;
    }
    const workspace = path.resolve(rawPath.trim());
    if (!isWorkspaceAllowed(workspace, this.options.config.allowedWorkspaces)) {
      await this.reply(senderId, `Workspace is not allowed: ${workspace}`);
      return;
    }
    this.options.stateStore.setWorkspace(senderId, workspace);
    await this.reply(senderId, `Bound to workspace:\n${workspace}`);
  }

  private async handleResumeCommand(senderId: string, arg: string): Promise<void> {
    const sessions = this.options.stateStore.listSessions().filter((session) => session.senderId === senderId);
    const input = arg.trim();
    if (!input) {
      const activeId = this.options.stateStore.getActiveSession(senderId)?.id;
      const previews = await Promise.all(sessions.map((session) => this.sessionPromptPreview(session)));
      const lines = ["历史会话（最近更新优先）："];
      for (const [index, session] of sessions.entries()) {
        lines.push(
          `[R${index + 1}] ${session.id === activeId ? "【当前】" : ""}${session.title}`,
          `   最近内容：${previews[index]}（${formatSessionTime(session.updatedAt)}）`
        );
      }
      lines.push("", "发送 /resume R1 这类切换编号继续会话；R1 是切换编号，“会话 6”等是会话名称。");
      for (const chunk of chunkText(lines.join("\n"))) {
        await this.reply(senderId, chunk);
      }
      return;
    }
    if (/^\d+$/.test(input)) {
      await this.reply(senderId, "请使用列表中 R 开头的切换编号，例如 /resume R1；不要使用会话名称里的数字。");
      return;
    }
    const match = /^r([1-9]\d*)$/i.exec(input);
    if (!match) {
      await this.reply(senderId, "用法：/resume 或 /resume R<编号>，例如 /resume R1。");
      return;
    }
    const selected = sessions[Number(match[1]) - 1];
    if (!selected) {
      await this.reply(senderId, "没有这个切换编号。发送 /resume 查看可用的 R 编号。");
      return;
    }
    const preview = await this.sessionPromptPreview(selected);
    this.options.stateStore.activateSession(selected.id);
    await this.reply(senderId, [
      `已通过 ${input.toUpperCase()} 切换到：${selected.title}`,
      `最近内容：${preview}`,
      selected.threadId ? "下一条消息将继续该历史会话。" : "该会话尚无历史内容，下一条消息将创建新上下文。"
    ].join("\n"));
  }

  private async sessionPromptPreview(session: ManagedSession): Promise<string> {
    if (session.lastPromptPreview) return session.lastPromptPreview;
    if (!session.threadId) return "尚未开始对话";
    try {
      const history = await this.runner.getHistory(session.threadId);
      const lastUserMessage = [...history].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) return "暂无内容摘要";
      const parsed = parsePrompt(lastUserMessage.text);
      const preview = buildPromptPreview(parsed.text, parsed.attachments);
      if (!preview) return "暂无内容摘要";
      this.options.stateStore.setSessionPromptPreview(session.id, preview);
      return preview;
    } catch (error) {
      if (isUnavailableCodexThreadError(error)) {
        this.options.stateStore.resetSession(session.id);
      }
      console.warn(`Unable to read Codex history for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return "历史摘要暂不可用";
    }
  }

  private async handlePromptCommand(senderId: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase();
    if (sub === "start") {
      const result = this.buffers.start(senderId);
      await this.reply(senderId, result.status === "started" ? "Prompt buffer started." : "Prompt buffer is already active.");
      return;
    }
    if (sub === "done") {
      const flushed = this.buffers.done(senderId);
      if (flushed.status === "empty") {
        await this.reply(senderId, "Prompt buffer is empty.");
        return;
      }
      await this.runCodexTurn({ id: "buffer", senderId, text: "", attachments: [], raw: {} }, "", flushed.items);
      return;
    }
    await this.reply(senderId, "Usage: /prompt start or /prompt done");
  }

  private async handleModelCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const input = arg.trim();
    if (!input) {
      const runtime = await this.effectiveRuntime(senderId);
      const session = this.options.stateStore.getActiveSession(senderId);
      const lines = [
        `当前模型：${runtime.model ?? "Codex 默认"}${session?.model ? "（本会话）" : "（继承 Web/Codex 设置）"}`
      ];
      if (models.length) {
        lines.push("", "可用模型：", ...models.map((model, index) => `${index + 1}. ${model.displayName}（${model.model}）`));
        lines.push("", "发送 /model <序号或模型 ID> 切换；/model default 恢复继承设置。");
      } else {
        lines.push("", "暂时无法读取模型列表。仍可发送 /model <完整模型 ID> 切换。", "/model default 恢复继承设置。");
      }
      await this.reply(senderId, lines.join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setModelOverride(senderId);
      const runtime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 模型设置。\n当前模型：${runtime.model ?? "Codex 默认"}`);
      return;
    }

    const selected = selectModel(models, input);
    if (!selected && (models.length || !isPlausibleModelId(input))) {
      await this.reply(senderId, "模型不存在。发送 /model 查看可用模型，或使用 /model default 恢复继承设置。");
      return;
    }
    const currentRuntime = await this.effectiveRuntime(senderId);
    const model = selected?.model ?? input;
    this.options.stateStore.setModelOverride(senderId, model);
    let adjustedEffort: string | undefined;
    if (currentRuntime.effort && selected?.supportedEfforts.length && !selected.supportedEfforts.some((option) => option.effort === currentRuntime.effort)) {
      adjustedEffort = selected.supportedEfforts.some((option) => option.effort === selected.defaultEffort)
        ? selected.defaultEffort
        : selected.supportedEfforts[0]?.effort;
      this.options.stateStore.setEffortOverride(senderId, adjustedEffort);
    }
    await this.reply(senderId, [
      `本会话模型已切换为：${selected?.displayName ?? model}（${model}）`,
      ...(adjustedEffort ? [`原来的推理强度不受该模型支持，已自动调整为：${formatEffort(adjustedEffort)}`] : []),
      "下一条消息开始生效。"
    ].join("\n"));
  }

  private async handleEffortCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const runtime = await this.effectiveRuntime(senderId);
    const model = models.find((option) => option.model === runtime.model);
    const efforts = availableEfforts(model, models);
    const input = arg.trim();
    if (!input) {
      const session = this.options.stateStore.getActiveSession(senderId);
      await this.reply(senderId, [
        `当前推理强度：${formatEffort(runtime.effort)}${session?.effort ? "（本会话）" : "（继承 Web/Codex 设置）"}`,
        `当前模型：${runtime.model ?? "Codex 默认"}`,
        "",
        "可用推理强度：",
        ...efforts.map((effort, index) => `${index + 1}. ${formatEffort(effort)}`),
        "",
        "发送 /effort <序号或英文值> 切换；/effort default 恢复继承设置。"
      ].join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setEffortOverride(senderId);
      const nextRuntime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 推理强度设置。\n当前推理强度：${formatEffort(nextRuntime.effort)}`);
      return;
    }
    const effort = selectEffort(efforts, input);
    if (!effort) {
      await this.reply(senderId, "该模型不支持这个推理强度。发送 /effort 查看可用选项。");
      return;
    }
    this.options.stateStore.setEffortOverride(senderId, effort);
    await this.reply(senderId, `本会话推理强度已切换为：${formatEffort(effort)}\n下一条消息开始生效。`);
  }

  private async handleStreamCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim().toLowerCase();
    const session = this.options.stateStore.getActiveSession(senderId);
    const inherited = this.options.config.streamReplies;
    if (!input) {
      const effective = session?.streamReplies ?? inherited;
      const source = typeof session?.streamReplies === "boolean" ? "本会话设置" : "继承全局";
      await this.reply(senderId, `当前过程进度：${effective ? "开启" : "关闭"}（${source}）\n发送 /stream on、/stream off 或 /stream default 切换。`);
      return;
    }
    if (input === "default") {
      this.options.stateStore.setStreamRepliesOverride(senderId);
      await this.reply(senderId, `已恢复继承全局设置。当前过程进度：${inherited ? "开启" : "关闭"}。`);
      return;
    }
    if (input !== "on" && input !== "off") {
      await this.reply(senderId, "用法：/stream on、/stream off 或 /stream default");
      return;
    }
    const enabled = input === "on";
    this.options.stateStore.setStreamRepliesOverride(senderId, enabled);
    await this.reply(senderId, `本会话过程进度已${enabled ? "开启" : "关闭"}。`);
  }

  private async promptItemsFromMessage(message: NormalizedWeixinMessage): Promise<PromptBufferItem[]> {
    const items: PromptBufferItem[] = [];
    if (message.text.trim()) {
      items.push({ kind: "text", text: message.text });
    }
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      return items;
    }
    try {
      const downloaded = await downloadInboundAttachments({
        rootDir: this.options.inboundDir ?? path.join(this.options.config.defaultCwd, ".codex-weixin-inbound"),
        senderId: message.senderId,
        messageId: message.id,
        attachments,
        maxBytes: this.options.config.maxInboundBytes,
        fetch: this.options.mediaFetch
      });
      for (const attachment of downloaded) {
        items.push({
          kind: attachment.kind,
          path: attachment.path,
          label: attachment.label
        });
      }
    } catch (error) {
      if (error instanceof InboundMediaTooLargeError) throw error;
      items.push({
        kind: "text",
        text: `[WeChat attachment download failed: ${error instanceof Error ? error.message : String(error)}]`
      });
    }
    return items;
  }

  private async promptItemsFromMessageWithNotice(message: NormalizedWeixinMessage): Promise<PromptBufferItem[] | undefined> {
    try {
      return await this.promptItemsFromMessage(message);
    } catch (error) {
      if (!(error instanceof InboundMediaTooLargeError)) throw error;
      const maxMiB = Math.floor(error.maxBytes / (1024 * 1024));
      await this.reply(message.senderId, `附件超过 ${maxMiB} MiB 上限，请压缩或裁剪后重新发送。`);
      return undefined;
    }
  }

  private async runCodexTurn(message: NormalizedWeixinMessage, text: string, attachments: PromptBufferItem[] = []): Promise<void> {
    const session = this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);
    const promptPreview = buildPromptPreview(text, attachments);
    if (promptPreview) {
      this.options.stateStore.setSessionPromptPreview(session.id, promptPreview);
    }
    const workspace = this.options.stateStore.getWorkspace(message.senderId) ?? this.options.config.defaultCwd;
    const threadId = this.options.stateStore.getThread(message.senderId) || undefined;
    const progressEnabled = session.streamReplies ?? this.options.config.streamReplies;
    const sentProgress = new Set<string>();
    const progressNotifier = progressEnabled
      ? new ProgressNotifier(async (progress) => {
        return this.reply(message.senderId, `【进度】${progress}`, { durable: false });
      })
      : undefined;
    this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: true });
    try {
      await this.withTyping(message.senderId, async () => {
        console.log(`[codex-weixin] starting Codex turn for ${message.senderId} in ${workspace}`);
        const result = await this.runner.run({
          prompt: buildPrompt(text, attachments),
          cwd: workspace,
          threadId,
          model: session.model ?? this.options.config.model,
          effort: session.effort ?? this.options.config.effort,
          ...(progressEnabled ? {
            onProgress: (progress: string) => {
              const progressText = progress.trim();
              if (!progressText || sentProgress.has(progressText)) return;
              sentProgress.add(progressText);
              progressNotifier?.push(progressText);
            }
          } : {})
        });
        console.log(`[codex-weixin] Codex turn completed for ${message.senderId}; text=${result.text.length} chars`);
        await progressNotifier?.flush();
        if (result.threadId) {
          this.options.stateStore.setThread(message.senderId, result.threadId);
        }
        this.options.stateStore.recordTokenUsage(session.id, result.usage, result.threadId);
        const parsed = parseActionBlocks(result.text);
        const remaining = chunkText(parsed.visibleText);
        if (remaining.length) {
          for (const chunk of remaining) {
            await this.reply(message.senderId, chunk, { durable: true });
          }
        }
        for (const action of parsed.actions.send) {
          await this.sendLocalMedia(message.senderId, action);
        }
      });
    } finally {
      await progressNotifier?.close();
      this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: false });
    }
  }

  private async sendLocalMedia(senderId: string, action: { type: "image" | "file" | "video"; path: string }): Promise<void> {
    try {
      await sendLocalMediaFile({
        client: this.options.weixin,
        toUserId: senderId,
        contextToken: this.options.stateStore.getContextToken(senderId),
        filePath: action.path,
        kind: action.type
      });
    } catch (error) {
      await this.reply(senderId, `[codex-weixin] Failed to send ${action.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withTyping(senderId: string, run: () => Promise<void>): Promise<void> {
    const sendTyping = async (typing: boolean) => {
      try {
        await this.options.weixin.sendTyping({
          toUserId: senderId,
          contextToken: this.options.stateStore.getContextToken(senderId),
          typing
        });
      } catch (error) {
        console.warn(`WeChat typing indicator failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    // Do not make the first visible progress wait for the typing API. The
    // indicator is best-effort and can be established while Codex starts.
    void sendTyping(true);
    const timer = setInterval(() => {
      void sendTyping(true);
    }, 5_000);
    try {
      await run();
    } finally {
      clearInterval(timer);
      await sendTyping(false);
    }
  }

  private async statusText(senderId: string): Promise<string> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    const runtime = await this.effectiveRuntime(senderId);
    return [
      "codex-weixin status",
      `sender: ${senderId}`,
      `session: ${session?.title ?? "(new)"}`,
      `workspace: ${workspace}`,
      `thread: ${session?.threadId || "(new)"}`,
      `backend: ${this.options.config.codexBackend}`,
      `sandbox: ${this.options.config.codexExecSandbox ?? "(Codex default)"}`,
      `model: ${runtime.model ?? "(Codex default)"}`,
      `effort: ${runtime.effort ?? "(Codex default)"}`,
      `stream replies: ${(session?.streamReplies ?? this.options.config.streamReplies) ? "on" : "off"}${typeof session?.streamReplies === "boolean" ? " (session)" : " (global)"}`
    ].join("\n");
  }

  private async listCodexModels(): Promise<CodexModelOption[]> {
    try {
      return await (this.options.listCodexModels?.() ?? this.runner.listModels());
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async effectiveRuntime(senderId: string): Promise<CodexRuntimeInfo> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    let runtime: CodexRuntimeInfo = {};
    try {
      runtime = await this.runner.getRuntimeInfo(workspace, session?.threadId);
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      model: session?.model ?? this.options.config.model ?? runtime.model,
      effort: session?.effort ?? this.options.config.effort ?? runtime.effort,
      provider: runtime.provider
    };
  }

  private async flushPendingDeliveries(senderId: string): Promise<void> {
    for (const delivery of this.options.stateStore.listPendingDeliveries(senderId)) {
      try {
        const sent = await this.reply(senderId, delivery.text, { durable: false });
        if (!sent) return;
        this.options.stateStore.removePendingDelivery(delivery.id);
      } catch (error) {
        console.warn(`Pending WeChat delivery failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }

  private async reply(senderId: string, text: string, options: { durable?: boolean } = {}): Promise<boolean> {
    const contextToken = this.options.stateStore.getContextToken(senderId);
    try {
      console.log(`[codex-weixin] sending reply to ${senderId}; text=${text.length} chars`);
      await this.options.weixin.sendText({ toUserId: senderId, text, contextToken });
      console.log(`[codex-weixin] sent reply to ${senderId}`);
      return true;
    } catch (error) {
      if (isStaleContextError(error)) {
        if (options.durable) {
          this.options.stateStore.enqueuePendingDelivery(senderId, text);
        }
        console.warn(`WeChat context token is stale for ${senderId}; queued the reply until the next user message.`);
        return false;
      }
      if (options.durable) {
        this.options.stateStore.enqueuePendingDelivery(senderId, text);
      }
      throw error;
    }
  }

  allowSender(senderId: string): void {
    this.access.allow(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  removeSender(senderId: string): void {
    this.access.remove(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  listAllowedSenders(): string[] {
    return this.access.listPairedSenderIds();
  }
}

function parseCommand(text: string): { name: string; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), arg: rest.join(" ") };
}

function helpText(): string {
  return [
    "codex-weixin commands:",
    "/help - show commands",
    "/status - show current binding",
    "/bind <absolute-path> - bind this chat to a workspace",
    "/new - create a new managed Codex session",
    "/resume [R-number] - list or switch historical sessions",
    "/model [number|model-id|default] - view or switch this session's model",
    "/effort [number|level|default] - view or switch reasoning effort",
    "/stream [on|off|default] - view or switch streaming replies",
    "/prompt start - buffer multiple WeChat messages",
    "/prompt done - submit buffered prompt",
    "/stop - interrupt the current Codex task"
  ].join("\n");
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fallbackEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function selectModel(models: CodexModelOption[], input: string): CodexModelOption | undefined {
  if (/^\d+$/.test(input)) {
    return models[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return models.find((model) => model.model.toLowerCase() === normalized);
}

function isPlausibleModelId(input: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(input);
}

function availableEfforts(model: CodexModelOption | undefined, models: CodexModelOption[]): string[] {
  const advertised = model?.supportedEfforts.length
    ? model.supportedEfforts.map((option) => option.effort)
    : models.flatMap((option) => option.supportedEfforts.map((effort) => effort.effort));
  return advertised.length ? [...new Set(advertised)] : fallbackEfforts;
}

function selectEffort(efforts: string[], input: string): string | undefined {
  if (/^\d+$/.test(input)) {
    return efforts[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return efforts.find((effort) => effort.toLowerCase() === normalized);
}

function formatEffort(effort?: string): string {
  if (!effort) return "Codex 默认";
  const labels: Record<string, string> = {
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
    ultra: "极高"
  };
  return labels[effort] ? `${labels[effort]}（${effort}）` : effort;
}
