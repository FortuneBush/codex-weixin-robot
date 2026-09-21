const state = {
  version: "",
  requestToken: "",
  accounts: [],
  sessions: [],
  config: null,
  codex: null,
  codexRuntime: null,
  codexModels: [],
  loginPoll: null,
  selectedSessionKey: "",
  sessionMessages: [],
  loadedSessionKey: "",
  loadingMessages: false,
  sendingMessage: false,
  savingSessionRuntime: false,
  selectedAccountId: "",
  chatFiles: [],
  usageAccountFilter: "",
  usageSessionFilter: "",
  usageSort: "total",
  usagePageSize: 10,
  usageSessionPage: 1,
  usageRecentPage: 1
};

const MAX_CHAT_FILES = 10;
const MAX_CHAT_FILE_BYTES = 100 * 1024 * 1024;
let streamingRenderFrame = 0;

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  Object.assign(els, {
    accountsList: document.querySelector("#accountsList"),
    productVersion: document.querySelector("#productVersion"),
    sessionsList: document.querySelector("#sessionsList"),
    sessionAccountTabs: document.querySelector("#sessionAccountTabs"),
    sessionListCount: document.querySelector("#sessionListCount"),
    chatTitle: document.querySelector("#chatTitle"),
    chatContext: document.querySelector("#chatContext"),
    chatMessages: document.querySelector("#chatMessages"),
    chatComposer: document.querySelector("#chatComposer"),
    chatInput: document.querySelector("#chatInput"),
    chatSendButton: document.querySelector("#chatSendButton"),
    chatAttachButton: document.querySelector("#chatAttachButton"),
    chatFileInput: document.querySelector("#chatFileInput"),
    composerFiles: document.querySelector("#composerFiles"),
    refreshMessagesButton: document.querySelector("#refreshMessagesButton"),
    sessionRuntimeToolbar: document.querySelector("#sessionRuntimeToolbar"),
    sessionModelInput: document.querySelector("#sessionModelInput"),
    sessionEffortInput: document.querySelector("#sessionEffortInput"),
    sessionStreamInput: document.querySelector("#sessionStreamInput"),
    runningAccountMetric: document.querySelector("#runningAccountMetric"),
    sessionMetric: document.querySelector("#sessionMetric"),
    workspaceMetric: document.querySelector("#workspaceMetric"),
    usageTotal: document.querySelector("#usageTotal"),
    usageInput: document.querySelector("#usageInput"),
    usageOutput: document.querySelector("#usageOutput"),
    usageCacheRate: document.querySelector("#usageCacheRate"),
    usageCacheDetail: document.querySelector("#usageCacheDetail"),
    usageTurns: document.querySelector("#usageTurns"),
    usageAvgTurn: document.querySelector("#usageAvgTurn"),
    usageChart: document.querySelector("#usageChart"),
    usageEmpty: document.querySelector("#usageEmpty"),
    usageTrend: document.querySelector("#usageTrend"),
    usageTrendEmpty: document.querySelector("#usageTrendEmpty"),
    usageMix: document.querySelector("#usageMix"),
    usageMixStats: document.querySelector("#usageMixStats"),
    usageRecent: document.querySelector("#usageRecent"),
    usageRecentCount: document.querySelector("#usageRecentCount"),
    usageRecentEmpty: document.querySelector("#usageRecentEmpty"),
    usageAccountFilter: document.querySelector("#usageAccountFilter"),
    usageSessionFilter: document.querySelector("#usageSessionFilter"),
    usageSortFilter: document.querySelector("#usageSortFilter"),
    usagePageSize: document.querySelector("#usagePageSize"),
    usageResetFilters: document.querySelector("#usageResetFilters"),
    usageSessionPagination: document.querySelector("#usageSessionPagination"),
    usageRecentPagination: document.querySelector("#usageRecentPagination"),
    usageSortNote: document.querySelector("#usageSortNote"),
    qrDialog: document.querySelector("#qrDialog"),
    qrFrame: document.querySelector("#qrFrame"),
    qrStatus: document.querySelector("#qrStatus"),
    settingsVersionValue: document.querySelector("#settingsVersionValue"),
    accountDialog: document.querySelector("#accountDialog"),
    removeAccountDialog: document.querySelector("#removeAccountDialog"),
    sessionDialog: document.querySelector("#sessionDialog")
  });
  bindEvents();
  void bootstrap();
});

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => closeDialog(button.dataset.closeDialog)));
  document.querySelector("#addAccountButton").addEventListener("click", () => void beginLogin());
  document.querySelector("#refreshQrButton").addEventListener("click", () => void beginLogin());
  document.querySelector("#refreshAccountsButton").addEventListener("click", () => void refreshData(true));
  document.querySelector("#refreshUsageButton").addEventListener("click", () => void refreshData(true));
  document.querySelector("#newSessionButton").addEventListener("click", openNewSessionDialog);
  document.querySelector("#settingsForm").addEventListener("submit", (event) => void saveSettings(event));
  document.querySelector("#modelInput").addEventListener("change", () => renderEffortOptions(""));
  els.sessionModelInput.addEventListener("change", () => void handleSessionModelChange());
  els.sessionEffortInput.addEventListener("change", () => void saveSessionRuntimeSettings());
  els.sessionStreamInput.addEventListener("change", () => void saveSessionRuntimeSettings());
  document.querySelector("#accountForm").addEventListener("submit", (event) => void saveAccountRemark(event));
  document.querySelector("#removeAccountForm").addEventListener("submit", (event) => void removeAccount(event));
  document.querySelector("#sessionForm").addEventListener("submit", (event) => void saveSession(event));
  document.querySelector("#sessionSenderInput").addEventListener("change", updateNewSessionDefaultTitle);
  els.chatComposer.addEventListener("submit", (event) => void sendSessionMessage(event));
  els.chatInput.addEventListener("input", updateComposerState);
  els.chatInput.addEventListener("keydown", handleChatInputKeydown);
  els.chatAttachButton.addEventListener("click", () => els.chatFileInput.click());
  els.chatFileInput.addEventListener("change", handleChatFileSelection);
  els.composerFiles.addEventListener("click", handleComposerFileAction);
  els.refreshMessagesButton.addEventListener("click", () => void loadSelectedSessionMessages());
  els.accountsList.addEventListener("click", (event) => void handleAccountAction(event));
  els.sessionsList.addEventListener("click", (event) => void handleSessionAction(event));
  els.sessionAccountTabs.addEventListener("click", handleSessionAccountTab);
  els.usageAccountFilter.addEventListener("change", handleUsageFilterChange);
  els.usageSessionFilter.addEventListener("change", handleUsageFilterChange);
  els.usageSortFilter.addEventListener("change", handleUsageFilterChange);
  els.usagePageSize.addEventListener("change", handleUsagePageSizeChange);
  els.usageResetFilters.addEventListener("click", resetUsageFilters);
  els.usageSessionPagination.addEventListener("click", handleUsagePagination);
  els.usageRecentPagination.addEventListener("click", handleUsagePagination);
  els.qrDialog.addEventListener("close", stopLoginPoll);
  window.addEventListener("hashchange", () => showView(location.hash.slice(1) || "accounts", false));
}

async function bootstrap() {
  try {
    const data = await api("/api/bootstrap", { token: false });
    state.requestToken = data.requestToken;
    state.version = data.version || "";
    state.accounts = data.accounts;
    state.sessions = data.sessions;
    state.config = data.config;
    state.codex = data.codex;
    state.codexRuntime = data.codexRuntime;
    state.codexModels = data.codexModels || [];
    renderAll();
    showView(location.hash.slice(1) || "accounts", false);
    window.setInterval(() => void refreshData(false), 5000);
  } catch (error) {
    toast(error.message, true);
    els.accountsList.innerHTML = emptyState("server-off", "无法连接本机服务", "请重新启动 codex-weixin");
  }
}

async function refreshData(notify) {
  try {
    const previousSession = selectedSession();
    const [accounts, sessions] = await Promise.all([api("/api/accounts"), api("/api/sessions")]);
    state.accounts = accounts.accounts;
    state.sessions = sessions.sessions;
    renderMetrics();
    renderAccounts();
    renderSessions();
    renderUsage();
    drawIcons();
    const currentSession = selectedSession();
    if (
      previousSession
      && currentSession
      && sessionKey(previousSession) === sessionKey(currentSession)
      && previousSession.updatedAt !== currentSession.updatedAt
      && state.loadedSessionKey === state.selectedSessionKey
      && !state.sendingMessage
    ) {
      void loadSelectedSessionMessages();
    } else if (previousSession?.responding !== currentSession?.responding) {
      window.requestAnimationFrame(scrollChatToEnd);
    }
    if (notify) toast("状态已刷新");
  } catch (error) {
    if (notify) toast(error.message, true);
  }
}

function renderAll() {
  renderProductVersion();
  renderMetrics();
  renderAccounts();
  renderSessions();
  renderUsage();
  renderSettings();
  drawIcons();
}

function renderProductVersion() {
  const version = state.version.trim();
  els.productVersion.hidden = !version;
  els.productVersion.textContent = version ? `v${version.replace(/^v/i, "")}` : "";
  els.settingsVersionValue.textContent = version ? `v${version.replace(/^v/i, "")}` : "--";
}

