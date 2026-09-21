import {
  AppServerCodexRunner,
  isUnavailableCodexThreadError,
  type CodexHistoryMessage,
  type CodexModelOption,
  type CodexRunnerInput,
  type CodexRuntimeInfo
} from "./app-server-runner.js";
import { CodexExecRunner, type CodexRunResult } from "./exec-runner.js";
import type { CodexExecSandbox } from "./sandbox.js";

export { isUnavailableCodexThreadError } from "./app-server-runner.js";

export type CodexBackend = "auto" | "app-server" | "exec";

export type HybridCodexRunnerOptions = {
  backend: CodexBackend;
  codexBin?: string;
  execSandbox?: CodexExecSandbox;
  timeoutMs?: number | null;
};

export class HybridCodexRunner {
  private readonly appServer: AppServerCodexRunner;
  private readonly exec: CodexExecRunner;

  constructor(private readonly options: HybridCodexRunnerOptions) {
    this.appServer = new AppServerCodexRunner({
      codexBin: options.codexBin,
      sandbox: options.execSandbox,
      requestTimeoutMs: options.timeoutMs
    });
    this.exec = new CodexExecRunner({
      codexBin: options.codexBin,
      sandbox: options.execSandbox,
      timeoutMs: options.timeoutMs
    });
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    const requiresAppServerForStreaming = Boolean(input.onDelta || input.onProgress);
    if (this.options.backend === "exec" && !requiresAppServerForStreaming) {
      try {
        return await this.exec.run(input);
      } catch (error) {
        if (!input.threadId || !isUnavailableCodexThreadError(error)) {
          throw error;
        }
        const recovered = await this.exec.run({ ...input, threadId: undefined });
        return {
          ...recovered,
          text: `Warning: the previous Codex context was unavailable after the service restarted; started a new context.\n\n${recovered.text}`
        };
      }
    }
    try {
      return await this.appServer.run(input);
    } catch (error) {
      if (input.threadId && isUnavailableCodexThreadError(error)) {
        const recovered = await this.appServer.run({ ...input, threadId: undefined });
        return {
          ...recovered,
          text: `Warning: the previous Codex context was unavailable after the service restarted; started a new context.\n\n${recovered.text}`
        };
      }
      if (this.options.backend === "app-server") {
        throw error;
      }
      const fallback = await this.exec.run({
        ...input,
        onDelta: undefined,
        onProgress: undefined
      });
      return {
        ...fallback,
        text: `Warning: Codex app-server was unavailable, used codex exec fallback.\n\n${fallback.text}`
      };
    }
  }

  async stop(threadId?: string): Promise<void> {
    await Promise.all([
      this.appServer.stop(threadId),
      this.exec.stop(threadId)
    ]);
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    return this.appServer.getHistory(threadId);
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    return this.appServer.getRuntimeInfo(cwd, threadId);
  }

  async listModels(): Promise<CodexModelOption[]> {
    return this.appServer.listModels();
  }

  close(): void {
    this.appServer.close();
    this.exec.close();
  }
}
