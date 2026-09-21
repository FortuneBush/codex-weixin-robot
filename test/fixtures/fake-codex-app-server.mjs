#!/usr/bin/env node

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
let nextTurn = 1;
const activeTurns = new Map();
const loadedThreads = new Set();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, message) {
  send({ id, error: { code: -32602, message } });
}

function failWithCode(id, code, message) {
  send({ id, error: { code, message } });
}

function completedTurn(id, status, error = null) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (message.jsonrpc) {
      fail(message.id, "jsonrpc header must be omitted");
      return;
    }
    if (message.params?.clientInfo?.name !== "codex-weixin") {
      fail(message.id, "missing codex-weixin clientInfo");
      return;
    }
    respond(message.id, {
      userAgent: "fake-codex",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "test"
    });
    return;
  }

  if (message.method === "initialized") {
    initialized = true;
    return;
  }

  if (!initialized) {
    fail(message.id, "Not initialized");
    return;
  }

  if (message.method === "thread/start") {
    if (message.params?.approvalPolicy !== "never") {
      fail(message.id, "approvalPolicy must be never");
      return;
    }
    if (process.env.CODEX_FIXTURE_REQUIRE_SANDBOX === "1" && message.params?.sandbox !== "danger-full-access") {
      fail(message.id, "sandbox must be danger-full-access");
      return;
    }
    if (process.env.CODEX_FIXTURE_REQUIRE_SANDBOX === "1" && message.params?.ephemeral !== false) {
      fail(message.id, "ephemeral must be false");
      return;
    }
    respond(message.id, {
      thread: { id: "thread-new" },
      model: message.params.model ?? "configured-model",
      reasoningEffort: "high"
    });
    loadedThreads.add("thread-new");
    return;
  }

  if (message.method === "thread/resume") {
    if (message.params.threadId === "thread-stale") {
      failWithCode(message.id, -32600, "no rollout found for thread id thread-stale");
      return;
    }
    respond(message.id, {
      thread: { id: message.params.threadId },
      model: "resumed-model",
      reasoningEffort: "medium"
    });
    loadedThreads.add(message.params.threadId);
    return;
  }

  if (message.method === "config/read") {
    respond(message.id, {
      config: {
        model: "configured-model",
        model_provider: "FixtureProvider",
        model_reasoning_effort: "high"
      },
      origins: {}
    });
    return;
  }

  if (message.method === "model/list") {
    respond(message.id, {
      data: [{
        id: "configured-model",
        model: "configured-model",
        displayName: "Configured Model",
        description: "Model used by the test fixture.",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deeper reasoning" }
        ],
        defaultReasoningEffort: "medium",
        isDefault: true
      }],
      nextCursor: null
    });
    return;
  }

  if (message.method === "thread/list") {
    respond(message.id, { data: [{ id: "thread-new" }], nextCursor: null, backwardsCursor: null });
    return;
  }

  if (message.method === "thread/read") {
    if (!loadedThreads.has(message.params.threadId)) {
      failWithCode(message.id, -32600, `thread not loaded: ${message.params.threadId}`);
      return;
    }
    respond(message.id, {
      thread: {
        id: message.params.threadId,
        turns: [
          {
            id: "history-turn-1",
            status: "completed",
            startedAt: 1_700_000_000,
            completedAt: 1_700_000_002,
            items: [
              {
                type: "userMessage",
                id: "history-user-1",
                clientId: null,
                content: [{ type: "text", text: "hello history", text_elements: [] }]
              },
              {
                type: "agentMessage",
                id: "history-commentary-1",
                text: "working",
                phase: "commentary",
                memoryCitation: null
              },
              {
                type: "agentMessage",
                id: "history-assistant-1",
                text: "history reply",
                phase: "final_answer",
                memoryCitation: null
              },
              { type: "reasoning", id: "history-reasoning-1", summary: [], content: ["hidden"] }
            ]
          }
        ]
      }
    });
    return;
  }

  if (message.method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const prompt = message.params?.input?.[0]?.text;
    if (message.params?.input?.[0]?.type !== "text" || typeof prompt !== "string") {
      fail(message.id, "turn/start requires text input");
      return;
    }
    if (process.env.CODEX_FIXTURE_REQUIRE_SANDBOX === "1" && message.params?.sandboxPolicy?.type !== "dangerFullAccess") {
      fail(message.id, "sandboxPolicy must be dangerFullAccess");
      return;
    }
    activeTurns.set(message.params.threadId, turnId);
    respond(message.id, { turn: completedTurn(turnId, "inProgress") });
    if (prompt === "hold") {
      return;
    }
    setTimeout(() => {
      const progressItemId = `progress-${turnId}`;
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: { type: "agentMessage", id: progressItemId, text: "", phase: "commentary", memoryCitation: null }
        }
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: message.params.threadId, turnId, itemId: progressItemId, delta: `working:${prompt}` }
      });
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: progressItemId, text: `working:${prompt}`, phase: "commentary", memoryCitation: null }
        }
      });
      const itemId = `item-${turnId}`;
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null }
        }
      });
      for (const delta of ["reply:", prompt]) {
        send({
          method: "item/agentMessage/delta",
          params: { threadId: message.params.threadId, turnId, itemId, delta }
        });
      }
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: itemId, text: `reply:${prompt}`, phase: "final_answer", memoryCitation: null }
        }
      });
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: message.params.threadId,
          turnId,
          tokenUsage: {
            last: {
              cachedInputTokens: 2,
              inputTokens: 12,
              outputTokens: 7,
              reasoningOutputTokens: 3,
              totalTokens: 19
            },
            total: {
              cachedInputTokens: 2,
              inputTokens: 12,
              outputTokens: 7,
              reasoningOutputTokens: 3,
              totalTokens: 19
            }
          }
        }
      });
      send({
        method: "turn/completed",
        params: { threadId: message.params.threadId, turn: completedTurn(turnId, "completed") }
      });
      activeTurns.delete(message.params.threadId);
    }, 5);
    return;
  }

  if (message.method === "turn/interrupt") {
    const activeTurnId = activeTurns.get(message.params.threadId);
    if (activeTurnId !== message.params.turnId) {
      fail(message.id, "turn/interrupt used the wrong turnId");
      return;
    }
    respond(message.id, {});
    send({
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: completedTurn(activeTurnId, "interrupted") }
    });
    activeTurns.delete(message.params.threadId);
    return;
  }

  fail(message.id, `unsupported method: ${message.method}`);
});