function renderMetrics() {
  els.runningAccountMetric.textContent = String(state.accounts.filter((account) => account.status === "running").length);
  els.sessionMetric.textContent = String(state.sessions.length);
  els.workspaceMetric.textContent = state.config?.defaultCwd || "--";
  els.workspaceMetric.title = state.config?.defaultCwd || "";
  const serviceText = document.querySelector("#serviceStateText");
  const serviceDot = document.querySelector("#serviceDot");
  if (state.codex?.ready) {
    serviceText.textContent = state.codex.version || "Codex 已就绪";
    serviceDot.classList.remove("is-error");
  } else {
    serviceText.textContent = "未检测到 Codex CLI";
    serviceDot.classList.add("is-error");
  }
}

function renderAccounts() {
  const expandedAccountIds = new Set(
    [...els.accountsList.querySelectorAll(".account-identifiers[open]")]
      .map((details) => details.dataset.accountId)
      .filter(Boolean)
  );
  if (!state.accounts.length) {
    els.accountsList.innerHTML = emptyState("scan-line", "还没有微信账号", "", `<button class="button button-primary" type="button" data-account-action="add"><i data-lucide="scan-line"></i><span>添加微信</span></button>`);
    drawIcons();
    return;
  }
  els.accountsList.innerHTML = state.accounts.map((account) => {
    const pendingSender = account.lastActiveSenderId && !account.pairedSenderIds.includes(account.lastActiveSenderId)
      ? account.lastActiveSenderId : "";
    const authorized = account.pairedSenderIds.length > 0;
    return `<article class="account-card">
      <div class="account-main">
        <div class="account-identity">
          <span class="account-avatar"><i data-lucide="message-circle"></i></span>
          <div class="account-name">
            <strong>${escapeHtml(accountDisplayName(account.accountId))}</strong>
            <div class="account-description">个人微信接入</div>
          </div>
        </div>
        <div class="account-stat"><span>状态</span><strong class="status-label status-${escapeAttr(account.status)}">${statusText(account.status)}</strong></div>
        <div class="account-stat"><span>会话</span><strong>${account.sessionCount}</strong></div>
        <div class="account-actions">
          <button class="icon-button" type="button" data-account-action="rename" data-account-id="${escapeAttr(account.accountId)}" title="修改账号备注" aria-label="修改账号备注"><i data-lucide="pencil"></i></button>
          <button class="icon-button" type="button" data-account-action="${account.status === "running" ? "stop" : "start"}" data-account-id="${escapeAttr(account.accountId)}" title="${account.status === "running" ? "停止账号" : "启动账号"}" aria-label="${account.status === "running" ? "停止账号" : "启动账号"}"><i data-lucide="${account.status === "running" ? "pause" : "play"}"></i></button>
          <button class="icon-button is-danger" type="button" data-account-action="remove" data-account-id="${escapeAttr(account.accountId)}" title="移除账号" aria-label="移除账号"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <details class="account-identifiers" data-account-id="${escapeAttr(account.accountId)}"${expandedAccountIds.has(account.accountId) ? " open" : ""}>
        <summary>
          <span class="account-identifiers-title"><i data-lucide="fingerprint"></i><strong>账号 ID</strong><small>Bot ID 与 User ID</small></span>
          <i class="account-identifiers-chevron" data-lucide="chevron-down"></i>
        </summary>
        <dl class="account-identifiers-grid">
          <div><dt>Bot ID</dt><dd><code title="${escapeAttr(account.botId || account.accountId)}">${escapeHtml(account.botId || account.accountId)}</code></dd></div>
          <div><dt>User ID</dt><dd><code title="${escapeAttr(account.userId || "未返回")}">${escapeHtml(account.userId || "未返回")}</code></dd></div>
        </dl>
      </details>
      <div class="account-detail">${renderAuthorizationState(account, pendingSender)}</div>
      ${authorized && pendingSender ? `<div class="pending-access"><div><strong>新的微信访问请求</strong><span>当前授权不受影响，可选择允许新的访问</span></div><button class="button button-secondary" type="button" data-account-action="allow" data-account-id="${escapeAttr(account.accountId)}" data-sender-id="${escapeAttr(pendingSender)}"><i data-lucide="user-check"></i><span>允许访问</span></button></div>` : ""}
      ${account.error ? `<div class="pending-access"><div><strong>账号运行错误</strong><span>${escapeHtml(account.error)}</span></div></div>` : ""}
    </article>`;
  }).join("");
}

function renderAuthorizationState(account, pendingSender) {
  const accountId = escapeAttr(account.accountId);
  if (account.pairedSenderIds.length) {
    return `<div class="authorization-state is-authorized" aria-label="授权状态：已授权">
      <span class="authorization-icon"><i data-lucide="shield-check"></i></span>
      <div class="authorization-copy"><strong>已授权</strong><span>可以从微信控制 Codex</span></div>
      <button class="button button-secondary authorization-action" type="button" data-account-action="revoke-all" data-account-id="${accountId}"><i data-lucide="shield-x"></i><span>撤销授权</span></button>
    </div>`;
  }
  if (pendingSender) {
    return `<div class="authorization-state is-pending" aria-label="授权状态：待授权">
      <span class="authorization-icon"><i data-lucide="shield-alert"></i></span>
      <div class="authorization-copy"><strong>待授权</strong><span>检测到新的微信访问请求</span></div>
      <button class="button button-primary authorization-action" type="button" data-account-action="allow" data-account-id="${accountId}" data-sender-id="${escapeAttr(pendingSender)}"><i data-lucide="user-check"></i><span>允许访问</span></button>
    </div>`;
  }
  return `<div class="authorization-state is-unauthorized" aria-label="授权状态：未授权">
    <span class="authorization-icon"><i data-lucide="shield"></i></span>
    <div class="authorization-copy"><strong>未授权</strong><span>请先从微信向此账号发送一条消息</span></div>
  </div>`;
}

function renderSessions() {
  if (!state.sessions.length) {
    els.sessionListCount.textContent = "0";
    els.sessionAccountTabs.innerHTML = "";
    els.sessionsList.innerHTML = emptyState("messages-square", "还没有受管会话", "", `<button class="button button-secondary" type="button" data-session-action="new"><i data-lucide="plus"></i><span>新建会话</span></button>`);
    state.selectedSessionKey = "";
    state.sessionMessages = [];
    state.loadedSessionKey = "";
    renderChatPanel();
    drawIcons();
    return;
  }
  const accountIds = [...new Set([
    ...state.accounts.map((account) => account.accountId),
    ...state.sessions.map((session) => session.accountId)
  ])].filter((accountId) => state.sessions.some((session) => session.accountId === accountId));
  if (!accountIds.includes(state.selectedAccountId)) {
    const selected = selectedSession();
    state.selectedAccountId = selected && accountIds.includes(selected.accountId) ? selected.accountId : accountIds[0];
  }
  const visibleSessions = state.sessions.filter((session) => session.accountId === state.selectedAccountId);
  els.sessionListCount.textContent = String(visibleSessions.length);
  els.sessionAccountTabs.innerHTML = accountIds.map((accountId) => {
    const active = accountId === state.selectedAccountId;
    const count = state.sessions.filter((session) => session.accountId === accountId).length;
    return `<button class="session-account-tab${active ? " is-active" : ""}" type="button" data-session-account="${escapeAttr(accountId)}" aria-pressed="${active}"><i data-lucide="message-circle"></i><span>${escapeHtml(accountDisplayName(accountId))}</span><b>${count}</b></button>`;
  }).join("");
  let shouldLoad = false;
  if (!visibleSessions.some((session) => sessionKey(session) === state.selectedSessionKey)) {
    state.selectedSessionKey = sessionKey(visibleSessions[0]);
    state.sessionMessages = [];
    state.loadedSessionKey = "";
    shouldLoad = true;
  }
  els.sessionsList.innerHTML = visibleSessions.map((session) => {
    const selected = sessionKey(session) === state.selectedSessionKey;
    return `<article class="session-card${selected ? " is-selected" : ""}">
      <button class="session-open" type="button" data-session-action="open" data-account-id="${escapeAttr(session.accountId)}" data-session-id="${escapeAttr(session.id)}" aria-pressed="${selected}">
        <span class="session-card-top"><strong>${session.active ? `<span class="active-mark" title="微信当前会话"></span>` : ""}${escapeHtml(session.title)}</strong><time datetime="${escapeAttr(session.updatedAt)}">${escapeHtml(relativeTime(session.updatedAt))}</time></span>
        <span class="session-owner"><strong>${escapeHtml(accountDisplayName(session.accountId))}</strong></span>
        <span class="session-workspace" title="${escapeAttr(session.workspace)}">${escapeHtml(session.workspace)}</span>
        <span class="session-thread${session.responding ? " is-responding" : ""}">${session.responding ? "对方正在输入…" : session.threadId ? "已连接 Codex" : "等待首条消息"}</span>
        ${session.tokenUsage ? `<span class="session-token-usage">Token ${formatTokenCount(session.tokenUsage.totalTokens)} · ${session.tokenUsage.turnCount} 轮</span>` : ""}
      </button>
      <div class="session-actions">
        <button class="icon-button" type="button" data-session-action="activate" data-account-id="${escapeAttr(session.accountId)}" data-session-id="${escapeAttr(session.id)}" ${session.active ? "disabled" : ""} title="切换为微信当前会话" aria-label="切换为微信当前会话"><i data-lucide="circle-play"></i></button>
        <button class="icon-button" type="button" data-session-action="rename" data-account-id="${escapeAttr(session.accountId)}" data-session-id="${escapeAttr(session.id)}" title="重命名会话" aria-label="重命名会话"><i data-lucide="pencil"></i></button>
        <button class="icon-button" type="button" data-session-action="reset" data-account-id="${escapeAttr(session.accountId)}" data-session-id="${escapeAttr(session.id)}" ${session.threadId ? "" : "disabled"} title="重置 Codex 上下文" aria-label="重置 Codex 上下文"><i data-lucide="rotate-ccw"></i></button>
        <button class="icon-button is-danger" type="button" data-session-action="delete" data-account-id="${escapeAttr(session.accountId)}" data-session-id="${escapeAttr(session.id)}" title="删除受管会话" aria-label="删除受管会话"><i data-lucide="trash-2"></i></button>
      </div>
    </article>`;
  }).join("");
  renderChatPanel();
  drawIcons();
  if (shouldLoad) void loadSelectedSessionMessages();
}

