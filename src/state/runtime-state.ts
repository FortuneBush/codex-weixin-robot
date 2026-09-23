import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

export type SessionTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  turnCount: number;
  lastUsedAt: string;
};

export type SessionTokenUsageRecord = {
  at: string;
  threadId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
};

export type ManagedSession = {
  id: string;
  senderId: string;
  title: string;
  workspace: string;
  threadId?: string;
  lastPromptPreview?: string;
  model?: string;
  effort?: string;
  streamReplies?: boolean;
  tokenUsage?: SessionTokenUsage;
  tokenUsageRecords?: SessionTokenUsageRecord[];
  createdAt: string;
  updatedAt: string;
};

export type SessionRuntimeOverrides = {
  model?: string | null;
  effort?: string | null;
  streamReplies?: boolean | null;
};

export type RuntimeState = {
  pairedSenderIds: string[];
  lastActiveSenderId?: string;
  syncKey?: string;
  processedMessageIds: string[];
  contextTokens: Record<string, string>;
  sessions: ManagedSession[];
  activeSessionIds: Record<string, string>;
  pendingDeliveries: Array<{
    id: string;
    senderId: string;
    text: string;
    createdAt: string;
  }>;
};

export function emptyRuntimeState(): RuntimeState {
  return {
    pairedSenderIds: [],
    processedMessageIds: [],
    contextTokens: {},
    sessions: [],
    activeSessionIds: {},
    pendingDeliveries: []
  };
}

export class RuntimeStateStore {
  private state: RuntimeState;

  constructor(private readonly paths: StatePaths, private readonly workspaceRoot?: string) {
    this.state = normalizeRuntimeState(readJsonFile<Partial<RuntimeState>>(paths.statePath, {}));
    this.migrateSessionWorkspaces();
  }

  get snapshot(): RuntimeState {
    return structuredClone(this.state);
  }

  save(): void {
    writeJsonFile(this.paths.statePath, this.state);
  }

  listPairedSenderIds(): string[] {
    return [...new Set(this.state.pairedSenderIds)].sort();
  }

  setPairedSenderIds(senderIds: string[]): void {
    this.state.pairedSenderIds = [...new Set(senderIds)].sort();
    this.save();
  }

  rememberContextToken(senderId: string, token: string): void {
    this.state.contextTokens[senderId] = token;
    this.state.lastActiveSenderId = senderId;
    this.save();
  }

  getContextToken(senderId: string): string | undefined {
    return this.state.contextTokens[senderId];
  }

  listPendingDeliveries(senderId: string): Array<{ id: string; senderId: string; text: string; createdAt: string }> {
    return this.state.pendingDeliveries
      .filter((delivery) => delivery.senderId === senderId)
      .map((delivery) => ({ ...delivery }));
  }

  enqueuePendingDelivery(senderId: string, text: string): void {
    const normalized = text.trim();
    if (!normalized) return;
    this.state.pendingDeliveries = [
      ...this.state.pendingDeliveries,
      { id: crypto.randomUUID(), senderId, text: normalized, createdAt: new Date().toISOString() }
    ].slice(-200);
    this.save();
  }

  removePendingDelivery(deliveryId: string): void {
    const next = this.state.pendingDeliveries.filter((delivery) => delivery.id !== deliveryId);
    if (next.length === this.state.pendingDeliveries.length) return;
    this.state.pendingDeliveries = next;
    this.save();
  }

  getLastActiveSenderId(): string | undefined {
    return this.state.lastActiveSenderId;
  }

  getSyncKey(): string | undefined {
    return this.state.syncKey;
  }

  setSyncKey(syncKey: string): void {
    if (!syncKey || this.state.syncKey === syncKey) {
      return;
    }
    this.state.syncKey = syncKey;
    this.save();
  }

  claimProcessedMessage(messageId: string): boolean {
    const id = messageId.trim();
    if (!id || this.state.processedMessageIds.includes(id)) {
      return false;
    }
    this.state.processedMessageIds.push(id);
    this.state.processedMessageIds = this.state.processedMessageIds.slice(-1_000);
    this.save();
    return true;
  }

