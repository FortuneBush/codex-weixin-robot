import os from "node:os";
import path from "node:path";

import { parseCodexExecSandbox, type CodexExecSandbox } from "../codex/sandbox.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

export const MAX_INBOUND_BYTES = 100 * 1024 * 1024;
export const DEFAULT_CODEX_TIMEOUT_MS = 30 * 60_000;
const MIN_CODEX_TIMEOUT_MS = 60_000;
const MAX_CODEX_TIMEOUT_MS = 24 * 60 * 60_000;
const LEGACY_DEFAULT_INBOUND_BYTES = 50 * 1024 * 1024;

export type CodexWeixinConfig = {
  defaultCwd: string;
  allowedSenderIds: string[];
  allowedWorkspaces: string[];
  codexBin: string;
  codexBackend: "auto" | "app-server" | "exec";
  codexExecSandbox?: CodexExecSandbox;
  /** null disables the Codex turn timeout. */
  codexTimeoutMs: number | null;
  sessionWorkspaceRoot?: string;
  model?: string;
  effort?: string;
  streamReplies: boolean;
  maxBufferItems: number;
  promptBufferTtlMs: number;
  maxInboundBytes: number;
};

export function defaultConfig(cwd = path.join(os.homedir(), ".codex-weixin")): CodexWeixinConfig {
  return {
    defaultCwd: path.resolve(cwd),
    allowedSenderIds: [],
    allowedWorkspaces: [path.resolve(cwd)],
    codexBin: "codex",
    codexBackend: "auto",
    codexTimeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
    streamReplies: true,
    maxBufferItems: 50,
    promptBufferTtlMs: 10 * 60_000,
    maxInboundBytes: MAX_INBOUND_BYTES
  };
}

export function loadConfig(paths: StatePaths, cwd?: string): CodexWeixinConfig {
  const base = cwd ? defaultConfig(cwd) : defaultConfig();
  const loaded = readJsonFile<Partial<CodexWeixinConfig>>(paths.configPath, {});
  const codexExecSandbox = parseCodexExecSandbox(loaded.codexExecSandbox);
  return {
    ...base,
    ...loaded,
    codexExecSandbox,
    codexTimeoutMs: normalizeCodexTimeout(loaded.codexTimeoutMs, base.codexTimeoutMs),
    streamReplies: typeof loaded.streamReplies === "boolean" ? loaded.streamReplies : base.streamReplies,
    maxInboundBytes: normalizeInboundBytes(loaded.maxInboundBytes, base.maxInboundBytes),
    allowedSenderIds: loaded.allowedSenderIds ?? base.allowedSenderIds,
    allowedWorkspaces: (loaded.allowedWorkspaces?.length ? loaded.allowedWorkspaces : base.allowedWorkspaces)
      .map((workspace) => path.resolve(workspace))
  };
}

function normalizeCodexTimeout(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_CODEX_TIMEOUT_MS, Math.max(MIN_CODEX_TIMEOUT_MS, Math.floor(value)));
}

export function saveConfig(paths: StatePaths, config: CodexWeixinConfig): void {
  writeJsonFile(paths.configPath, {
    ...config,
    maxInboundBytes: normalizeInboundBytes(config.maxInboundBytes, MAX_INBOUND_BYTES)
  });
}

function normalizeInboundBytes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const bytes = Math.floor(value);
  if (bytes === LEGACY_DEFAULT_INBOUND_BYTES) return MAX_INBOUND_BYTES;
  return Math.min(bytes, MAX_INBOUND_BYTES);
}

export function isWorkspaceAllowed(workspace: string, allowedWorkspaces: string[]): boolean {
  const resolved = path.resolve(workspace);
  return allowedWorkspaces.some((allowed) => {
    const root = path.resolve(allowed);
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