function renderSettings() {
  if (!state.config) return;
  document.querySelector("#defaultCwdInput").value = state.config.defaultCwd || "";
  document.querySelector("#allowedWorkspacesInput").value = (state.config.allowedWorkspaces || []).join("\n");
  document.querySelector("#backendInput").value = state.config.codexBackend || "auto";
  document.querySelector("#sandboxInput").value = state.config.codexExecSandbox || "";
  document.querySelector("#streamRepliesInput").checked = Boolean(state.config.streamReplies);
  renderModelOptions();
  document.querySelector("#effectiveModelValue").textContent = state.codexRuntime?.model || state.config.model || "Codex 默认";
  document.querySelector("#effectiveEffortValue").textContent = state.codexRuntime?.effort || state.config.effort || "Codex 默认";
}

function renderModelOptions() {
  const select = document.querySelector("#modelInput");
  const configuredModel = state.config?.model || "";
  const effectiveModel = state.codexRuntime?.model || "";
  const models = Array.isArray(state.codexModels) ? state.codexModels : [];
  const options = [{
    value: "",
    label: effectiveModel ? `沿用 Codex 设置（当前：${effectiveModel}）` : "沿用 Codex 设置"
  }, ...models.map((model) => ({
    value: model.model,
    label: model.displayName && model.displayName !== model.model
      ? `${model.displayName} · ${model.model}`
      : model.model,
    title: model.description || ""
  }))];
  if (configuredModel && !options.some((option) => option.value === configuredModel)) {
    options.push({ value: configuredModel, label: `${configuredModel}（当前配置）` });
  }
  select.innerHTML = options.map((option) => `<option value="${escapeAttr(option.value)}"${option.title ? ` title="${escapeAttr(option.title)}"` : ""}>${escapeHtml(option.label)}</option>`).join("");
  select.value = configuredModel;
  renderEffortOptions(state.config?.effort || "");
}

function renderEffortOptions(preferredEffort) {
  const modelValue = document.querySelector("#modelInput").value;
  const effectiveModel = modelValue || state.codexRuntime?.model || "";
  const model = state.codexModels.find((candidate) => candidate.model === effectiveModel);
  const allEfforts = model?.supportedEfforts?.length
    ? model.supportedEfforts
    : state.codexModels.flatMap((candidate) => candidate.supportedEfforts || []);
  const efforts = [...new Map(allEfforts.map((option) => [option.effort, option])).values()]
    .sort((a, b) => effortRank(a.effort) - effortRank(b.effort));
  if (preferredEffort && !efforts.some((option) => option.effort === preferredEffort)) {
    efforts.push({ effort: preferredEffort, description: "当前配置" });
  }
  const inheritedEffort = state.codexRuntime?.effort || model?.defaultEffort;
  const inheritedLabel = inheritedEffort
    ? `沿用 Codex 设置（当前：${effortInlineName(inheritedEffort)}）`
    : "沿用 Codex 设置";
  const select = document.querySelector("#effortInput");
  select.innerHTML = [
    `<option value="">${escapeHtml(inheritedLabel)}</option>`,
    ...efforts.map((option) => `<option value="${escapeAttr(option.effort)}"${option.description ? ` title="${escapeAttr(option.description)}"` : ""}>${escapeHtml(effortDisplayName(option.effort))}</option>`)
  ].join("");
  select.value = preferredEffort;
}

