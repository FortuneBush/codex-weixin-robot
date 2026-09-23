import { WeixinApiClient } from "./api.js";
import { normalizeWeixinMessage, type NormalizedWeixinMessage, type WeixinRawMessage } from "./messages.js";

export type MonitorOptions = {
  client: WeixinApiClient;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxPollRetryMs?: number;
  initialSyncKey?: string;
  onSyncKey?: (syncKey: string) => Promise<void> | void;
  claimMessage?: (message: NormalizedWeixinMessage) => boolean;
  onMessage: (message: NormalizedWeixinMessage) => Promise<void>;
  onMessageError?: (error: unknown, message: NormalizedWeixinMessage) => Promise<void> | void;
};

const ATTACHMENT_PAIR_WINDOW_MS = 2_000;

export class PollRetryBackoff {
  private readonly initialMs: number;
  private readonly maxMs: number;
  private currentMs: number;

  constructor(initialMs: number, maxMs: number) {
    this.initialMs = Math.max(0, initialMs);
    this.maxMs = Math.max(this.initialMs, maxMs);
    this.currentMs = this.initialMs;
  }

  next(): number {
    const delayMs = this.currentMs;
    this.currentMs = Math.min(this.maxMs, this.currentMs === 0 ? 0 : this.currentMs * 2);
    return delayMs;
  }

  reset(): void {
    this.currentMs = this.initialMs;
  }
}