  setWorkspace(senderId: string, workspace: string): void {
    this.ensureActiveSession(senderId, workspace);
    const session = this.mutableActiveSession(senderId)!;
    session.workspace = this.workspaceRoot
      ? this.sessionWorkspacePath(session.id)
      : path.resolve(workspace);
    delete session.threadId;
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  getWorkspace(senderId: string): string | undefined {
    return this.getActiveSession(senderId)?.workspace;
  }

  setThread(senderId: string, threadId: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (threadId) {
      session.threadId = threadId;
    } else {
      delete session.threadId;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  getThread(senderId: string): string | undefined {
    return this.getActiveSession(senderId)?.threadId;
  }

  setModelOverride(senderId: string, model?: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (model?.trim()) {
      session.model = model.trim();
    } else {
      delete session.model;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  setEffortOverride(senderId: string, effort?: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (effort?.trim()) {
      session.effort = effort.trim();
    } else {
      delete session.effort;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  setStreamRepliesOverride(senderId: string, streamReplies?: boolean): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (typeof streamReplies === "boolean") {
      session.streamReplies = streamReplies;
    } else {
      delete session.streamReplies;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  listSessions(): ManagedSession[] {
    return structuredClone(this.state.sessions)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(sessionId: string): ManagedSession | undefined {
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId);
    return session ? structuredClone(session) : undefined;
  }

  getActiveSession(senderId: string): ManagedSession | undefined {
    const sessionId = this.state.activeSessionIds[senderId];
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId && candidate.senderId === senderId);
    return session ? structuredClone(session) : undefined;
  }

  ensureActiveSession(senderId: string, workspace: string): ManagedSession {
    const active = this.mutableActiveSession(senderId);
    if (active) {
      return structuredClone(active);
    }
    return this.createSession(senderId, workspace);
  }

  createSession(senderId: string, workspace: string, title?: string): ManagedSession {
    const now = new Date().toISOString();
    const number = this.state.sessions.filter((session) => session.senderId === senderId).length + 1;
    const id = crypto.randomUUID();
    const session: ManagedSession = {
      id,
      senderId,
      title: cleanTitle(title) ?? `会话 ${number}`,
      workspace: this.workspaceRoot ? this.sessionWorkspacePath(id) : path.resolve(workspace),
      createdAt: now,
      updatedAt: now
    };
    this.state.sessions.push(session);
    this.state.activeSessionIds[senderId] = session.id;
    this.save();
    return structuredClone(session);
  }

  private sessionWorkspacePath(sessionId: string): string {
    const workspace = path.join(path.resolve(this.workspaceRoot!), sessionId);
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  private migrateSessionWorkspaces(): void {
    if (!this.workspaceRoot) return;
    let changed = false;
    for (const session of this.state.sessions) {
      const workspace = this.sessionWorkspacePath(session.id);
      if (session.workspace !== workspace) {
        session.workspace = workspace;
        session.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.save();
  }

  setSessionPromptPreview(sessionId: string, preview: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    const normalized = cleanPromptPreview(preview);
    if (normalized) session.lastPromptPreview = normalized;
    else delete session.lastPromptPreview;
    this.save();
    return structuredClone(session);
  }

  renameSession(sessionId: string, title: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    const nextTitle = cleanTitle(title);
    if (!nextTitle) {
      throw new Error("Session title cannot be empty");
    }
    session.title = nextTitle;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  activateSession(sessionId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    this.state.activeSessionIds[session.senderId] = session.id;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  resetSession(sessionId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    delete session.threadId;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  setSessionThread(sessionId: string, threadId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (threadId) {
      session.threadId = threadId;
    } else {
      delete session.threadId;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  recordTokenUsage(sessionId: string, usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
  } | undefined, threadId?: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (!usage) return structuredClone(session);
    const at = new Date().toISOString();
    const previous = session.tokenUsage;
    session.tokenUsage = {
      inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
      cachedInputTokens: (previous?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
      turnCount: (previous?.turnCount ?? 0) + 1,
      lastUsedAt: at
    };
    session.tokenUsageRecords = [
      ...(session.tokenUsageRecords ?? []),
      { at, ...(threadId ? { threadId } : {}), ...usage }
    ].slice(-1_000);
    session.updatedAt = at;
    this.save();
    return structuredClone(session);
  }

  updateSessionRuntime(sessionId: string, overrides: SessionRuntimeOverrides): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (Object.hasOwn(overrides, "model")) {
      const model = overrides.model?.trim();
      if (model) session.model = model;
      else delete session.model;
    }
    if (Object.hasOwn(overrides, "effort")) {
      const effort = overrides.effort?.trim();
      if (effort) session.effort = effort;
      else delete session.effort;
    }
    if (Object.hasOwn(overrides, "streamReplies")) {
      if (typeof overrides.streamReplies === "boolean") session.streamReplies = overrides.streamReplies;
      else delete session.streamReplies;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  deleteSession(sessionId: string): void {
    const session = this.mutableSession(sessionId);
    this.state.sessions = this.state.sessions.filter((candidate) => candidate.id !== sessionId);
    if (this.state.activeSessionIds[session.senderId] === sessionId) {
      const fallback = this.state.sessions
        .filter((candidate) => candidate.senderId === session.senderId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (fallback) {
        this.state.activeSessionIds[session.senderId] = fallback.id;
      } else {
        delete this.state.activeSessionIds[session.senderId];
      }
    }
    this.save();
  }

  private mutableSession(sessionId: string): ManagedSession {
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new Error(`Managed session not found: ${sessionId}`);
    }
    return session;
  }

  private mutableActiveSession(senderId: string): ManagedSession | undefined {
    const sessionId = this.state.activeSessionIds[senderId];
    return this.state.sessions.find((candidate) => candidate.id === sessionId && candidate.senderId === senderId);
  }
}

function normalizeRuntimeState(value: Partial<RuntimeState>): RuntimeState {
  return {
    ...emptyRuntimeState(),
    ...value,
    pairedSenderIds: Array.isArray(value.pairedSenderIds) ? value.pairedSenderIds : [],
    processedMessageIds: Array.isArray(value.processedMessageIds)
      ? value.processedMessageIds.filter((id): id is string => typeof id === "string").slice(-1_000)
      : [],
    contextTokens: value.contextTokens && typeof value.contextTokens === "object" ? value.contextTokens : {},
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
    activeSessionIds: value.activeSessionIds && typeof value.activeSessionIds === "object" ? value.activeSessionIds : {},
    pendingDeliveries: normalizePendingDeliveries(value.pendingDeliveries)
  };
}

function normalizePendingDeliveries(value: unknown): RuntimeState["pendingDeliveries"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const delivery = candidate as Record<string, unknown>;
    if (
      typeof delivery.id !== "string"
      || typeof delivery.senderId !== "string"
      || typeof delivery.text !== "string"
      || typeof delivery.createdAt !== "string"
      || !delivery.senderId.trim()
      || !delivery.text.trim()
    ) {
      return [];
    }
    return [{
      id: delivery.id,
      senderId: delivery.senderId,
      text: delivery.text,
      createdAt: delivery.createdAt
    }];
  }).slice(-200);
}

function cleanTitle(value?: string): string | undefined {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 80);
  return clean || undefined;
}

function cleanPromptPreview(value?: string): string | undefined {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 120);
  return clean || undefined;
}