function effortDisplayName(effort) {
  const label = ({ minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大", ultra: "极高" })[effort];
  return label ? `${label}（${effort}）` : effort;
}

function effortInlineName(effort) {
  const label = ({ minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大", ultra: "极高" })[effort];
  return label ? `${label} · ${effort}` : effort;
}

function effortRank(effort) {
  const index = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].indexOf(effort);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

async function handleAccountAction(event) {
  const button = event.target.closest("[data-account-action]");
  if (!button) return;
  const action = button.dataset.accountAction;
  if (action === "add") return beginLogin();
  const accountId = button.dataset.accountId;
  const account = state.accounts.find((item) => item.accountId === accountId);
  if (action === "rename") {
    if (account) openAccountRemarkDialog(account);
    return;
  }
  if (action === "remove") {
    if (account) openRemoveAccountDialog(account);
    return;
  }
  try {
    button.disabled = true;
    if (action === "start" || action === "stop") await api(`/api/accounts/${encodeURIComponent(accountId)}/${action}`, { method: "POST" });
    if (action === "allow") {
      await api(`/api/accounts/${encodeURIComponent(accountId)}/senders/${encodeURIComponent(button.dataset.senderId)}/allow`, { method: "POST" });
    }
    if (action === "revoke-all" && account) {
      if (!window.confirm("撤销此微信账号的全部控制授权？撤销后需要重新允许才能继续使用。")) return;
      await Promise.all(account.pairedSenderIds.map((senderId) => api(
        `/api/accounts/${encodeURIComponent(accountId)}/senders/${encodeURIComponent(senderId)}/remove`,
        { method: "POST" }
      )));
    }
    await refreshData(false);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function openAccountRemarkDialog(account) {
  document.querySelector("#editingRemarkAccountId").value = account.accountId;
  document.querySelector("#accountRemarkInput").value = account.displayName || "";
  els.accountDialog.showModal();
  document.querySelector("#accountRemarkInput").select();
}

function openRemoveAccountDialog(account) {
  document.querySelector("#removingAccountId").value = account.accountId;
  document.querySelector("#removingAccountName").textContent = accountDisplayName(account.accountId);
  document.querySelector('input[name="retainHistory"][value="true"]').checked = true;
  els.removeAccountDialog.showModal();
  drawIcons();
}

async function removeAccount(event) {
  event.preventDefault();
  const button = event.submitter;
  const accountId = document.querySelector("#removingAccountId").value;
  const retainHistory = document.querySelector('input[name="retainHistory"]:checked')?.value === "true";
  try {
    button.disabled = true;
    await api(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      body: { retainHistory }
    });
    els.removeAccountDialog.close();
    await refreshData(false);
    toast(retainHistory ? "账号已移除，重新扫码后将恢复会话历史" : "账号和会话历史已删除");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function saveAccountRemark(event) {
  event.preventDefault();
  const button = event.submitter;
  const accountId = document.querySelector("#editingRemarkAccountId").value;
  const displayName = document.querySelector("#accountRemarkInput").value.trim();
  try {
    button.disabled = true;
    await api(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: { displayName }
    });
    els.accountDialog.close();
    await refreshData(false);
    toast(displayName ? "账号备注已保存" : "账号备注已清除");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function handleSessionAction(event) {
  const button = event.target.closest("[data-session-action]");
  if (!button) return;
  const action = button.dataset.sessionAction;
  if (action === "new") return openNewSessionDialog();
  const accountId = button.dataset.accountId;
  const sessionId = button.dataset.sessionId;
  const session = state.sessions.find((item) => item.accountId === accountId && item.id === sessionId);
  if (!session) return;
  if (action === "open") return selectSession(session);
  if (action === "rename") return openRenameSessionDialog(session);
  try {
    button.disabled = true;
    if (action === "activate" || action === "reset") {
      if (action === "reset" && !window.confirm("重置此会话的 Codex 上下文？下一条微信或 Web 消息会创建新的 thread。")) return;
      await api(`/api/sessions/${encodeURIComponent(accountId)}/${encodeURIComponent(sessionId)}/${action}`, { method: "POST" });
    }
    if (action === "delete") {
      if (!window.confirm("删除此受管会话？Codex 自身保存的历史文件不会被删除。")) return;
      await api(`/api/sessions/${encodeURIComponent(accountId)}/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    }
    await refreshData(false);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function handleSessionAccountTab(event) {
  const button = event.target.closest("[data-session-account]");
  if (!button || button.dataset.sessionAccount === state.selectedAccountId) return;
  state.selectedAccountId = button.dataset.sessionAccount;
  state.selectedSessionKey = "";
  state.sessionMessages = [];
  state.loadedSessionKey = "";
  resetComposer();
  renderSessions();
}

function selectSession(session) {
  const key = sessionKey(session);
  if (key === state.selectedSessionKey && state.loadedSessionKey === key) {
    return;
  }
  state.selectedSessionKey = key;
  state.sessionMessages = [];
  state.loadedSessionKey = "";
  state.loadingMessages = true;
  resetComposer();
  renderSessions();
  void loadSelectedSessionMessages();
}

async function loadSelectedSessionMessages() {
  const session = selectedSession();
  if (!session) {
    renderChatPanel();
    return;
  }
  const key = sessionKey(session);
  state.loadingMessages = true;
  renderChatPanel();
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.accountId)}/${encodeURIComponent(session.id)}/messages`);
    if (state.selectedSessionKey !== key) return;
    state.sessionMessages = result.messages || [];
    state.loadedSessionKey = key;
  } catch (error) {
    if (state.selectedSessionKey !== key) return;
    state.sessionMessages = [];
    state.loadedSessionKey = key;
    toast(error.message, true);
  } finally {
    if (state.selectedSessionKey === key) {
      state.loadingMessages = false;
      renderChatPanel();
      scrollChatToEnd();
    }
  }
}

function renderChatPanel() {
  const session = selectedSession();
  const enabled = Boolean(session) && !state.sendingMessage && !state.savingSessionRuntime;
  els.chatInput.disabled = !enabled;
  els.chatAttachButton.disabled = !enabled;
  els.chatFileInput.disabled = !enabled;
  els.refreshMessagesButton.disabled = !session || state.loadingMessages || state.sendingMessage;
  renderComposerFiles();
  updateComposerState();
  renderSessionRuntimeControls(session);
  if (!session) {
    els.chatTitle.textContent = "选择一个会话";
    els.chatContext.textContent = "查看历史消息并继续聊天";
    setChatMessagesHtml(emptyChatState("messages-square", "从左侧选择会话"), "no-session");
    return;
  }

  els.chatTitle.textContent = session.title;
  els.chatContext.textContent = `${accountDisplayName(session.accountId)} · ${session.workspace}`;
  const responding = Boolean(session.responding || state.sendingMessage);
  if (state.loadingMessages) {
    setChatMessagesHtml(
      `<div class="chat-loading"><div class="spinner" aria-label="正在加载历史消息"></div><span>正在读取 Codex 历史</span></div>`,
      `loading:${sessionKey(session)}`
    );
    return;
  }
  if (!state.sessionMessages.length) {
    setChatMessagesHtml(
      responding
        ? renderTypingIndicator()
        : emptyChatState("message-circle", session.threadId ? "这个 thread 暂无可显示消息" : "发送第一条消息开始会话", session.threadId ? "" : "历史会在 Codex 创建 thread 后显示"),
      `empty:${sessionKey(session)}:${session.threadId || "new"}:${responding}`
    );
    return;
  }
  const renderKey = `messages:${sessionKey(session)}:${responding}:${JSON.stringify(state.sessionMessages)}`;
  const html = renderConversationMessages(state.sessionMessages, responding) + (responding ? renderTypingIndicator() : "");
  setChatMessagesHtml(html, renderKey);
}

function renderConversationMessages(messages, responding) {
  const html = [];
  let lastUserCreatedAt;
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.kind === "progress") {
      const progress = [];
      while (index < messages.length && messages[index].kind === "progress") {
        progress.push(messages[index]);
        index += 1;
      }
      const nextMessage = messages[index];
      const active = responding && !nextMessage;
      const completedAt = nextMessage?.role === "assistant"
        ? nextMessage.createdAt
        : progress.at(-1)?.createdAt;
      html.push(renderProgressGroup(progress, lastUserCreatedAt, completedAt, active));
      continue;
    }
    if (message.role === "user") lastUserCreatedAt = message.createdAt;
    html.push(renderChatMessage(message));
    index += 1;
  }
  return html.join("");
}

function renderChatMessage(message) {
  return `<article class="chat-message is-${escapeAttr(message.role)}${message.attachments?.length ? " has-attachments" : ""}">
    <div class="message-meta"><span>${message.role === "user" ? "你" : "Codex"}</span>${message.createdAt ? `<time datetime="${escapeAttr(message.createdAt)}">${escapeHtml(messageTime(message.createdAt))}</time>` : ""}</div>
    <div class="message-bubble">${message.text ? renderMarkdown(message.text) : ""}${renderMessageAttachments(message.attachments)}</div>
  </article>`;
}

function renderProgressGroup(messages, startedAt, completedAt, active) {
  const duration = formatProcessingDuration(startedAt, active ? new Date().toISOString() : completedAt);
  return `<details class="chat-progress-group"${active ? " open" : ""}>
    <summary>
      <span class="progress-summary-title"><i data-lucide="chevron-right"></i>处理过程</span>
      <span>${active ? "已处理" : "处理用时"} ${escapeHtml(duration)}</span>
    </summary>
    <ol class="progress-list">${messages.map((message) => `<li>${renderMarkdown(message.text)}</li>`).join("")}</ol>
  </details>`;
}

function formatProcessingDuration(startValue, endValue) {
  const start = new Date(startValue || "").getTime();
  const end = new Date(endValue || "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "--";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${minutes} 分 ${remaining} 秒` : `${minutes} 分钟`;
}

function renderSessionRuntimeControls(session) {
  const disabled = !session || state.sendingMessage || state.savingSessionRuntime;
  els.sessionModelInput.disabled = disabled;
  els.sessionEffortInput.disabled = disabled;
  els.sessionStreamInput.disabled = disabled;
  const renderKey = session ? [
    sessionKey(session),
    session.model || "",
    session.effort || "",
    typeof session.streamReplies === "boolean" ? String(session.streamReplies) : "inherit",
    state.config?.model || "",
    state.config?.effort || "",
    String(Boolean(state.config?.streamReplies)),
    state.codexRuntime?.model || "",
    state.codexRuntime?.effort || "",
    state.codexModels.length
  ].join("|") : "none";
  if (els.sessionRuntimeToolbar.dataset.renderKey === renderKey) return;
  els.sessionRuntimeToolbar.dataset.renderKey = renderKey;

  if (!session) {
    els.sessionModelInput.innerHTML = '<option value="">选择会话后设置</option>';
    els.sessionEffortInput.innerHTML = '<option value="">选择会话后设置</option>';
    els.sessionStreamInput.innerHTML = '<option value="">选择会话后设置</option>';
    return;
  }

  const inheritedModel = state.config?.model || state.codexRuntime?.model || "";
  const models = Array.isArray(state.codexModels) ? state.codexModels : [];
  const options = [{
    value: "",
    label: inheritedModel ? `继承全局（${inheritedModel}）` : "继承全局设置"
  }, ...models.map((model) => ({
    value: model.model,
    label: model.displayName && model.displayName !== model.model
      ? `${model.displayName} · ${model.model}`
      : model.model,
    title: model.description || ""
  }))];
  if (session.model && !options.some((option) => option.value === session.model)) {
    options.push({ value: session.model, label: `${session.model}（当前会话）`, title: "" });
  }
  els.sessionModelInput.innerHTML = options.map((option) => `<option value="${escapeAttr(option.value)}"${option.title ? ` title="${escapeAttr(option.title)}"` : ""}>${escapeHtml(option.label)}</option>`).join("");
  els.sessionModelInput.value = session.model || "";
  setSessionEffortOptions(session.model || "", session.effort || "");
  els.sessionStreamInput.innerHTML = [
    `<option value="">继承全局（${state.config?.streamReplies ? "开启" : "关闭"}）</option>`,
    '<option value="on">开启</option>',
    '<option value="off">关闭</option>'
  ].join("");
  els.sessionStreamInput.value = typeof session.streamReplies === "boolean"
    ? session.streamReplies ? "on" : "off"
    : "";
}

function setSessionEffortOptions(modelOverride, preferredEffort) {
  const effectiveModel = modelOverride || state.config?.model || state.codexRuntime?.model || "";
  const model = state.codexModels.find((candidate) => candidate.model === effectiveModel);
  const advertised = model?.supportedEfforts?.length
    ? model.supportedEfforts
    : state.codexModels.flatMap((candidate) => candidate.supportedEfforts || []);
  const efforts = [...new Map(advertised.map((option) => [option.effort, option])).values()]
    .sort((a, b) => effortRank(a.effort) - effortRank(b.effort));
  if (preferredEffort && !efforts.some((option) => option.effort === preferredEffort)) {
    efforts.push({ effort: preferredEffort, description: "当前会话" });
  }
  const inheritedEffort = state.config?.effort || state.codexRuntime?.effort || model?.defaultEffort;
  const inheritedLabel = inheritedEffort
    ? `继承全局（${effortInlineName(inheritedEffort)}）`
    : "继承全局设置";
  els.sessionEffortInput.innerHTML = [
    `<option value="">${escapeHtml(inheritedLabel)}</option>`,
    ...efforts.map((option) => `<option value="${escapeAttr(option.effort)}"${option.description ? ` title="${escapeAttr(option.description)}"` : ""}>${escapeHtml(effortDisplayName(option.effort))}</option>`)
  ].join("");
  els.sessionEffortInput.value = preferredEffort;
}

async function handleSessionModelChange() {
  const modelValue = els.sessionModelInput.value;
  const model = state.codexModels.find((candidate) => candidate.model === (modelValue || state.config?.model || state.codexRuntime?.model));
  const efforts = model?.supportedEfforts?.map((option) => option.effort) || [];
  let effortValue = els.sessionEffortInput.value;
  const inheritedEffort = state.config?.effort || state.codexRuntime?.effort || "";
  const effectiveEffort = effortValue || inheritedEffort;
  if (effectiveEffort && efforts.length && !efforts.includes(effectiveEffort)) {
    effortValue = efforts.includes(model?.defaultEffort) ? model.defaultEffort : efforts[0] || "";
  }
  setSessionEffortOptions(modelValue, effortValue);
  await saveSessionRuntimeSettings();
}

async function saveSessionRuntimeSettings() {
  const session = selectedSession();
  if (!session || state.savingSessionRuntime) return;
  const key = sessionKey(session);
  const model = els.sessionModelInput.value;
  const effort = els.sessionEffortInput.value;
  const stream = els.sessionStreamInput.value;
  state.savingSessionRuntime = true;
  renderChatPanel();
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.accountId)}/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      body: {
        model: model || null,
        effort: effort || null,
        streamReplies: stream ? stream === "on" : null
      }
    });
    const index = state.sessions.findIndex((candidate) => sessionKey(candidate) === key);
    if (index >= 0) state.sessions[index] = result.session;
    els.sessionRuntimeToolbar.dataset.renderKey = "";
    renderSessions();
    toast("会话设置已更新");
  } catch (error) {
    toast(error.message, true);
    await refreshData(false);
  } finally {
    state.savingSessionRuntime = false;
    renderChatPanel();
  }
}

function renderTypingIndicator() {
  return `<div class="chat-typing" role="status" aria-label="对方正在输入">
    <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>对方正在输入…</span>
  </div>`;
}

function setChatMessagesHtml(html, renderKey) {
  if (els.chatMessages.dataset.renderKey === renderKey) return;
  els.chatMessages.innerHTML = html;
  els.chatMessages.dataset.renderKey = renderKey;
  drawIcons();
}

function renderMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  return `<div class="message-attachments">${attachments.map((attachment) => {
    const name = escapeHtml(attachment.name || "附件");
    const url = attachment.url ? escapeAttr(attachment.url) : "";
    const pending = Boolean(attachment.pending);
    const available = Boolean(attachment.available && url);
    const icon = attachment.type === "video" ? "file-video" : attachment.type === "image" ? "image" : "file";
    let preview = "";
    if (available && attachment.type === "video") {
      preview = `<video controls playsinline preload="metadata" src="${url}" aria-label="视频：${escapeAttr(attachment.name || "附件")}"></video>`;
    } else if (available && attachment.type === "image") {
      preview = `<img loading="lazy" src="${url}" alt="${escapeAttr(attachment.name || "图片附件")}">`;
    }
    return `<div class="message-attachment is-${escapeAttr(attachment.type || "file")}${available || pending ? "" : " is-missing"}">
      ${preview}
      <div class="attachment-meta">
        <span class="attachment-type-icon"><i data-lucide="${icon}"></i></span>
        <span class="attachment-copy"><strong title="${escapeAttr(attachment.name || "附件")}">${name}</strong><small>${pending ? "正在上传" : available ? formatBytes(attachment.size) : "文件已移动或删除"}</small></span>
        ${available ? `<a class="icon-button attachment-download" href="${url}?download=1" download="${escapeAttr(attachment.name || "attachment")}" title="下载附件" aria-label="下载 ${escapeAttr(attachment.name || "附件")}"><i data-lucide="download"></i></a>` : ""}
      </div>
    </div>`;
  }).join("")}</div>`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "本机文件";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function sendSessionMessage(event) {
  event.preventDefault();
  const session = selectedSession();
  const text = els.chatInput.value.trim();
  const files = [...state.chatFiles];
  if (!session || (!text && !files.length) || state.sendingMessage) return;
  const key = sessionKey(session);
  const streaming = session.streamReplies ?? Boolean(state.config?.streamReplies);
  let progressSequence = 0;
  state.sendingMessage = true;
  state.sessionMessages.push({
    id: `pending-${Date.now()}`,
    role: "user",
    text,
    createdAt: new Date().toISOString(),
    attachments: files.map((file, index) => ({
      index,
      type: fileKind(file),
      name: file.name,
      size: file.size,
      pending: true
    }))
  });
  els.chatInput.value = "";
  state.chatFiles = [];
  renderChatPanel();
  scrollChatToEnd();
  try {
    const body = new FormData();
    body.append("text", text);
    files.forEach((file) => body.append("files", file, file.name));
    const url = `/api/sessions/${encodeURIComponent(session.accountId)}/${encodeURIComponent(session.id)}/messages`;
    if (streaming) {
      await streamApi(`${url}?stream=1`, { method: "POST", body }, (streamEvent) => {
        if (state.selectedSessionKey !== key) return;
        if (streamEvent.type === "progress" && streamEvent.message?.trim()) {
          state.sessionMessages.push({
            id: `progress-${Date.now()}-${progressSequence++}`,
            role: "assistant",
            text: streamEvent.message.trim(),
            kind: "progress",
            createdAt: new Date().toISOString(),
            attachments: []
          });
          scheduleStreamingRender();
        }
        if (streamEvent.type === "done" && streamEvent.result?.message) {
          state.sessionMessages.push(streamEvent.result.message);
          scheduleStreamingRender();
        }
      });
    } else {
      await api(url, { method: "POST", body });
    }
    await refreshData(false);
    if (state.selectedSessionKey === key) {
      await loadSelectedSessionMessages();
    }
  } catch (error) {
    toast(error.message, true);
    if (state.selectedSessionKey === key) {
      els.chatInput.value = text;
      state.chatFiles = files;
      await loadSelectedSessionMessages();
    }
  } finally {
    state.sendingMessage = false;
    renderChatPanel();
    els.chatInput.focus();
  }
}

function scheduleStreamingRender() {
  if (streamingRenderFrame) return;
  streamingRenderFrame = requestAnimationFrame(() => {
    streamingRenderFrame = 0;
    renderChatPanel();
    scrollChatToEnd();
  });
}

function handleChatFileSelection(event) {
  const nextFiles = [...event.target.files];
  event.target.value = "";
  if (!nextFiles.length) return;
  const combined = [...state.chatFiles, ...nextFiles];
  if (combined.length > MAX_CHAT_FILES) {
    toast(`一次最多添加 ${MAX_CHAT_FILES} 个文件`, true);
    return;
  }
  const totalBytes = combined.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_CHAT_FILE_BYTES) {
    toast("单次附件总大小不能超过 100 MiB", true);
    return;
  }
  state.chatFiles = combined;
  renderComposerFiles();
  updateComposerState();
}

function handleComposerFileAction(event) {
  const button = event.target.closest("[data-remove-chat-file]");
  if (!button || state.sendingMessage) return;
  state.chatFiles.splice(Number(button.dataset.removeChatFile), 1);
  renderComposerFiles();
  updateComposerState();
}

function renderComposerFiles() {
  els.composerFiles.hidden = state.chatFiles.length === 0;
  els.composerFiles.innerHTML = state.chatFiles.map((file, index) => `<div class="composer-file">
    <i data-lucide="${fileKind(file) === "image" ? "image" : fileKind(file) === "video" ? "file-video" : "file"}"></i>
    <span class="composer-file-copy"><strong title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></span>
    <button class="icon-button composer-file-remove" type="button" data-remove-chat-file="${index}" title="移除附件" aria-label="移除 ${escapeAttr(file.name)}"><i data-lucide="x"></i></button>
  </div>`).join("");
  drawIcons();
}

function updateComposerState() {
  const canCompose = Boolean(selectedSession()) && !state.sendingMessage && !state.savingSessionRuntime;
  els.chatInput.disabled = !canCompose;
  els.chatAttachButton.disabled = !canCompose;
  els.chatFileInput.disabled = !canCompose;
  els.chatSendButton.disabled = !canCompose || (!els.chatInput.value.trim() && !state.chatFiles.length);
}

function resetComposer() {
  state.chatFiles = [];
  if (els.chatInput) els.chatInput.value = "";
  if (els.chatFileInput) els.chatFileInput.value = "";
  if (els.composerFiles) renderComposerFiles();
}

function fileKind(file) {
  if (file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(file.name)) return "image";
  if (file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name)) return "video";
  return "file";
}

function handleChatInputKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  els.chatComposer.requestSubmit();
}

