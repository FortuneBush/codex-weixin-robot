import crypto from "node:crypto";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type WeixinApiClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  /** Maximum time allowed for one API request. Set to 0 to disable. */
  requestTimeoutMs?: number;
};

export class WeixinApiError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly ret?: number,
    public readonly errcode?: number
  ) {
    super(message);
    this.name = "WeixinApiError";
  }
}

export class WeixinApiTimeoutError extends WeixinApiError {
  constructor(endpoint: string, public readonly timeoutMs: number) {
    super(`${shortEndpoint(endpoint)} timed out after ${timeoutMs} ms`, shortEndpoint(endpoint));
    this.name = "WeixinApiTimeoutError";
  }
}

export function isStaleContextError(error: unknown): boolean {
  return error instanceof WeixinApiError && error.endpoint === "sendmessage" && error.ret === -2;
}

export class WeixinApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: WeixinApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(0, options.requestTimeoutMs ?? 0)
      : 30_000;
  }

  async getUpdates(syncKey?: string, signal?: AbortSignal): Promise<unknown> {
    return this.post("ilink/bot/getupdates", {
      get_updates_buf: syncKey ?? "",
      base_info: { channel_version: "0.1.0" }
    }, signal);
  }

  async sendText(input: {
    toUserId: string;
    text: string;
    contextToken?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string }> {
    const clientId = crypto.randomUUID();
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: input.toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
        item_list: [{ type: 1, text_item: { text: input.text } }]
      },
      base_info: { channel_version: "0.1.0" }
    };
    const response = await this.post("ilink/bot/sendmessage", body, input.signal);
    return { messageId: String(response.message_id ?? response.msgid ?? clientId) };
  }

  async sendTyping(input: { toUserId: string; contextToken?: string; typing?: boolean; signal?: AbortSignal }): Promise<void> {
    const config = await this.post("ilink/bot/getconfig", {
      ilink_user_id: input.toUserId,
      ...(input.contextToken ? { context_token: input.contextToken } : {}),
      base_info: { channel_version: "0.1.0" }
    }, input.signal);
    const typingTicket = typeof config.typing_ticket === "string" ? config.typing_ticket.trim() : "";
    if (!typingTicket) {
      throw new Error("getconfig response missing typing_ticket");
    }
    await this.post("ilink/bot/sendtyping", {
      ilink_user_id: input.toUserId,
      typing_ticket: typingTicket,
      status: input.typing === false ? 2 : 1,
      base_info: { channel_version: "0.1.0" }
    }, input.signal);
  }

  async getUploadUrl(input: {
    fileKey: string;
    mediaType: number;
    toUserId: string;
    rawSize: number;
    rawFileMd5: string;
    cipherSize: number;
    noNeedThumb?: boolean;
    aesKeyHex?: string;
    signal?: AbortSignal;
  }): Promise<{ uploadParam?: string; uploadFullUrl?: string; fileKey?: string }> {
    const response = await this.post("ilink/bot/getuploadurl", {
      filekey: input.fileKey,
      media_type: input.mediaType,
      to_user_id: input.toUserId,
      rawsize: input.rawSize,
      rawfilemd5: input.rawFileMd5,
      filesize: input.cipherSize,
      ...(typeof input.noNeedThumb === "boolean" ? { no_need_thumb: input.noNeedThumb } : {}),
      ...(input.aesKeyHex ? { aeskey: input.aesKeyHex } : {}),
      base_info: { channel_version: "0.1.0" }
    }, input.signal);
    return {
      uploadParam: typeof response.upload_param === "string" ? response.upload_param : undefined,
      uploadFullUrl: typeof response.upload_full_url === "string" ? response.upload_full_url : undefined,
      fileKey: typeof response.filekey === "string" ? response.filekey : undefined
    };
  }

  async sendFileMessage(input: {
    toUserId: string;
    fileName: string;
    encryptQueryParam: string;
    aesKeyBase64: string;
    plainSize: number;
    contextToken?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string }> {
    const clientId = crypto.randomUUID();
    const response = await this.post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: input.toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
        item_list: [{
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyBase64,
              encrypt_type: 1
            },
            file_name: input.fileName,
            len: String(input.plainSize)
          }
        }]
      },
      base_info: { channel_version: "0.1.0" }
    }, input.signal);
    return { messageId: String(response.message_id ?? response.msgid ?? clientId) };
  }

  async sendImageMessage(input: {
    toUserId: string;
    encryptQueryParam: string;
    aesKeyBase64: string;
    cipherSize: number;
    contextToken?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string }> {
    const clientId = crypto.randomUUID();
    const response = await this.post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: input.toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
        item_list: [{
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyBase64,
              encrypt_type: 1
            },
            mid_size: input.cipherSize,
            hd_size: input.cipherSize
          }
        }]
      },
      base_info: { channel_version: "0.1.0" }
    }, input.signal);
    return { messageId: String(response.message_id ?? response.msgid ?? clientId) };
  }

  async sendVideoMessage(input: {
    toUserId: string;
    encryptQueryParam: string;
    aesKeyBase64: string;
    cipherSize: number;
    contextToken?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string }> {
    const clientId = crypto.randomUUID();
    const response = await this.post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: input.toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
        item_list: [{
          type: 5,
          video_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyBase64,
              encrypt_type: 1
            },
            video_size: input.cipherSize
          }
        }]
      },
      base_info: { channel_version: "0.1.0" }
    }, input.signal);
    return { messageId: String(response.message_id ?? response.msgid ?? clientId) };
  }

  private async post(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = createRequestSignal(signal, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
        method: "POST",
        signal: timeout.signal,
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${this.options.token}`
        },
        body: JSON.stringify(body)
      });

      const text = await response.text();
      if (!response.ok) {
        throw new WeixinApiError(`${endpoint} failed with HTTP ${response.status}: ${text}`, shortEndpoint(endpoint));
      }

      const parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
      const ret = typeof parsed.ret === "number" ? parsed.ret : 0;
      const errcode = typeof parsed.errcode === "number" ? parsed.errcode : undefined;
      if (ret !== 0) {
        throw new WeixinApiError(
          `${shortEndpoint(endpoint)} failed: ret=${ret} errcode=${errcode ?? "undefined"} errmsg=${String(parsed.errmsg ?? "")}`,
          shortEndpoint(endpoint),
          ret,
          errcode
        );
      }
      return parsed;
    } catch (error) {
      if (timeout.didTimeout) {
        throw new WeixinApiTimeoutError(endpoint, timeout.timeoutMs);
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  }
}

function createRequestSignal(inputSignal: AbortSignal | undefined, timeoutMs: number): {
  signal?: AbortSignal;
  readonly didTimeout: boolean;
  timeoutMs: number;
  cleanup: () => void;
} {
  if (!timeoutMs) {
    return { signal: inputSignal, didTimeout: false, timeoutMs: 0, cleanup: () => undefined };
  }
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  let onAbort: (() => void) | undefined;
  if (inputSignal) {
    onAbort = () => controller.abort(inputSignal.reason);
    if (inputSignal.aborted) onAbort();
    else inputSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get didTimeout() {
      return didTimeout;
    },
    timeoutMs,
    cleanup: () => {
      clearTimeout(timer);
      if (inputSignal && onAbort) inputSignal.removeEventListener("abort", onAbort);
    }
  };
}

function shortEndpoint(endpoint: string): string {
  return endpoint.split("/").at(-1) ?? endpoint;
}