export async function monitorWeixin(options: MonitorOptions): Promise<void> {
  let syncKey = options.initialSyncKey;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const retryBackoff = new PollRetryBackoff(pollIntervalMs, options.maxPollRetryMs ?? 30_000);
  const pendingPairs = new Map<string, { message: NormalizedWeixinMessage; timer: NodeJS.Timeout }>();
  const activeHandlers = new Set<Promise<void>>();
  const senderChains = new Map<string, Promise<void>>();

  const reportError = async (error: unknown, message: NormalizedWeixinMessage): Promise<void> => {
    console.error(`[codex-weixin] message handling failed for ${message.senderId}: ${errorDetail(error)}`);
    try {
      await options.onMessageError?.(error, message);
    } catch (reportError) {
      console.error(`[codex-weixin] failed to report message error for ${message.senderId}: ${errorDetail(reportError)}`);
    }
  };

  const dispatch = (message: NormalizedWeixinMessage): void => {
    const previous = senderChains.get(message.senderId) ?? Promise.resolve();
    let task: Promise<void>;
    task = previous
      .catch(() => {})
      .then(async () => {
        console.log(`[codex-weixin] handling message ${message.id} from ${message.senderId}`);
        await options.onMessage(message);
        console.log(`[codex-weixin] handled message ${message.id} from ${message.senderId}`);
      })
      .catch((error) => reportError(error, message))
      .finally(() => {
        activeHandlers.delete(task);
        if (senderChains.get(message.senderId) === task) {
          senderChains.delete(message.senderId);
        }
      });
    senderChains.set(message.senderId, task);
    activeHandlers.add(task);
  };

  const flushPending = (senderId: string): void => {
    const pending = pendingPairs.get(senderId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPairs.delete(senderId);
    dispatch(pending.message);
  };

  const queueMessage = (message: NormalizedWeixinMessage): void => {
    const previous = pendingPairs.get(message.senderId);
    if (previous && canPairAttachmentMessage(previous.message, message)) {
      clearTimeout(previous.timer);
      pendingPairs.delete(message.senderId);
      dispatch(mergeAttachmentMessages(previous.message, message));
      return;
    }
    if (previous) flushPending(message.senderId);
    if (!shouldWaitForAttachment(message)) {
      dispatch(message);
      return;
    }
    const timer = setTimeout(() => flushPending(message.senderId), ATTACHMENT_PAIR_WINDOW_MS);
    pendingPairs.set(message.senderId, { message, timer });
  };

  while (!options.signal?.aborted) {
    let batch: { syncKey?: string; messages: WeixinRawMessage[] };
    try {
      batch = parseUpdateBatch(await options.client.getUpdates(syncKey, options.signal));
      if (batch.syncKey && batch.syncKey !== syncKey) {
        syncKey = batch.syncKey;
        await options.onSyncKey?.(syncKey);
      }
    } catch (error) {
      const retryMs = retryBackoff.next();
      console.error(`[codex-weixin] monitor poll failed; retrying in ${retryMs}ms: ${errorDetail(error)}`);
      await delay(retryMs, options.signal);
      continue;
    }
    retryBackoff.reset();
    const { messages } = batch;
    if (messages.length) {
      console.log(`[codex-weixin] received ${messages.length} update(s)`);
    }
    const normalizedMessages: NormalizedWeixinMessage[] = [];
    for (const raw of messages) {
      let normalized: NormalizedWeixinMessage | undefined;
      try {
        normalized = normalizeWeixinMessage(raw);
      } catch (error) {
        console.error(`[codex-weixin] failed to normalize message: ${errorDetail(error)}`);
        continue;
      }
      if (!normalized) {
        continue;
      }
      if (options.claimMessage && !options.claimMessage(normalized)) {
        console.log(`[codex-weixin] skipped duplicate message ${normalized.id} from ${normalized.senderId}`);
        continue;
      }
      normalizedMessages.push(normalized);
    }

    // WeChat commonly delivers a file and the user's instruction as separate
    // nearby messages. Treat that pair as one prompt so the attachment and
    // instruction do not start separate long-running turns.
    for (const normalized of mergeAttachmentFollowUps(normalizedMessages)) queueMessage(normalized);
    if (!messages.length) {
      await delay(pollIntervalMs, options.signal);
    }
  }

  for (const senderId of pendingPairs.keys()) flushPending(senderId);
  await Promise.allSettled(activeHandlers);
}

function mergeAttachmentFollowUps(messages: NormalizedWeixinMessage[]): NormalizedWeixinMessage[] {
  const merged: NormalizedWeixinMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (
      previous
      && previous.senderId === message.senderId
      && canPairAttachmentMessage(previous, message)
    ) {
      merged[merged.length - 1] = mergeAttachmentMessages(previous, message);
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function canPairAttachmentMessage(first: NormalizedWeixinMessage, second: NormalizedWeixinMessage): boolean {
  return first.senderId === second.senderId
    && ((first.attachments.length > 0 && !first.text.trim() && second.attachments.length === 0 && Boolean(second.text.trim()))
      || (second.attachments.length > 0 && !second.text.trim() && first.attachments.length === 0 && Boolean(first.text.trim())));
}

function mergeAttachmentMessages(first: NormalizedWeixinMessage, second: NormalizedWeixinMessage): NormalizedWeixinMessage {
  const attachmentMessage = first.attachments.length > 0 ? first : second;
  const textMessage = first.attachments.length > 0 ? second : first;
  return {
    ...attachmentMessage,
    contextToken: second.contextToken ?? first.contextToken,
    text: textMessage.text.trim(),
    raw: textMessage.raw
  };
}

function shouldWaitForAttachment(message: NormalizedWeixinMessage): boolean {
  if (message.attachments.length > 0) return !message.text.trim();
  const text = message.text.trim();
  if (!text || text.startsWith("/")) return false;
  return /(?:pdf|文件|附件|文章|论文|截图|图片|报告|文档|paper|article|document|file|screenshot)/iu.test(text);
}

function parseUpdateBatch(value: unknown): { syncKey?: string; messages: WeixinRawMessage[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("getUpdates response must be an object");
  }
  const response = value as Record<string, unknown>;
  const messages = response.msgs ?? response.message_list ?? response.messages ?? [];
  if (!Array.isArray(messages)) {
    throw new Error("getUpdates response messages must be an array");
  }
  const syncKey = [response.get_updates_buf, response.next_sync_key, response.sync_key]
    .find((candidate): candidate is string => typeof candidate === "string");
  return { syncKey, messages: messages as WeixinRawMessage[] };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