function selectedSession() {
  return state.sessions.find((session) => sessionKey(session) === state.selectedSessionKey);
}

function sessionKey(session) {
  return `${session.accountId}\n${session.id}`;
}

function emptyChatState(icon, title, description = "") {
  return `<div class="chat-empty"><span><i data-lucide="${escapeAttr(icon)}"></i></span><strong>${escapeHtml(title)}</strong>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div>`;
}

function scrollChatToEnd() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    });
  });
}

async function beginLogin() {
  stopLoginPoll();
  els.qrFrame.innerHTML = `<div class="spinner" aria-label="正在生成二维码"></div>`;
  setQrStatus("正在生成二维码");
  if (!els.qrDialog.open) els.qrDialog.showModal();
  drawIcons();
  try {
    const login = await api("/api/logins", { method: "POST" });
    els.qrFrame.innerHTML = `<img src="${escapeAttr(login.qrDataUrl)}" alt="微信登录二维码">`;
    setQrStatus("等待微信扫码");
    state.loginPoll = window.setInterval(() => void pollLogin(login.id), 1800);
  } catch (error) {
    setQrStatus(error.message, "error");
  }
}

async function pollLogin(id) {
  try {
    const result = await api(`/api/logins/${encodeURIComponent(id)}`, { token: false });
    if (result.status === "waiting") setQrStatus("等待微信扫码");
    if (result.status === "scanned") setQrStatus("已扫码，请在微信中确认");
    if (result.status === "expired") {
      stopLoginPoll();
      setQrStatus("二维码已过期", "error");
    }
    if (result.status === "confirmed") {
      stopLoginPoll();
      setQrStatus("账号已连接", "success");
      await refreshData(false);
      window.setTimeout(() => els.qrDialog.close(), 900);
    }
  } catch (error) {
    stopLoginPoll();
    setQrStatus(error.message, "error");
  }
}

