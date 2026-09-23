export function userFacingMessageHandlingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/CreateProcessAsUserW failed:\s*1312|codexExecSandbox/i.test(message)) {
    return [
      "[codex-weixin] Windows Codex sandbox 启动失败。",
      "可在 ~/.codex-weixin/config.json 中设置 \"codexExecSandbox\": \"danger-full-access\" 后重启。",
      "该设置会让 Codex 获得本机完整访问权限，请仅在理解并接受安全风险时启用。"
    ].join("\n");
  }
  if (/timed out|timeout/i.test(message)) {
    return "[codex-weixin] 本轮任务执行时间过长，已停止处理。请拆成更小的步骤后重试。";
  }
  if (/\b502\b|bad gateway/i.test(message)) {
    return "[codex-weixin] 上游 Codex 服务暂时返回 502（Bad Gateway），本地服务没有超时。请稍后重试。";
  }
  return "[codex-weixin] 本轮消息处理失败，详细错误已写入本机服务输出。";
}
