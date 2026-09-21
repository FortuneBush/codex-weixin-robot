import os from "node:os";
import path from "node:path";

const INHERITED_CODEX_TASK_VARS = [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_PERMISSION_PROFILE",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_CI",
  "CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE"
] as const;

export function codexChildEnvironment(): NodeJS.ProcessEnv {
  // PM2 can be launched from Codex Desktop. These values belong to that
  // parent task and must not identify this independent Codex session.
  const env = { ...process.env };
  for (const key of INHERITED_CODEX_TASK_VARS) {
    delete env[key];
  }
  env.CODEX_HOME ??= path.join(os.homedir(), ".codex");
  return env;
}