function stopLoginPoll() {
  if (state.loginPoll) window.clearInterval(state.loginPoll);
  state.loginPoll = null;
}

function setQrStatus(text, kind = "") {
  els.qrStatus.textContent = text;
  els.qrStatus.className = `qr-status${kind ? ` is-${kind}` : ""}`;
}

function openNewSessionDialog() {
  const options = state.accounts.flatMap((account) => {
    const sender = account.lastActiveSenderId && account.pairedSenderIds.includes(account.lastActiveSenderId)
      ? account.lastActiveSenderId
      : account.pairedSenderIds[0];
    return sender ? [{ account, sender }] : [];
  });
  if (!options.length) {
    toast("请先在微信发送消息，并在账号页允许该联系人", true);
    showView("accounts");
    return;
  }
  document.querySelector("#sessionDialogTitle").textContent = "新建会话";
  document.querySelector("#editingSessionId").value = "";
  document.querySelector("#editingAccountId").value = "";
  document.querySelector("#senderField").hidden = false;
  document.querySelector("#sessionWorkspaceField").hidden = false;
  const senderInput = document.querySelector("#sessionSenderInput");
  senderInput.innerHTML = options.map(({ account, sender }) => `<option value="${escapeAttr(`${account.accountId}\n${sender}`)}">${escapeHtml(accountDisplayName(account.accountId))}</option>`).join("");
  const selectedOption = options.find(({ account }) => account.accountId === state.selectedAccountId) ?? options[0];
  senderInput.value = `${selectedOption.account.accountId}\n${selectedOption.sender}`;
  updateNewSessionDefaultTitle();
  document.querySelector("#sessionWorkspaceInput").value = state.config.defaultCwd;
  els.sessionDialog.showModal();
  document.querySelector("#sessionTitleInput").focus();
}

function updateNewSessionDefaultTitle() {
  if (document.querySelector("#editingSessionId").value) return;
  const [accountId] = document.querySelector("#sessionSenderInput").value.split("\n");
  const accountSessionCount = state.sessions.filter((session) => session.accountId === accountId).length;
  document.querySelector("#sessionTitleInput").value = `会话 ${accountSessionCount + 1}`;
}

function openRenameSessionDialog(session) {
  document.querySelector("#sessionDialogTitle").textContent = "重命名会话";
  document.querySelector("#editingSessionId").value = session.id;
  document.querySelector("#editingAccountId").value = session.accountId;
  document.querySelector("#senderField").hidden = true;
  document.querySelector("#sessionWorkspaceField").hidden = true;
  document.querySelector("#sessionTitleInput").value = session.title;
  els.sessionDialog.showModal();
  document.querySelector("#sessionTitleInput").select();
}

async function saveSession(event) {
  event.preventDefault();
  const title = document.querySelector("#sessionTitleInput").value.trim();
  const sessionId = document.querySelector("#editingSessionId").value;
  try {
    if (sessionId) {
      const accountId = document.querySelector("#editingAccountId").value;
      await api(`/api/sessions/${encodeURIComponent(accountId)}/${encodeURIComponent(sessionId)}`, { method: "PATCH", body: { title } });
    } else {
      const [accountId, senderId] = document.querySelector("#sessionSenderInput").value.split("\n");
      const created = await api("/api/sessions", { method: "POST", body: { accountId, senderId, title, workspace: document.querySelector("#sessionWorkspaceInput").value.trim() } });
      state.selectedAccountId = accountId;
      state.selectedSessionKey = sessionKey(created.session);
      state.sessionMessages = [];
      state.loadedSessionKey = "";
    }
    els.sessionDialog.close();
    await refreshData(false);
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const button = event.submitter;
  try {
    button.disabled = true;
    const result = await api("/api/config", {
      method: "PUT",
      body: {
        defaultCwd: document.querySelector("#defaultCwdInput").value.trim(),
        allowedWorkspaces: document.querySelector("#allowedWorkspacesInput").value.split("\n").map((line) => line.trim()).filter(Boolean),
        codexBackend: document.querySelector("#backendInput").value,
        codexExecSandbox: document.querySelector("#sandboxInput").value || null,
        model: document.querySelector("#modelInput").value.trim(),
        effort: document.querySelector("#effortInput").value.trim(),
        streamReplies: document.querySelector("#streamRepliesInput").checked
      }
    });
    state.config = result.config;
    state.codexRuntime = result.codexRuntime;
    state.codexModels = result.codexModels || state.codexModels;
    renderAll();
    toast("设置已保存");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function showView(name, updateHash = true) {
  const valid = ["accounts", "sessions", "usage", "settings"].includes(name) ? name : "accounts";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const visible = panel.dataset.viewPanel === valid;
    panel.hidden = !visible;
    panel.classList.toggle("is-visible", visible);
  });
  document.querySelectorAll(".tab[data-view]").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === valid));
  if (updateHash && location.hash !== `#${valid}`) history.replaceState(null, "", `#${valid}`);
}

function closeDialog(id) {
  document.querySelector(`#${CSS.escape(id)}`)?.close();
}

async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = { ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}) };
  if (options.token !== false && state.requestToken) headers["X-Codex-Weixin-Token"] = state.requestToken;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? (isFormData ? options.body : JSON.stringify(options.body)) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

async function streamApi(url, options, onEvent) {
  const headers = {};
  if (state.requestToken) headers["X-Codex-Weixin-Token"] = state.requestToken;
  const response = await fetch(url, {
    method: options.method || "POST",
    headers,
    body: options.body
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("application/x-ndjson")) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data.result;
  }
  if (!response.ok || !response.body) {
    throw new Error(`请求失败 (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result;
  const consumeLine = (line) => {
    if (!line.trim()) return;
    const streamEvent = JSON.parse(line);
    if (streamEvent.type === "error") throw new Error(streamEvent.error || "过程进度失败");
    onEvent(streamEvent);
    if (streamEvent.type === "done") result = streamEvent.result;
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer) consumeLine(buffer);
  return result;
}

function emptyState(icon, title, description = "", action = "") {
  return `<div class="empty-state"><div class="empty-state-inner"><span class="empty-icon"><i data-lucide="${escapeAttr(icon)}"></i></span><h2>${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}${action}</div></div>`;
}

function accountDisplayName(accountId) {
  const account = state.accounts.find((item) => item.accountId === accountId);
  const index = state.accounts.findIndex((item) => item.accountId === accountId);
  return account?.displayName || `微信账号 ${index >= 0 ? index + 1 : ""}`.trim();
}

function statusText(status) {
  return ({ running: "运行中", starting: "启动中", stopped: "已停止", error: "异常" })[status] || status;
}

function shortId(value) {
  if (!value || value.length <= 26) return value || "--";
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function handleUsageFilterChange() {
  state.usageAccountFilter = els.usageAccountFilter.value;
  state.usageSessionFilter = els.usageSessionFilter.value;
  state.usageSort = els.usageSortFilter.value;
  state.usageSessionPage = 1;
  state.usageRecentPage = 1;
  renderUsage();
  drawIcons();
}

function handleUsagePageSizeChange() {
  state.usagePageSize = Math.max(1, Number(els.usagePageSize.value) || 10);
  state.usageSessionPage = 1;
  state.usageRecentPage = 1;
  renderUsage();
}

function resetUsageFilters() {
  state.usageAccountFilter = "";
  state.usageSessionFilter = "";
  state.usageSort = "total";
  state.usagePageSize = 10;
  state.usageSessionPage = 1;
  state.usageRecentPage = 1;
  renderUsage();
  drawIcons();
}

function handleUsagePagination(event) {
  const button = event.target.closest("button[data-usage-page]");
  if (!button || button.disabled) return;
  const page = Number(button.dataset.usagePage);
  if (!Number.isInteger(page) || page < 1) return;
  if (button.closest("#usageSessionPagination")) state.usageSessionPage = page;
  if (button.closest("#usageRecentPagination")) state.usageRecentPage = page;
  renderUsage();
}

function renderUsage() {
  const allUsageSessions = state.sessions
    .filter((session) => session.tokenUsage && (session.tokenUsage.totalTokens || 0) > 0);
  renderUsageFilters(allUsageSessions);
  const sessions = filterUsageSessions(allUsageSessions);
  const totals = sessions.reduce((sum, session) => {
    const usage = session.tokenUsage;
    sum.inputTokens += usage.inputTokens || 0;
    sum.outputTokens += usage.outputTokens || 0;
    sum.totalTokens += usage.totalTokens || 0;
    sum.cachedInputTokens += usage.cachedInputTokens || 0;
    sum.turnCount += usage.turnCount || 0;
    return sum;
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, turnCount: 0 });
  const cacheRate = ratio(totals.cachedInputTokens, totals.inputTokens);
  const freshInputTokens = Math.max(0, totals.inputTokens - totals.cachedInputTokens);
  const records = sessions.flatMap((session) => (session.tokenUsageRecords || []).map((record, index) => ({
    ...record,
    session,
    key: `${session.id}-${record.at || index}-${index}`
  }))).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  els.usageTotal.textContent = formatTokenCount(totals.totalTokens);
  els.usageInput.textContent = formatTokenCount(totals.inputTokens);
  els.usageOutput.textContent = formatTokenCount(totals.outputTokens);
  els.usageCacheRate.textContent = totals.inputTokens > 0 ? formatPercent(cacheRate) : "--";
  els.usageCacheDetail.textContent = totals.inputTokens > 0
    ? `${formatTokenCount(totals.cachedInputTokens)} / ${formatTokenCount(totals.inputTokens)} Input`
    : "缓存输入 / 输入 Token";
  els.usageTurns.textContent = formatTokenCount(totals.turnCount);
  els.usageAvgTurn.textContent = `平均每轮 ${formatTokenCount(totals.turnCount ? totals.totalTokens / totals.turnCount : 0)} Token`;
  els.usageSortNote.textContent = `当前排序：${usageSortLabel(state.usageSort)} · ${sessions.length} 个会话`;

  renderUsageMix(totals, cacheRate, freshInputTokens);
  renderUsageTrend(records);
  els.usageEmpty.hidden = sessions.length > 0;
  renderUsageSessions(sessions);
  renderUsageRecent(records);
}

function renderUsageFilters(sessions) {
  const accountIds = [...new Set(sessions.map((session) => session.accountId))]
    .sort((a, b) => accountDisplayName(a).localeCompare(accountDisplayName(b), "zh-CN"));
  const selectedAccount = accountIds.includes(state.usageAccountFilter) ? state.usageAccountFilter : "";
  if (selectedAccount !== state.usageAccountFilter) {
    state.usageAccountFilter = selectedAccount;
    state.usageSessionFilter = "";
    state.usageSessionPage = 1;
    state.usageRecentPage = 1;
  }
  const sessionOptions = sessions
    .filter((session) => !selectedAccount || session.accountId === selectedAccount)
    .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  const sessionIds = new Set(sessionOptions.map((session) => session.id));
  if (state.usageSessionFilter && !sessionIds.has(state.usageSessionFilter)) {
    state.usageSessionFilter = "";
    state.usageSessionPage = 1;
    state.usageRecentPage = 1;
  }
  setUsageSelectOptions(els.usageAccountFilter, [
    ["", "全部账号"],
    ...accountIds.map((accountId) => [accountId, accountDisplayName(accountId)])
  ], state.usageAccountFilter);
  setUsageSelectOptions(els.usageSessionFilter, [
    ["", "全部会话"],
    ...sessionOptions.map((session) => [session.id, `${session.title} · ${accountDisplayName(session.accountId)}`])
  ], state.usageSessionFilter);
  if (!usageSortValues().some(([value]) => value === state.usageSort)) state.usageSort = "total";
  els.usageSortFilter.value = state.usageSort;
  els.usagePageSize.value = String(state.usagePageSize);
}

function setUsageSelectOptions(select, options, value) {
  const key = options.map(([optionValue, label]) => `${optionValue}:${label}`).join("|");
  if (select.dataset.optionsKey !== key) {
    select.innerHTML = options.map(([optionValue, label]) => `<option value="${escapeAttr(optionValue)}">${escapeHtml(label)}</option>`).join("");
    select.dataset.optionsKey = key;
  }
  select.value = options.some(([optionValue]) => optionValue === value) ? value : options[0]?.[0] || "";
}

function filterUsageSessions(sessions) {
  return sessions
    .filter((session) => !state.usageAccountFilter || session.accountId === state.usageAccountFilter)
    .filter((session) => !state.usageSessionFilter || session.id === state.usageSessionFilter)
    .sort((a, b) => compareUsageSessions(a, b, state.usageSort));
}

function compareUsageSessions(a, b, sort) {
  const aUsage = a.tokenUsage || {};
  const bUsage = b.tokenUsage || {};
  if (sort === "input") return (bUsage.inputTokens || 0) - (aUsage.inputTokens || 0);
  if (sort === "output") return (bUsage.outputTokens || 0) - (aUsage.outputTokens || 0);
  if (sort === "cache") return ratio(bUsage.cachedInputTokens || 0, bUsage.inputTokens || 0) - ratio(aUsage.cachedInputTokens || 0, aUsage.inputTokens || 0);
  if (sort === "recent") return String(bUsage.lastUsedAt || b.updatedAt).localeCompare(String(aUsage.lastUsedAt || a.updatedAt));
  return (bUsage.totalTokens || 0) - (aUsage.totalTokens || 0);
}

function usageSortValues() {
  return [["total", "累计 Token"], ["input", "Input Token"], ["output", "Output Token"], ["cache", "Cache Hit Rate"], ["recent", "最近使用"]];
}

function usageSortLabel(value) {
  return usageSortValues().find(([sort]) => sort === value)?.[1] || "累计 Token";
}

function renderUsageMix(totals, cacheRate, freshInputTokens) {
  const cachePercent = Math.max(0, Math.min(100, cacheRate * 100));
  const freshPercent = (100 - cachePercent).toFixed(2);
  els.usageMix.innerHTML = `<div class="usage-donut" aria-label="缓存输入命中率 ${formatPercent(cacheRate)}">
    <svg class="usage-donut-svg" viewBox="0 0 100 100" aria-hidden="true"><circle class="usage-donut-track" cx="50" cy="50" r="38" pathLength="100"></circle><circle class="usage-donut-cache" cx="50" cy="50" r="38" pathLength="100" stroke-dasharray="${cachePercent.toFixed(2)} ${freshPercent}"></circle></svg>
    <div class="usage-donut-center"><strong>${totals.inputTokens > 0 ? formatPercent(cacheRate) : "--"}</strong><span>缓存命中</span></div>
  </div>`;
  els.usageMixStats.innerHTML = `<div class="usage-mix-stat usage-mix-stat-cache"><i></i><span>缓存输入</span><strong>${formatTokenCount(totals.cachedInputTokens)}</strong></div>
    <div class="usage-mix-stat usage-mix-stat-fresh"><i></i><span>未缓存输入</span><strong>${formatTokenCount(freshInputTokens)}</strong></div>
    <div class="usage-mix-stat usage-mix-stat-output"><i></i><span>Output Token</span><strong>${formatTokenCount(totals.outputTokens)}</strong></div>`;
}

function renderUsageTrend(records) {
  const buckets = new Map();
  records.forEach((record) => {
    const date = new Date(record.at);
    if (Number.isNaN(date.getTime())) return;
    const key = date.toISOString().slice(0, 10);
    const bucket = buckets.get(key) || { date, input: 0, output: 0, cached: 0, turns: 0 };
    bucket.input += Number(record.inputTokens) || 0;
    bucket.output += Number(record.outputTokens) || 0;
    bucket.cached += Number(record.cachedInputTokens) || 0;
    bucket.turns += 1;
    buckets.set(key, bucket);
  });
  const points = [...buckets.values()].sort((a, b) => a.date - b.date).slice(-14);
  els.usageTrendEmpty.hidden = points.length > 0;
  if (!points.length) {
    els.usageTrend.innerHTML = "";
    return;
  }
  const width = 760;
  const height = 228;
  const plot = { left: 35, right: 12, top: 16, bottom: 30 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const max = Math.max(...points.flatMap((point) => [point.input, point.output]), 1);
  const x = (index) => points.length === 1 ? plot.left + plotWidth / 2 : plot.left + index * plotWidth / (points.length - 1);
  const y = (value) => plot.top + plotHeight - value / max * plotHeight;
  const inputPath = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.input).toFixed(1)}`).join(" ");
  const outputPath = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.output).toFixed(1)}`).join(" ");
  const cachedPath = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.cached).toFixed(1)}`).join(" ");
  const inputArea = `${inputPath} L${x(points.length - 1).toFixed(1)},${(plot.top + plotHeight).toFixed(1)} L${x(0).toFixed(1)},${(plot.top + plotHeight).toFixed(1)} Z`;
  const outputArea = `${outputPath} L${x(points.length - 1).toFixed(1)},${(plot.top + plotHeight).toFixed(1)} L${x(0).toFixed(1)},${(plot.top + plotHeight).toFixed(1)} Z`;
  const grid = [0, .5, 1].map((step) => {
    const lineY = plot.top + plotHeight * step;
    const label = formatTokenCount(max * (1 - step));
    return `<line class="usage-trend-grid" x1="${plot.left}" x2="${width - plot.right}" y1="${lineY}" y2="${lineY}"></line><text class="usage-trend-axis" x="0" y="${lineY + 3}">${escapeHtml(label)}</text>`;
  }).join("");
  const labels = points.map((point, index) => {
    if (points.length > 5 && index !== 0 && index !== points.length - 1 && index !== Math.floor((points.length - 1) / 2)) return "";
    return `<text class="usage-trend-axis" text-anchor="${index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}" x="${x(index)}" y="${height - 7}">${escapeHtml(formatTrendDate(point.date))}</text>`;
  }).join("");
  const pointMarkup = (key, className, label) => points.map((point, index) => `<circle class="${className}" cx="${x(index).toFixed(1)}" cy="${y(point[key]).toFixed(1)}" r="3"><title>${escapeHtml(formatTrendDate(point.date))} · ${label} ${formatExactTokenCount(point[key])} Token · ${point.turns} 轮</title></circle>`).join("");
  els.usageTrend.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="usageInputFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#12a150" stop-opacity=".18"></stop><stop offset="1" stop-color="#12a150" stop-opacity="0"></stop></linearGradient><linearGradient id="usageOutputFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#146bd1" stop-opacity=".14"></stop><stop offset="1" stop-color="#146bd1" stop-opacity="0"></stop></linearGradient></defs>
    ${grid}<path class="usage-trend-area-input" d="${inputArea}"></path><path class="usage-trend-area-output" d="${outputArea}"></path><path class="usage-trend-line-input" d="${inputPath}"></path><path class="usage-trend-line-output" d="${outputPath}"></path><path class="usage-trend-line-cache" d="${cachedPath}"></path>${pointMarkup("input", "usage-trend-point-input", "Input")}${pointMarkup("output", "usage-trend-point-output", "Output")}${pointMarkup("cached", "usage-trend-point-cache", "Cache")}${labels}
  </svg>`;
}

function renderUsageSessions(sessions) {
  const pageData = paginateUsageItems(sessions, state.usageSessionPage, state.usagePageSize);
  state.usageSessionPage = pageData.page;
  if (!sessions.length) {
    els.usageChart.innerHTML = "";
    els.usageEmpty.textContent = allUsageFiltersEmpty() ? "暂无 Token 使用记录，完成一次 Codex 请求后会显示统计数据。" : "没有符合当前筛选条件的会话。";
    renderUsagePagination(els.usageSessionPagination, 1, 0, 0, "usageSessionPage");
    return;
  }
  els.usageChart.innerHTML = pageData.items.map((session) => {
    const usage = session.tokenUsage;
    const total = usage.totalTokens || 0;
    const cached = Math.min(usage.cachedInputTokens || 0, usage.inputTokens || 0);
    const fresh = Math.max(0, (usage.inputTokens || 0) - cached);
    const scale = Math.max(total, fresh + cached + (usage.outputTokens || 0), 1);
    const freshWidth = fresh / scale * 100;
    const cacheWidth = cached / scale * 100;
    const outputWidth = (usage.outputTokens || 0) / scale * 100;
    const cacheRate = ratio(cached, usage.inputTokens || 0);
    return `<div class="usage-row">
      <div class="usage-row-label"><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(accountDisplayName(session.accountId))} · ${usage.turnCount || 0} 轮</small></div>
      <div class="usage-bar" aria-label="${escapeAttr(session.title)}：${formatExactTokenCount(total)} Token">
        <svg class="usage-bar-svg" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true"><rect class="usage-bar-input" x="0" y="0" width="${freshWidth.toFixed(2)}" height="18" fill="#16a05a"><title>Input（未缓存）${formatExactTokenCount(fresh)} Token</title></rect><rect class="usage-bar-cache" x="${freshWidth.toFixed(2)}" y="0" width="${cacheWidth.toFixed(2)}" height="18" fill="#db9a1b"><title>Cached ${formatExactTokenCount(cached)} Token</title></rect><rect class="usage-bar-output" x="${(freshWidth + cacheWidth).toFixed(2)}" y="0" width="${outputWidth.toFixed(2)}" height="18" fill="#2879d8"><title>Output ${formatExactTokenCount(usage.outputTokens || 0)} Token</title></rect></svg>
      </div>
      <strong class="usage-row-total">${formatTokenCount(total)}</strong>
      <small class="usage-row-meta">Input ${formatExactTokenCount(usage.inputTokens || 0)} · Cached ${formatExactTokenCount(cached)} · Output ${formatExactTokenCount(usage.outputTokens || 0)} · Hit ${formatPercent(cacheRate)}</small>
    </div>`;
  }).join("");
  renderUsagePagination(els.usageSessionPagination, pageData.page, pageData.pageCount, pageData.total, "usageSessionPage");
}

function renderUsageRecent(records) {
  const pageData = paginateUsageItems(records, state.usageRecentPage, state.usagePageSize);
  state.usageRecentPage = pageData.page;
  const recent = pageData.items;
  els.usageRecentEmpty.hidden = recent.length > 0;
  els.usageRecentCount.textContent = records.length ? `第 ${pageData.start}-${pageData.end} 条 / 共 ${records.length} 条记录` : "0 条记录";
  if (!recent.length) {
    els.usageRecent.innerHTML = "";
    els.usageRecentEmpty.textContent = records.length ? "当前页没有请求记录。" : (allUsageFiltersEmpty() ? "暂无请求记录。" : "没有符合当前筛选条件的请求。");
    renderUsagePagination(els.usageRecentPagination, 1, 0, 0, "usageRecentPage");
    return;
  }
  els.usageRecent.innerHTML = `<div class="usage-recent-head" role="row"><span>会话</span><span>Input</span><span>Output</span><span>Cache hit</span><span>时间</span></div>${recent.map((record) => {
    const cacheRate = ratio(record.cachedInputTokens || 0, record.inputTokens || 0);
    return `<div class="usage-recent-row" role="row"><div class="usage-recent-session"><strong>${escapeHtml(record.session.title)}</strong><small>${escapeHtml(accountDisplayName(record.session.accountId))}</small></div><span class="usage-recent-number">${formatExactTokenCount(record.inputTokens || 0)}</span><span class="usage-recent-number">${formatExactTokenCount(record.outputTokens || 0)}</span><span class="usage-recent-cache">${record.inputTokens ? formatPercent(cacheRate) : "--"}</span><span class="usage-recent-number">${escapeHtml(relativeTime(record.at))}</span></div>`;
  }).join("")}`;
  renderUsagePagination(els.usageRecentPagination, pageData.page, pageData.pageCount, pageData.total, "usageRecentPage");
}

function paginateUsageItems(items, page, pageSize) {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const startIndex = total ? (currentPage - 1) * pageSize : 0;
  return {
    items: items.slice(startIndex, startIndex + pageSize),
    page: currentPage,
    pageCount: total ? pageCount : 0,
    total,
    start: total ? startIndex + 1 : 0,
    end: Math.min(startIndex + pageSize, total)
  };
}

function renderUsagePagination(container, page, pageCount, total, target) {
  if (!total || pageCount <= 1) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<button class="icon-button usage-page-button" type="button" data-usage-page="${page - 1}" aria-label="上一页" ${page <= 1 ? "disabled" : ""}><i data-lucide="chevron-left"></i></button><span class="usage-page-status">第 <strong>${page}</strong> / ${pageCount} 页 <small>共 ${total} 条</small></span><button class="icon-button usage-page-button" type="button" data-usage-page="${page + 1}" aria-label="下一页" ${page >= pageCount ? "disabled" : ""}><i data-lucide="chevron-right"></i></button>`;
  container.dataset.target = target;
  drawIcons();
}

function allUsageFiltersEmpty() {
  return !state.usageAccountFilter && !state.usageSessionFilter;
}

function ratio(numerator, denominator) {
  const top = Number(numerator) || 0;
  const bottom = Number(denominator) || 0;
  return bottom > 0 ? Math.max(0, Math.min(1, top / bottom)) : 0;
}

function formatPercent(value) {
  return `${(Math.max(0, Math.min(1, Number(value) || 0)) * 100).toFixed(1)}%`;
}

function formatTrendDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(number);
}

function formatExactTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("zh-CN").format(number);
}

function messageTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " is-error" : ""}`;
  node.textContent = message;
  document.querySelector("#toastRegion").append(node);
  window.setTimeout(() => node.remove(), 3800);
}

function drawIcons() {
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}

function renderMarkdown(value) {
  const source = String(value ?? "");
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
    return escapeHtml(source).replace(/\n/g, "<br>");
  }
  const rendered = window.marked.parse(source, { gfm: true, breaks: true });
  const clean = window.DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "img"],
    FORBID_ATTR: ["style"]
  });
  const template = document.createElement("template");
  template.innerHTML = clean;
  template.content.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noreferrer noopener";
  });
  return template.innerHTML;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
