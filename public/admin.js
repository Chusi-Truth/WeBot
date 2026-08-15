const app = {
  state: null,
  selectedUserId: "",
  selectedAgentId: "",
  historyMessages: [],
  historyAgentName: "Agent",
  historyDownloadUrl: "",
  summarySnapshots: [],
  summaryHistoryCompressionCount: 0,
  summaryHistoryKey: "",
  summaryHistoryRequestSequence: 0,
  episodeArchive: [],
  episodeArchiveMajorEvents: [],
  episodeArchiveMeta: null,
  episodeArchiveKey: "",
  episodeArchiveRequestSequence: 0,
  episodeArchiveDialogSession: 0,
  episodeArchivePollTimer: 0,
  promptTraces: [],
  selectedTraceId: "",
  traceUserId: "",
  traceAgentId: "",
  personaDraft: null,
  personaDraftAgentId: "",
  personaSourceUpdatedAt: "",
  personaSourceSnapshot: "",
  personaWorkingSnapshot: "",
  personaDraftTarget: "",
  personaBusy: false,
  personaRequestSequence: 0,
  agentSaving: false,
  writingStyleExamplesDraft: [],
  writingStyleExamplesAgentId: "",
  writingStyleExamplesSourceUpdatedAt: "",
  writingStyleExamplesSelectedIndex: -1,
  writingStyleExamplesSaving: false,
  writingExampleAiInstruction: "",
  writingExampleAiBusy: false,
  writingExampleAiRequestSequence: 0,
  writingExampleAiAgentId: "",
  writingExampleAiIndex: -1,
  writingExampleAiSourceText: "",
  writingExampleAiSourceUpdatedAt: "",
  writingExampleAiPreviewSequence: 0,
  writingExampleAiDraft: null,
  writingExampleAiSummary: "",
  writingExampleAiProviderId: "",
  writingExampleAiModel: "",
  writingExampleAiError: "",
  directorEventUserId: "",
  directorEventAgentId: "",
  directorEventSourceUpdatedAt: "",
  directorEventSourceSnapshot: "",
  directorEventDialogSession: 0,
  directorEventSaving: false,
  directorEventAiBusy: false,
  directorEventAiRequestSequence: 0,
  directorEventAiPreviewSequence: 0,
  directorEventAiWorkingSnapshot: "",
  directorEventAiDraft: null,
  directorEventAiSummary: "",
  directorEventAiProviderId: "",
  directorEventAiModel: "",
  directorEventAiError: "",
  storyBookUserId: "",
  storyBookAgentId: "",
  storyBookAgentUpdatedAt: "",
  storyBookUpdatedAt: "",
  storyBookStories: [],
  storyBookSelectedId: "",
  storyBookSourceSnapshot: "",
  storyBookDialogSession: 0,
  storyBookLoading: false,
  storyBookSaving: false,
  storyBookDeleting: false,
  storyBookAiBusy: false,
  storyBookAiRequestSequence: 0,
  storyBookAiWorkingSnapshot: "",
  storyBookAiDraft: null,
  storyBookAiSummary: "",
  storyBookAiProviderId: "",
  storyBookAiModel: "",
  storyBookAiError: "",
  autonomySnapshot: null,
  autonomySnapshotKey: "",
  autonomyBusyKeys: new Set(),
  autonomyRequestSequence: 0,
  weatherSnapshot: null,
  weatherSnapshotKey: "",
  weatherBusyKeys: new Set(),
  weatherRequestSequence: 0,
  imageBehaviorSavingKeys: new Set(),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const MAX_WRITING_STYLE_EXAMPLES = 20;
const MAX_WRITING_STYLE_EXAMPLE_TEXT = 8_000;
const MAX_WRITING_STYLE_EXAMPLES_TEXT = 48_000;
const IMAGE_BEHAVIOR_MODES = new Set(["off", "explicit", "natural"]);

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindGlobalActions();
  bindPersonaAssistant();
  bindWritingStyleExamples();
  bindDirectorEvent();
  bindStoryBook();
  void refreshState();
  $("#admin-logout")?.addEventListener("click", () => void logoutAdmin());
});

async function logoutAdmin() {
  const button = $("#admin-logout");
  button.disabled = true;
  try {
    await mutate("/api/auth/logout", "POST", {});
    location.replace("/admin");
  } catch {
    button.disabled = false;
  }
}

function bindTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => item.classList.remove("active"));
      $$(".tab").forEach((item) => item.setAttribute("aria-selected", "false"));
      $$(".panel").forEach((item) => {
        item.classList.remove("active");
        item.hidden = true;
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      const panel = $(`#panel-${tab.dataset.tab}`);
      panel.hidden = false;
      panel.classList.add("active");
    });
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const tabs = $$(".tab");
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
      event.preventDefault();
      next.focus();
      next.click();
    });
  });
}

function bindGlobalActions() {
  const agentDialog = $("#agent-dialog");
  const closeAgentDialog = () => {
    if (agentDialog.open) agentDialog.close();
  };
  $("#agent-dialog-close").addEventListener("click", closeAgentDialog);
  $("#agent-dialog-cancel").addEventListener("click", closeAgentDialog);
  agentDialog.addEventListener("click", (event) => {
    if (event.target === agentDialog) closeAgentDialog();
  });
  agentDialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeAgentDialog();
  });
  agentDialog.addEventListener("close", () => {
    $("#new-agent")?.focus();
  });

  const personaDialog = $("#persona-dialog");
  $("#persona-close").addEventListener("click", () => {
    personaDialog.close();
  });
  personaDialog.addEventListener("click", (event) => {
    if (event.target === personaDialog) personaDialog.close();
  });
  personaDialog.addEventListener("close", () => {
    $("#open-persona-dialog")?.focus();
  });

  $("#history-close").addEventListener("click", () => {
    $("#history-dialog").close();
  });

  $("#summary-history-close").addEventListener("click", () => {
    $("#summary-history-dialog").close();
  });
  $("#summary-history-dialog").addEventListener("close", () => {
    app.summaryHistoryRequestSequence += 1;
    app.summaryHistoryKey = "";
  });

  $("#episode-archive-close").addEventListener("click", () => {
    $("#episode-archive-dialog").close();
  });
  $("#episode-archive-dialog").addEventListener("close", () => {
    app.episodeArchiveDialogSession += 1;
    app.episodeArchiveRequestSequence += 1;
    app.episodeArchiveKey = "";
    clearEpisodeArchivePoll();
  });

  $("#trace-close").addEventListener("click", () => {
    $("#trace-dialog").close();
  });

  $("#history-search").addEventListener("input", () => {
    renderHistoryMessages();
  });

  $("#summary-history-search").addEventListener("input", () => {
    renderMemorySummaryHistory();
  });
  $("#episode-archive-search").addEventListener("input", () => {
    renderMemoryEpisodeArchive();
  });
  $("#episode-archive-rebuild").addEventListener("click", () => {
    void startMemoryEpisodeRebuild();
  });
  $("#episode-archive-organize").addEventListener("click", () => {
    void startMemoryEpisodeOrganization();
  });

  $("#history-export").addEventListener("click", () => {
    if (app.historyDownloadUrl) window.location.assign(app.historyDownloadUrl);
  });

  $("#user-select").addEventListener("change", (event) => {
    app.selectedUserId = event.target.value;
    app.selectedAgentId = currentUser()?.activeAgentId ?? "";
    clearPersonaDraft({ clearRequest: true });
    renderAgents();
  });

  $("#new-agent").addEventListener("click", () => {
    if (!app.selectedUserId) {
      toast("请先让微信用户发送一条消息，以创建用户档案。", true);
      return;
    }
    populateProviderSelect($("#create-provider"), "");
    $("#create-agent-form").reset();
    $("#agent-dialog").showModal();
  });

  $("#import-card").addEventListener("click", () => {
    if (!app.selectedUserId) {
      toast("请先选择微信用户。", true);
      return;
    }
    $("#card-file").click();
  });

  $("#card-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const card = JSON.parse(await file.text());
      const result = await mutate("/api/agents/import", "POST", {
        userId: app.selectedUserId,
        card,
      });
      app.selectedAgentId = result.agent.id;
      clearPersonaDraft({ clearRequest: true });
      toast(`角色卡“${result.agent.name}”已导入。`);
      await refreshState();
    } catch (error) {
      toast(error.message || "角色卡导入失败。", true);
    }
  });

  $("#create-agent-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await mutate("/api/agents/create", "POST", {
      userId: app.selectedUserId,
      name: form.get("name"),
      identity: form.get("identity"),
      conversationMode: form.get("conversationMode"),
      providerId: form.get("providerId"),
      model: form.get("model"),
    });
    app.selectedAgentId = result.agent.id;
    clearPersonaDraft({ clearRequest: true });
    $("#agent-dialog").close();
    toast("Agent 已创建并设为当前身份。");
    await refreshState();
  });
}

function bindPersonaAssistant() {
  $$("[data-persona-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $("#persona-request");
      input.value = button.dataset.personaPrompt || "";
      input.focus();
    });
  });

  $("#persona-generate").addEventListener("click", () => {
    void generatePersonaDraft();
  });

  $$("[data-style-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $("#roleplay-style-request");
      input.value = button.dataset.stylePrompt || "";
      input.focus();
    });
  });

  $("#roleplay-style-prompt").addEventListener("input", () => {
    updateRoleplayStyleCounter();
    refreshRoleplayStyleDirtyStatus();
  });

  $("#roleplay-style-save").addEventListener("click", () => {
    void saveRoleplayStylePrompt();
  });

  $("#roleplay-style-generate").addEventListener("click", () => {
    void generatePersonaDraft("roleplayStyle");
  });
}

function bindWritingStyleExamples() {
  const dialog = $("#writing-examples-dialog");
  const requestClose = () => requestCloseWritingStyleExamplesDialog();
  $("#open-writing-examples").addEventListener(
    "click",
    openWritingStyleExamplesDialog,
  );
  $("#writing-examples-close").addEventListener("click", requestClose);
  $("#writing-examples-cancel").addEventListener("click", requestClose);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) requestClose();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    requestClose();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestClose();
  });
  dialog.addEventListener("scroll", () => {
    if (dialog.scrollTop) dialog.scrollTop = 0;
  });
  dialog.addEventListener("close", () => {
    resetWritingExampleAiState({ incrementSequence: true });
    $("#open-writing-examples")?.focus();
  });
  $("#writing-example-add").addEventListener("click", addWritingStyleExample);
  $("#writing-examples-save").addEventListener("click", () => {
    void saveWritingStyleExamples();
  });
  $("#writing-examples-list").addEventListener("click", (event) => {
    const target = event.target.closest("[data-writing-example-action]");
    if (!target) return;
    handleWritingStyleExampleAction(
      target.dataset.writingExampleAction,
      Number(target.dataset.index),
    );
  });
  $("#writing-example-editor").addEventListener("click", (event) => {
    const aiTarget = event.target.closest("[data-writing-example-ai-action]");
    if (aiTarget) {
      handleWritingExampleAiAction(aiTarget);
      return;
    }
    const target = event.target.closest("[data-writing-example-action]");
    if (target?.dataset.writingExampleAction === "add") {
      addWritingStyleExample();
    }
  });
  $("#writing-example-editor").addEventListener("input", (event) => {
    if (event.target.id === "writing-example-text") {
      const index = app.writingStyleExamplesSelectedIndex;
      if (index < 0 || index >= app.writingStyleExamplesDraft.length) return;
      app.writingStyleExamplesDraft[index] = event.target.value;
      if (writingExampleAiHasResult()) {
        clearWritingExampleAiResult({
          incrementSequence: true,
          preserveInstruction: true,
        });
        renderWritingExampleAiPanel();
      }
      updateWritingStyleExampleEditorMeta();
      return;
    }
    if (event.target.id === "writing-example-ai-request") {
      app.writingExampleAiInstruction = event.target.value;
      if (writingExampleAiHasResult()) {
        clearWritingExampleAiResult({
          incrementSequence: true,
          preserveInstruction: true,
        });
        renderWritingExampleAiResult();
      }
      refreshWritingExampleAiControls();
    }
  });
}

function bindDirectorEvent() {
  const dialog = $("#director-event-dialog");
  const requestClose = () => requestCloseDirectorEventDialog();

  $("#director-event-close").addEventListener("click", requestClose);
  $("#director-event-cancel").addEventListener("click", requestClose);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) requestClose();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    requestClose();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestClose();
  });
  dialog.addEventListener("close", () => {
    app.directorEventDialogSession += 1;
    resetDirectorEventAiState({ incrementSequence: true });
    app.directorEventUserId = "";
    app.directorEventAgentId = "";
    app.directorEventSourceUpdatedAt = "";
    app.directorEventSourceSnapshot = "";
    app.directorEventSaving = false;
    $("#director-event-request").value = "";
    $("#open-director-event")?.focus();
  });

  $("#director-event-form").addEventListener("input", () => {
    if (directorEventAiHasResult()) {
      clearDirectorEventAiResult({
        incrementSequence: true,
        preserveInstruction: true,
      });
      renderDirectorEventAiResult();
    }
    refreshDirectorEventControls();
  });
  $("#director-event-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveDirectorEvent();
  });

  $("#director-event-request").addEventListener("input", () => {
    if (!directorEventAiHasResult()) return;
    clearDirectorEventAiResult({
      incrementSequence: true,
      preserveInstruction: true,
    });
    renderDirectorEventAiResult();
    refreshDirectorEventControls();
  });

  $$('[data-director-event-prompt]').forEach((button) => {
    button.addEventListener("click", () => {
      if (directorEventIsBusy()) return;
      const input = $("#director-event-request");
      input.value = button.dataset.directorEventPrompt || "";
      if (directorEventAiHasResult()) {
        clearDirectorEventAiResult({
          incrementSequence: true,
          preserveInstruction: true,
        });
        renderDirectorEventAiResult();
      }
      input.focus();
      refreshDirectorEventControls();
    });
  });

  $("#director-event-generate").addEventListener("click", () => {
    void generateDirectorEventDraft();
  });
  $("#director-event-save").addEventListener("click", () => {
    void saveDirectorEvent();
  });
}

function normalizeDirectorEvent(value) {
  const event = value && typeof value === "object" ? value : {};
  return {
    enabled: event.enabled === true,
    title: String(event.title || "").trim(),
    premise: String(event.premise || "").trim(),
    world: String(event.world || "").trim(),
  };
}

function directorEventFromAgent(agent = currentAgent()) {
  return normalizeDirectorEvent(agent?.roleplay?.directorEvent);
}

function readDirectorEventForm() {
  return normalizeDirectorEvent({
    enabled: $("#director-event-enabled")?.checked === true,
    title: $("#director-event-name")?.value || "",
    premise: $("#director-event-premise")?.value || "",
    world: $("#director-event-world")?.value || "",
  });
}

function writeDirectorEventForm(event) {
  const normalized = normalizeDirectorEvent(event);
  $("#director-event-enabled").checked = normalized.enabled;
  $("#director-event-name").value = normalized.title;
  $("#director-event-premise").value = normalized.premise;
  $("#director-event-world").value = normalized.world;
}

function directorEventHasContent(event) {
  return Boolean(event.title || event.premise || event.world);
}

function directorEventValidation(event = readDirectorEventForm()) {
  if (event.title.length > 200) return "事件标题不能超过 200 个字符。";
  if (event.premise.length > 20_000) return "事件前提不能超过 20000 个字符。";
  if (event.world.length > 20_000) return "世界与场景设定不能超过 20000 个字符。";
  if (event.enabled && !event.premise) {
    return "启用导演事件前，请先写明人物必须接受的事件前提。";
  }
  return "";
}

function directorEventDirty() {
  if (!$("#director-event-dialog")?.open) return false;
  return JSON.stringify(readDirectorEventForm()) !==
    app.directorEventSourceSnapshot;
}

function directorEventContextMatches({
  userId = app.directorEventUserId,
  agentId = app.directorEventAgentId,
  sourceUpdatedAt = app.directorEventSourceUpdatedAt,
  dialogSession = app.directorEventDialogSession,
} = {}) {
  const agent = currentAgent();
  return Boolean(
    $("#director-event-dialog")?.open &&
    app.directorEventDialogSession === dialogSession &&
    app.directorEventUserId === userId &&
    app.directorEventAgentId === agentId &&
    app.directorEventSourceUpdatedAt === sourceUpdatedAt &&
    currentUser()?.userId === userId &&
    agent?.id === agentId &&
    agent.updatedAt === sourceUpdatedAt
  );
}

function directorEventIsBusy() {
  return Boolean(
    app.directorEventSaving ||
    app.directorEventAiBusy ||
    app.agentSaving ||
    app.personaBusy ||
    app.writingStyleExamplesSaving ||
    app.writingExampleAiBusy
  );
}

function directorEventAssistantIsAvailable(agent = currentAgent()) {
  if (
    !agent ||
    app.state?.directorEventAssistantAvailable === false
  ) {
    return false;
  }
  const providerId = agent.providerId || app.state?.defaultProviderId;
  const provider = app.state?.providers?.find((item) => item.id === providerId);
  return Boolean(provider && provider.api !== "echo" && provider.configured);
}

function openDirectorEventDialog() {
  const user = currentUser();
  const agent = currentAgent();
  const dialog = $("#director-event-dialog");
  if (!user || !agent) {
    toast("请先选择一个人物。", true);
    return;
  }

  app.directorEventDialogSession += 1;
  resetDirectorEventAiState({ incrementSequence: true });
  const event = directorEventFromAgent(agent);
  app.directorEventUserId = user.userId;
  app.directorEventAgentId = agent.id;
  app.directorEventSourceUpdatedAt = agent.updatedAt || "";
  app.directorEventSourceSnapshot = JSON.stringify(event);
  app.directorEventSaving = false;
  $("#director-event-request").value = "";
  $("#director-event-title").textContent = `${agent.name} · 导演事件`;
  writeDirectorEventForm(event);
  renderDirectorEventAiResult();
  if (!dialog.open) dialog.showModal();
  refreshDirectorEventControls();
  requestAnimationFrame(() => $("#director-event-close")?.focus());
}

function requestCloseDirectorEventDialog() {
  const dialog = $("#director-event-dialog");
  if (!dialog.open || app.directorEventSaving) return;
  const warnings = [];
  if (app.directorEventAiBusy) {
    warnings.push("AI 仍在生成事件草稿，关闭后会放弃本次结果。");
  } else if (app.directorEventAiDraft !== null) {
    warnings.push("AI 事件草稿尚未应用，关闭后会丢失这份预览。");
  }
  if (directorEventDirty()) {
    warnings.push("导演事件还有尚未保存的修改，关闭后会丢失这些修改。");
  }
  if (warnings.length && !confirm(`${warnings.join("\n\n")}\n\n确定关闭吗？`)) {
    return;
  }
  dialog.close();
}

function setDirectorEventStatus(message, kind = "") {
  const status = $("#director-event-status");
  if (!status) return;
  status.textContent = message;
  status.className = [
    kind === "saved" ? "is-saved" : "",
    kind === "error" ? "is-error" : "",
  ].filter(Boolean).join(" ");
}

function refreshDirectorEventControls() {
  const dialog = $("#director-event-dialog");
  if (!dialog?.open) return;
  const agent = currentAgent();
  const contextMatches = directorEventContextMatches();
  const event = readDirectorEventForm();
  const validation = directorEventValidation(event);
  const dirty = directorEventDirty();
  const assistantAvailable = directorEventAssistantIsAvailable(agent);
  const busy = directorEventIsBusy();

  $$("#director-event-form input, #director-event-form textarea").forEach((field) => {
    field.disabled = app.directorEventSaving || app.directorEventAiBusy;
  });
  $("#director-event-request").disabled =
    app.directorEventSaving || app.directorEventAiBusy || !assistantAvailable;
  $("#director-event-generate").disabled =
    busy || !assistantAvailable || !contextMatches;
  $("#director-event-generate").textContent = app.directorEventAiBusy
    ? "正在生成…"
    : "生成事件草稿";
  $$('[data-director-event-prompt]').forEach((button) => {
    button.disabled = busy || !assistantAvailable || !contextMatches;
  });
  $("#director-event-save").disabled =
    busy ||
    app.directorEventAiDraft !== null ||
    !contextMatches ||
    Boolean(validation) ||
    !dirty;
  $("#director-event-cancel").disabled = app.directorEventSaving;
  $("#director-event-close").disabled = app.directorEventSaving;

  const assistantStatus = $("#director-event-assistant-status");
  assistantStatus.textContent = app.directorEventAiBusy
    ? "思考中"
    : assistantAvailable
      ? "可使用"
      : "模型未配置";
  assistantStatus.className = [
    "assistant-status",
    app.directorEventAiBusy ? "busy" : assistantAvailable ? "ready" : "",
  ].filter(Boolean).join(" ");

  const providerId = agent?.providerId || app.state?.defaultProviderId || "未配置";
  const provider = app.state?.providers?.find((item) => item.id === providerId);
  $("#director-event-assistant-context").textContent = assistantAvailable
    ? `正在为“${agent.name}”整理导演事件。草稿由 ${provider?.label || providerId} 生成，只会忠实补全你的要求，不会自行判断人物是否愿意参加。`
    : "配置远程模型后，可以让 AI 忠实补全事件前提和世界场景；你仍可直接在左侧编辑并保存。";

  if (app.directorEventSaving) {
    setDirectorEventStatus("正在保存导演事件…");
  } else if (!contextMatches) {
    setDirectorEventStatus("人物设定已发生变化，请保留需要的文字后重新打开弹窗。", "error");
  } else if (validation) {
    setDirectorEventStatus(validation, "error");
  } else if (app.directorEventAiBusy) {
    setDirectorEventStatus("AI 正在生成事件草稿，当前事件尚未改变。");
  } else if (dirty) {
    setDirectorEventStatus("有尚未保存的导演事件修改。");
  } else if (directorEventHasContent(event)) {
    setDirectorEventStatus(
      event.enabled
        ? "当前导演事件已保存并启用，仅在情景模式中生效。"
        : "当前导演事件已保存但未启用。",
      "saved",
    );
  } else {
    setDirectorEventStatus("尚未设置导演事件。");
  }
}

function directorEventAiHasResult() {
  return Boolean(
    app.directorEventAiBusy ||
    app.directorEventAiDraft !== null ||
    app.directorEventAiError,
  );
}

function clearDirectorEventAiResult({
  incrementSequence = false,
  preserveInstruction = true,
} = {}) {
  if (incrementSequence) app.directorEventAiRequestSequence += 1;
  const instruction = preserveInstruction
    ? $("#director-event-request")?.value || ""
    : "";
  app.directorEventAiBusy = false;
  app.directorEventAiPreviewSequence = 0;
  app.directorEventAiWorkingSnapshot = "";
  app.directorEventAiDraft = null;
  app.directorEventAiSummary = "";
  app.directorEventAiProviderId = "";
  app.directorEventAiModel = "";
  app.directorEventAiError = "";
  if ($("#director-event-request")) {
    $("#director-event-request").value = instruction;
  }
}

function resetDirectorEventAiState({ incrementSequence = false } = {}) {
  clearDirectorEventAiResult({
    incrementSequence,
    preserveInstruction: false,
  });
}

function directorEventAiRequestMatches(context) {
  return Boolean(
    directorEventContextMatches(context) &&
    app.directorEventAiRequestSequence === context.requestSequence &&
    app.directorEventAiWorkingSnapshot === context.workingSnapshot &&
    JSON.stringify(readDirectorEventForm()) === context.workingSnapshot
  );
}

function directorEventAiPreviewIsCurrent() {
  if (
    app.directorEventAiDraft === null ||
    app.directorEventAiPreviewSequence !==
      app.directorEventAiRequestSequence
  ) {
    return false;
  }
  return directorEventAiRequestMatches({
    userId: app.directorEventUserId,
    agentId: app.directorEventAgentId,
    sourceUpdatedAt: app.directorEventSourceUpdatedAt,
    dialogSession: app.directorEventDialogSession,
    requestSequence: app.directorEventAiPreviewSequence,
    workingSnapshot: app.directorEventAiWorkingSnapshot,
  });
}

function directorEventDraftChanges(before, after) {
  return [
    ["title", "事件标题"],
    ["premise", "事件前提"],
    ["world", "世界与场景设定"],
  ].map(([key, label]) => ({
    key,
    label,
    before: String(before?.[key] || "").trim(),
    after: String(after?.[key] || "").trim(),
  })).filter((item) => item.before !== item.after);
}

function renderDirectorEventAiResult() {
  const container = $("#director-event-result");
  if (!container) return;
  if (app.directorEventAiError) {
    container.innerHTML = `<div class="assistant-empty error-copy">${escapeHtml(app.directorEventAiError)}</div>`;
    return;
  }
  if (app.directorEventAiBusy) {
    container.innerHTML = '<div class="assistant-empty">AI 正在忠实整理事件前提与世界场景…</div>';
    return;
  }
  if (app.directorEventAiDraft === null) {
    container.innerHTML = `
      <div class="assistant-empty">
        AI 只会生成预览。先应用到左侧编辑器，确认无误后再保存，当前事件不会被自动覆盖。
      </div>`;
    return;
  }

  const before = JSON.parse(app.directorEventAiWorkingSnapshot || "{}");
  const after = app.directorEventAiDraft;
  const changes = directorEventDraftChanges(before, after);
  const metadata = [app.directorEventAiProviderId, app.directorEventAiModel]
    .filter(Boolean)
    .join(" · ");
  container.innerHTML = `
    <div class="assistant-card director-event-ai-card">
      <h4>事件草稿</h4>
      <p>${escapeHtml(app.directorEventAiSummary || "已按照你的要求整理事件草稿。")}</p>
      ${metadata ? `<span class="director-event-ai-meta">${escapeHtml(metadata)}</span>` : ""}
      <div class="assistant-diff-list">
        ${changes.length
          ? changes.map((change) => `
              <article class="assistant-diff">
                <div class="assistant-diff-head">
                  <b>${escapeHtml(change.label)}</b>
                  <span>草稿</span>
                </div>
                <div class="assistant-diff-block is-after">
                  <span>生成后</span>
                  <p>${escapeHtml(change.after || "（空）")}</p>
                </div>
                <div class="assistant-diff-block is-before">
                  <span>当前</span>
                  <p>${escapeHtml(change.before || "（空）")}</p>
                </div>
              </article>`).join("")
          : '<div class="assistant-no-change">AI 返回的草稿与当前事件相同，请换一种要求后重试。</div>'}
      </div>
    </div>
    <div class="assistant-result-actions">
      <button class="button primary assistant-save" type="button" id="director-event-apply"${changes.length ? "" : " disabled"}>应用到编辑器</button>
      <button class="button ghost" type="button" id="director-event-discard">放弃草稿</button>
    </div>`;
  $("#director-event-apply")?.addEventListener("click", applyDirectorEventAiDraft);
  $("#director-event-discard")?.addEventListener("click", discardDirectorEventAiDraft);
}

async function generateDirectorEventDraft() {
  if (directorEventIsBusy()) return;
  const user = currentUser();
  const agent = currentAgent();
  const instruction = $("#director-event-request").value.trim();
  const currentEvent = readDirectorEventForm();
  if (!directorEventContextMatches() || !user || !agent) {
    setDirectorEventStatus("当前人物已经变化，请关闭后重新打开导演事件。", "error");
    return;
  }
  if (!directorEventAssistantIsAvailable(agent)) {
    setDirectorEventStatus("事件助手当前不可用，请先配置远程模型。", "error");
    return;
  }
  if (!instruction) {
    setDirectorEventStatus("先告诉 AI 你希望怎样创建或修改事件。", "error");
    $("#director-event-request").focus();
    return;
  }

  clearDirectorEventAiResult({ preserveInstruction: true });
  const requestSequence = ++app.directorEventAiRequestSequence;
  const context = {
    userId: user.userId,
    agentId: agent.id,
    sourceUpdatedAt: app.directorEventSourceUpdatedAt,
    dialogSession: app.directorEventDialogSession,
    requestSequence,
    workingSnapshot: JSON.stringify(currentEvent),
  };
  app.directorEventAiBusy = true;
  app.directorEventAiWorkingSnapshot = context.workingSnapshot;
  renderDirectorEventAiResult();
  refreshDirectorEventControls();

  try {
    const result = await mutate(
      "/api/agents/director-event-draft",
      "POST",
      {
        userId: user.userId,
        agentId: agent.id,
        expectedUpdatedAt: context.sourceUpdatedAt,
        instruction,
        currentEvent,
      },
      { suppressErrorToast: true },
    );
    if (!directorEventAiRequestMatches(context)) return;
    if (String(result.sourceUpdatedAt || "") !== context.sourceUpdatedAt) {
      throw new Error("人物设定在生成期间发生了变化，请重新生成。");
    }
    const rawDraft = result.event && typeof result.event === "object"
      ? result.event
      : null;
    if (!rawDraft) throw new Error("AI 没有返回可用的事件草稿。");
    const draft = {
      enabled: currentEvent.enabled,
      title: Object.hasOwn(rawDraft, "title")
        ? String(rawDraft.title || "").trim()
        : currentEvent.title,
      premise: Object.hasOwn(rawDraft, "premise")
        ? String(rawDraft.premise || "").trim()
        : currentEvent.premise,
      world: Object.hasOwn(rawDraft, "world")
        ? String(rawDraft.world || "").trim()
        : currentEvent.world,
    };
    if (!directorEventHasContent(draft)) {
      throw new Error("AI 返回的事件草稿为空，请重新生成。");
    }
    const draftValidation = directorEventValidation({
      ...draft,
      enabled: false,
    });
    if (draftValidation) throw new Error(draftValidation);
    app.directorEventAiBusy = false;
    app.directorEventAiPreviewSequence = requestSequence;
    app.directorEventAiDraft = draft;
    app.directorEventAiSummary = String(result.summary || "").trim();
    app.directorEventAiProviderId = String(result.providerId || "").trim();
    app.directorEventAiModel = String(result.model || "").trim();
    renderDirectorEventAiResult();
    refreshDirectorEventControls();
    setDirectorEventStatus("AI 事件草稿已生成；尚未应用，也尚未保存。");
    $("#director-event-result")?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  } catch (error) {
    if (!directorEventAiRequestMatches(context)) return;
    app.directorEventAiBusy = false;
    app.directorEventAiError =
      error.message || "AI 事件草稿生成失败，请稍后重试。";
    renderDirectorEventAiResult();
    refreshDirectorEventControls();
    setDirectorEventStatus(app.directorEventAiError, "error");
  }
}

function applyDirectorEventAiDraft() {
  if (directorEventIsBusy()) return;
  if (!directorEventAiPreviewIsCurrent()) {
    app.directorEventAiError = "人物或事件正文已经变化，请重新生成草稿。";
    renderDirectorEventAiResult();
    refreshDirectorEventControls();
    return;
  }
  const current = readDirectorEventForm();
  writeDirectorEventForm({
    ...app.directorEventAiDraft,
    enabled: current.enabled,
  });
  clearDirectorEventAiResult({
    incrementSequence: true,
    preserveInstruction: true,
  });
  renderDirectorEventAiResult();
  refreshDirectorEventControls();
  setDirectorEventStatus("AI 草稿已应用到编辑器，尚未保存。请确认后点击“保存事件”。");
  $("#director-event-name")?.focus({ preventScroll: true });
}

function discardDirectorEventAiDraft() {
  if (directorEventIsBusy()) return;
  clearDirectorEventAiResult({
    incrementSequence: true,
    preserveInstruction: true,
  });
  renderDirectorEventAiResult();
  refreshDirectorEventControls();
  setDirectorEventStatus(
    directorEventDirty()
      ? "已放弃 AI 草稿；编辑器仍有尚未保存的修改。"
      : "已放弃 AI 草稿，当前事件没有改变。",
  );
}

async function saveDirectorEvent() {
  if (directorEventIsBusy()) return;
  const user = currentUser();
  const agent = currentAgent();
  const event = readDirectorEventForm();
  const validation = directorEventValidation(event);
  if (!user || !agent || !directorEventContextMatches()) {
    setDirectorEventStatus("当前人物已经变化，请保留需要的文字后重新打开。", "error");
    return;
  }
  if (validation) {
    setDirectorEventStatus(validation, "error");
    return;
  }
  const context = {
    userId: user.userId,
    agentId: agent.id,
    sourceUpdatedAt: app.directorEventSourceUpdatedAt,
    dialogSession: app.directorEventDialogSession,
  };
  app.directorEventSaving = true;
  refreshDirectorEventControls();
  try {
    const result = await mutate(
      "/api/agents/director-event",
      "POST",
      {
        userId: user.userId,
        agentId: agent.id,
        expectedUpdatedAt: context.sourceUpdatedAt,
        event: directorEventHasContent(event) || event.enabled ? event : null,
      },
      { suppressErrorToast: true },
    );
    if (!directorEventContextMatches(context)) return;
    mergeUpdatedAgent(user.userId, result.agent);
    const updated = currentAgent();
    const savedEvent = directorEventFromAgent(updated);
    app.directorEventSourceUpdatedAt = updated.updatedAt || "";
    app.directorEventSourceSnapshot = JSON.stringify(savedEvent);
    writeDirectorEventForm(savedEvent);
    toast(
      savedEvent.enabled
        ? `“${updated.name}”的导演事件已启用。`
        : directorEventHasContent(savedEvent)
          ? `“${updated.name}”的导演事件已保存但未启用。`
          : `“${updated.name}”的导演事件已清除。`,
    );
    renderAgents();
    $("#director-event-dialog").close();
  } catch (error) {
    if (directorEventContextMatches(context)) {
      app.directorEventSaving = false;
      refreshDirectorEventControls();
      setDirectorEventStatus(
        error.message || "导演事件保存失败，请稍后重试。",
        "error",
      );
    }
  } finally {
    app.directorEventSaving = false;
  }
}

function bindStoryBook() {
  const dialog = $("#story-book-dialog");
  const close = () => requestCloseStoryBookDialog();
  $("#story-book-close").addEventListener("click", close);
  $("#story-book-cancel").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    app.storyBookDialogSession += 1;
    resetStoryBookState();
    $("#open-story-book")?.focus();
  });
  $("#story-book-new").addEventListener("click", () => {
    selectStoryBookEntry("");
  });
  $("#story-book-form").addEventListener("input", () => {
    if (storyBookAiHasResult()) clearStoryBookAiResult(true);
    refreshStoryBookControls();
  });
  $("#story-book-request").addEventListener("input", () => {
    if (storyBookAiHasResult()) clearStoryBookAiResult(true, true);
    refreshStoryBookControls();
  });
  $$('[data-story-book-prompt]').forEach((button) => {
    button.addEventListener("click", () => {
      if (storyBookIsBusy()) return;
      $("#story-book-request").value = button.dataset.storyBookPrompt || "";
      if (storyBookAiHasResult()) clearStoryBookAiResult(true, true);
      $("#story-book-request").focus();
      refreshStoryBookControls();
    });
  });
  $("#story-book-generate").addEventListener("click", () => {
    void generateStoryBookDraft();
  });
  $("#story-book-save").addEventListener("click", () => {
    void saveStoryBookEntry();
  });
  $("#story-book-delete").addEventListener("click", () => {
    void deleteStoryBookEntry();
  });
}

function blankStoryBookEntry() {
  return { id: "", title: "", premise: "", content: "" };
}

function normalizeStoryBookEntry(value) {
  const story = value && typeof value === "object" ? value : {};
  return {
    id: String(story.id || "").trim(),
    title: String(story.title || "").trim(),
    premise: String(story.premise || "").trim(),
    content: String(story.content || "").trim(),
    createdAt: String(story.createdAt || ""),
    updatedAt: String(story.updatedAt || ""),
  };
}

function readStoryBookForm() {
  const story = normalizeStoryBookEntry({
    id: app.storyBookSelectedId,
    title: $("#story-book-name")?.value || "",
    premise: $("#story-book-premise")?.value || "",
    content: $("#story-book-content")?.value || "",
  });
  return {
    id: story.id,
    title: story.title,
    premise: story.premise,
    content: story.content,
  };
}

function writeStoryBookForm(value) {
  const story = normalizeStoryBookEntry(value);
  $("#story-book-name").value = story.title;
  $("#story-book-premise").value = story.premise;
  $("#story-book-content").value = story.content;
  $("#story-book-count").textContent = `${Array.from(story.content).length} 字`;
}

function storyBookValidation(story = readStoryBookForm()) {
  if (Array.from(story.title).length > 200) return "作品标题不能超过 200 个字符。";
  if (Array.from(story.premise).length > 20_000) return "剧情构想不能超过 20000 个字符。";
  if (Array.from(story.content).length > 100_000) return "故事正文不能超过 100000 个字符。";
  if (!story.title && !story.premise && !story.content) {
    return "作品标题、剧情构想和正文不能全部为空。";
  }
  return "";
}

function storyBookDirty() {
  return Boolean(
    $("#story-book-dialog")?.open &&
    JSON.stringify(readStoryBookForm()) !== app.storyBookSourceSnapshot
  );
}

function storyBookContextMatches(context = {}) {
  const user = currentUser();
  const agent = currentAgent();
  return Boolean(
    $("#story-book-dialog")?.open &&
    app.storyBookDialogSession === (context.dialogSession ?? app.storyBookDialogSession) &&
    app.storyBookUserId === (context.userId ?? app.storyBookUserId) &&
    app.storyBookAgentId === (context.agentId ?? app.storyBookAgentId) &&
    app.storyBookAgentUpdatedAt === (context.agentUpdatedAt ?? app.storyBookAgentUpdatedAt) &&
    app.storyBookUpdatedAt === (context.bookUpdatedAt ?? app.storyBookUpdatedAt) &&
    user?.userId === app.storyBookUserId &&
    agent?.id === app.storyBookAgentId &&
    agent?.updatedAt === app.storyBookAgentUpdatedAt
  );
}

function storyBookIsBusy() {
  return Boolean(
    app.storyBookLoading ||
    app.storyBookSaving ||
    app.storyBookDeleting ||
    app.storyBookAiBusy ||
    app.agentSaving ||
    app.personaBusy ||
    app.directorEventSaving ||
    app.directorEventAiBusy ||
    app.writingStyleExamplesSaving ||
    app.writingExampleAiBusy
  );
}

function storyBookAssistantIsAvailable(agent = currentAgent()) {
  if (!agent || app.state?.storyBookAssistantAvailable === false) return false;
  const providerId = agent.providerId || app.state?.defaultProviderId;
  const provider = app.state?.providers?.find((item) => item.id === providerId);
  return Boolean(provider && provider.api !== "echo" && provider.configured);
}

function setStoryBookStatus(message, kind = "") {
  const status = $("#story-book-status");
  if (!status) return;
  status.textContent = message;
  status.className = kind === "saved" ? "is-saved" : kind === "error" ? "is-error" : "";
}

function resetStoryBookState() {
  app.storyBookAiRequestSequence += 1;
  app.storyBookUserId = "";
  app.storyBookAgentId = "";
  app.storyBookAgentUpdatedAt = "";
  app.storyBookUpdatedAt = "";
  app.storyBookStories = [];
  app.storyBookSelectedId = "";
  app.storyBookSourceSnapshot = "";
  app.storyBookLoading = false;
  app.storyBookSaving = false;
  app.storyBookDeleting = false;
  clearStoryBookAiResult(false);
  if ($("#story-book-request")) $("#story-book-request").value = "";
}

async function openStoryBookDialog() {
  const user = currentUser();
  const agent = currentAgent();
  const dialog = $("#story-book-dialog");
  if (!user || !agent) {
    toast("请先选择一个人物。", true);
    return;
  }
  app.storyBookDialogSession += 1;
  const dialogSession = app.storyBookDialogSession;
  app.storyBookUserId = user.userId;
  app.storyBookAgentId = agent.id;
  app.storyBookAgentUpdatedAt = agent.updatedAt || "";
  app.storyBookUpdatedAt = "";
  app.storyBookStories = [];
  app.storyBookSelectedId = "";
  app.storyBookSourceSnapshot = JSON.stringify(blankStoryBookEntry());
  app.storyBookLoading = true;
  clearStoryBookAiResult(true);
  $("#story-book-request").value = "";
  $("#story-book-title").textContent = `${agent.name} · 故事书`;
  writeStoryBookForm(blankStoryBookEntry());
  renderStoryBookList();
  renderStoryBookAiResult();
  if (!dialog.open) dialog.showModal();
  refreshStoryBookControls();
  setStoryBookStatus("正在读取私有作品库…");
  try {
    const query = new URLSearchParams({ userId: user.userId, agentId: agent.id });
    const response = await fetch(`/api/agents/story-book?${query}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法读取故事书。");
    if (
      !dialog.open ||
      dialogSession !== app.storyBookDialogSession ||
      app.storyBookUserId !== user.userId ||
      app.storyBookAgentId !== agent.id
    ) return;
    app.storyBookUpdatedAt = String(payload.book?.updatedAt || "");
    app.storyBookStories = Array.isArray(payload.book?.stories)
      ? payload.book.stories.map(normalizeStoryBookEntry)
      : [];
    app.storyBookLoading = false;
    selectStoryBookEntry(app.storyBookStories[0]?.id || "", false);
    setStoryBookStatus(
      app.storyBookStories.length
        ? `已读取 ${app.storyBookStories.length} 篇私有作品。`
        : "故事书还是空的，可以新建作品或直接让 AI 写作。",
      "saved",
    );
  } catch (error) {
    if (dialogSession !== app.storyBookDialogSession || !dialog.open) return;
    app.storyBookLoading = false;
    setStoryBookStatus(error.message || "故事书读取失败。", "error");
    refreshStoryBookControls();
  }
}

function requestCloseStoryBookDialog() {
  const dialog = $("#story-book-dialog");
  if (!dialog.open || app.storyBookSaving || app.storyBookDeleting) return;
  const warnings = [];
  if (app.storyBookAiBusy) warnings.push("AI 仍在生成完整故事，关闭后会放弃本次结果。");
  else if (app.storyBookAiDraft) warnings.push("AI 故事草稿尚未应用，关闭后会丢失预览。");
  if (storyBookDirty()) warnings.push("当前作品还有尚未保存的修改。");
  if (warnings.length && !confirm(`${warnings.join("\n\n")}\n\n确定关闭吗？`)) return;
  dialog.close();
}

function selectStoryBookEntry(storyId, confirmDiscard = true) {
  if (storyBookIsBusy()) return;
  if (
    confirmDiscard &&
    (storyBookDirty() || app.storyBookAiDraft) &&
    !confirm("切换作品会丢失当前尚未保存或尚未应用的修改。确定继续吗？")
  ) return;
  const story = storyId
    ? app.storyBookStories.find((entry) => entry.id === storyId)
    : blankStoryBookEntry();
  if (!story) return;
  app.storyBookSelectedId = story.id || "";
  const normalized = normalizeStoryBookEntry(story);
  writeStoryBookForm(normalized);
  app.storyBookSourceSnapshot = JSON.stringify({
    id: normalized.id,
    title: normalized.title,
    premise: normalized.premise,
    content: normalized.content,
  });
  clearStoryBookAiResult(true);
  $("#story-book-request").value = "";
  renderStoryBookList();
  renderStoryBookAiResult();
  refreshStoryBookControls();
  setStoryBookStatus(
    story.id ? `正在编辑“${story.title || "未命名故事"}”。` : "正在新建一篇故事。",
  );
}

function renderStoryBookList() {
  const list = $("#story-book-list");
  if (!list) return;
  if (app.storyBookLoading) {
    list.innerHTML = '<div class="assistant-empty">正在读取作品…</div>';
    return;
  }
  list.innerHTML = app.storyBookStories.length
    ? app.storyBookStories.map((story) => `
        <button class="story-book-list-item${story.id === app.storyBookSelectedId ? " is-selected" : ""}" type="button" data-story-id="${escapeAttr(story.id)}">
          <strong>${escapeHtml(story.title || "未命名故事")}</strong>
          <span>${Array.from(story.content || "").length} 字 · ${escapeHtml(formatTimestamp(story.updatedAt))}</span>
        </button>`).join("")
    : '<div class="assistant-empty">尚未保存作品。点击“新建”，或直接在编辑区开始。</div>';
  $$('[data-story-id]').forEach((button) => {
    button.addEventListener("click", () => selectStoryBookEntry(button.dataset.storyId || ""));
  });
}

function refreshStoryBookControls() {
  const dialog = $("#story-book-dialog");
  if (!dialog?.open) return;
  const story = readStoryBookForm();
  const validation = storyBookValidation(story);
  const contextMatches = storyBookContextMatches();
  const assistantAvailable = storyBookAssistantIsAvailable();
  const busy = storyBookIsBusy();
  $("#story-book-count").textContent = `${Array.from(story.content).length} 字`;
  $$("#story-book-form input, #story-book-form textarea").forEach((field) => {
    field.disabled = app.storyBookLoading || app.storyBookSaving || app.storyBookDeleting || app.storyBookAiBusy;
  });
  $("#story-book-new").disabled = busy || !contextMatches;
  $("#story-book-delete").disabled = busy || !contextMatches || !app.storyBookSelectedId;
  $("#story-book-save").disabled = busy || !contextMatches || Boolean(validation) || !storyBookDirty() || Boolean(app.storyBookAiDraft);
  $("#story-book-request").disabled = busy || !assistantAvailable || !contextMatches;
  $("#story-book-generate").disabled = busy || !assistantAvailable || !contextMatches;
  $("#story-book-generate").textContent = app.storyBookAiBusy ? "正在写作…" : "生成完整故事草稿";
  $$('[data-story-book-prompt]').forEach((button) => {
    button.disabled = busy || !assistantAvailable || !contextMatches;
  });
  const status = $("#story-book-assistant-status");
  status.textContent = app.storyBookAiBusy ? "写作中" : assistantAvailable ? "可使用" : "模型未配置";
  status.className = `assistant-status ${app.storyBookAiBusy ? "busy" : assistantAvailable ? "ready" : ""}`.trim();
  const agent = currentAgent();
  const providerId = agent?.providerId || app.state?.defaultProviderId || "未配置";
  const provider = app.state?.providers?.find((item) => item.id === providerId);
  $("#story-book-assistant-context").textContent = assistantAvailable
    ? `正在为“${agent.name}”写作。草稿会参考该人物的设定、长期记忆与最近聊天，由 ${provider?.label || providerId} 生成；未指定篇幅时默认约 3000–5000 字。`
    : "配置远程模型后，可以把剧情构想扩写成完整正文；你仍可直接手写并保存。";
  if (!contextMatches) setStoryBookStatus("人物或作品库已经变化，请关闭后重新打开。", "error");
  else if (validation && storyBookDirty()) setStoryBookStatus(validation, "error");
}

function storyBookAiHasResult() {
  return Boolean(app.storyBookAiBusy || app.storyBookAiDraft || app.storyBookAiError);
}

function clearStoryBookAiResult(incrementSequence = false, preserveInstruction = false) {
  if (incrementSequence) app.storyBookAiRequestSequence += 1;
  const instruction = preserveInstruction ? $("#story-book-request")?.value || "" : "";
  app.storyBookAiBusy = false;
  app.storyBookAiWorkingSnapshot = "";
  app.storyBookAiDraft = null;
  app.storyBookAiSummary = "";
  app.storyBookAiProviderId = "";
  app.storyBookAiModel = "";
  app.storyBookAiError = "";
  if ($("#story-book-request")) $("#story-book-request").value = instruction;
  renderStoryBookAiResult();
}

function renderStoryBookAiResult() {
  const container = $("#story-book-result");
  if (!container) return;
  if (app.storyBookAiError) {
    container.innerHTML = `<div class="assistant-empty error-copy">${escapeHtml(app.storyBookAiError)}</div>`;
    return;
  }
  if (app.storyBookAiBusy) {
    container.innerHTML = '<div class="assistant-empty">AI 正在先用思考模式规划剧情，再按规划分段写正文并检查连续性。长篇内容需要依次完成多个阶段…</div>';
    return;
  }
  if (!app.storyBookAiDraft) {
    container.innerHTML = '<div class="assistant-empty">AI 只生成预览。应用后仍需点击“保存作品”，不会自动覆盖当前正文。</div>';
    return;
  }
  const draft = app.storyBookAiDraft;
  const metadata = [app.storyBookAiProviderId, app.storyBookAiModel].filter(Boolean).join(" · ");
  container.innerHTML = `
    <div class="assistant-card">
      <h4>${escapeHtml(draft.title || "未命名故事")}</h4>
      <p>${escapeHtml(app.storyBookAiSummary || "已生成完整故事草稿。")}</p>
      ${metadata ? `<span class="director-event-ai-meta">${escapeHtml(metadata)}</span>` : ""}
      <div class="story-book-ai-preview">${escapeHtml(draft.content)}</div>
    </div>
    <div class="assistant-result-actions">
      <button class="button primary assistant-save" type="button" id="story-book-apply">应用到编辑器</button>
      <button class="button ghost" type="button" id="story-book-discard">放弃草稿</button>
    </div>`;
  $("#story-book-apply")?.addEventListener("click", applyStoryBookAiDraft);
  $("#story-book-discard")?.addEventListener("click", () => {
    clearStoryBookAiResult(true, true);
    refreshStoryBookControls();
    setStoryBookStatus(storyBookDirty() ? "已放弃 AI 草稿；编辑器仍有未保存修改。" : "已放弃 AI 草稿。");
  });
}

async function generateStoryBookDraft() {
  if (storyBookIsBusy()) return;
  const user = currentUser();
  const agent = currentAgent();
  const instruction = $("#story-book-request").value.trim();
  const currentStory = readStoryBookForm();
  if (!user || !agent || !storyBookContextMatches()) {
    setStoryBookStatus("人物或作品库已经变化，请重新打开故事书。", "error");
    return;
  }
  if (!storyBookAssistantIsAvailable(agent)) {
    setStoryBookStatus("故事助手当前不可用，请先配置远程模型。", "error");
    return;
  }
  if (!instruction) {
    setStoryBookStatus("请先写下剧情构想或具体修改要求。", "error");
    $("#story-book-request").focus();
    return;
  }
  clearStoryBookAiResult(true, true);
  const requestSequence = ++app.storyBookAiRequestSequence;
  const workingSnapshot = JSON.stringify(currentStory);
  const context = {
    userId: user.userId,
    agentId: agent.id,
    agentUpdatedAt: app.storyBookAgentUpdatedAt,
    bookUpdatedAt: app.storyBookUpdatedAt,
    dialogSession: app.storyBookDialogSession,
    requestSequence,
    workingSnapshot,
  };
  app.storyBookAiBusy = true;
  app.storyBookAiWorkingSnapshot = workingSnapshot;
  renderStoryBookAiResult();
  refreshStoryBookControls();
  setStoryBookStatus("AI 正在思考剧情规划，随后会分段写正文并检查人物与记忆连续性；当前正文尚未改变。");
  try {
    const result = await mutate(
      "/api/agents/story-book-draft",
      "POST",
      {
        userId: user.userId,
        agentId: agent.id,
        expectedUpdatedAt: context.agentUpdatedAt,
        expectedBookUpdatedAt: context.bookUpdatedAt,
        instruction,
        currentStory,
      },
      { suppressErrorToast: true },
    );
    if (
      !storyBookContextMatches(context) ||
      requestSequence !== app.storyBookAiRequestSequence ||
      app.storyBookAiWorkingSnapshot !== workingSnapshot ||
      JSON.stringify(readStoryBookForm()) !== workingSnapshot
    ) return;
    if (String(result.sourceUpdatedAt || "") !== context.agentUpdatedAt) {
      throw new Error("人物设定在写作期间发生了变化，请重新生成。");
    }
    const draft = normalizeStoryBookEntry({
      id: currentStory.id,
      ...(result.story || {}),
    });
    if (!draft.premise || !draft.content) {
      throw new Error("AI 没有返回完整的剧情构想和故事正文。");
    }
    const validation = storyBookValidation(draft);
    if (validation) throw new Error(validation);
    app.storyBookAiBusy = false;
    app.storyBookAiDraft = draft;
    app.storyBookAiSummary = String(result.summary || "").trim();
    app.storyBookAiProviderId = String(result.providerId || "").trim();
    app.storyBookAiModel = String(result.model || "").trim();
    renderStoryBookAiResult();
    refreshStoryBookControls();
    setStoryBookStatus("完整故事草稿已生成；尚未应用，也尚未保存。");
  } catch (error) {
    if (!storyBookContextMatches(context) || requestSequence !== app.storyBookAiRequestSequence) return;
    app.storyBookAiBusy = false;
    app.storyBookAiError = error.message || "故事草稿生成失败，请稍后重试。";
    renderStoryBookAiResult();
    refreshStoryBookControls();
    setStoryBookStatus(app.storyBookAiError, "error");
  }
}

function applyStoryBookAiDraft() {
  if (storyBookIsBusy() || !app.storyBookAiDraft) return;
  if (JSON.stringify(readStoryBookForm()) !== app.storyBookAiWorkingSnapshot) {
    app.storyBookAiError = "当前正文已经变化，请重新生成故事草稿。";
    renderStoryBookAiResult();
    return;
  }
  writeStoryBookForm({
    ...app.storyBookAiDraft,
    id: app.storyBookSelectedId,
  });
  clearStoryBookAiResult(true, true);
  refreshStoryBookControls();
  setStoryBookStatus("AI 草稿已应用到编辑器，尚未保存。请确认后点击“保存作品”。");
  $("#story-book-content")?.focus({ preventScroll: true });
}

async function saveStoryBookEntry() {
  if (storyBookIsBusy()) return;
  const story = readStoryBookForm();
  const validation = storyBookValidation(story);
  if (validation) {
    setStoryBookStatus(validation, "error");
    return;
  }
  if (!storyBookContextMatches()) {
    setStoryBookStatus("人物或作品库已经变化，请重新打开故事书。", "error");
    return;
  }
  const context = {
    userId: app.storyBookUserId,
    agentId: app.storyBookAgentId,
    agentUpdatedAt: app.storyBookAgentUpdatedAt,
    bookUpdatedAt: app.storyBookUpdatedAt,
    dialogSession: app.storyBookDialogSession,
  };
  app.storyBookSaving = true;
  refreshStoryBookControls();
  setStoryBookStatus("正在保存作品…");
  try {
    const result = await mutate(
      "/api/agents/story-book",
      "POST",
      {
        userId: context.userId,
        agentId: context.agentId,
        expectedBookUpdatedAt: context.bookUpdatedAt,
        story: {
          ...(story.id ? { id: story.id } : {}),
          title: story.title,
          premise: story.premise,
          content: story.content,
        },
      },
      { suppressErrorToast: true },
    );
    if (!storyBookContextMatches(context)) return;
    app.storyBookUpdatedAt = String(result.book?.updatedAt || "");
    app.storyBookStories = Array.isArray(result.book?.stories)
      ? result.book.stories.map(normalizeStoryBookEntry)
      : [];
    app.storyBookSaving = false;
    const savedId = story.id || app.storyBookStories[0]?.id || "";
    selectStoryBookEntry(savedId, false);
    renderStoryBookList();
    setStoryBookStatus(`“${readStoryBookForm().title || "未命名故事"}”已保存。`, "saved");
    toast("故事作品已保存到私有状态目录。");
  } catch (error) {
    if (storyBookContextMatches(context)) {
      app.storyBookSaving = false;
      refreshStoryBookControls();
      setStoryBookStatus(error.message || "故事保存失败，请稍后重试。", "error");
    }
  }
}

async function deleteStoryBookEntry() {
  if (storyBookIsBusy() || !app.storyBookSelectedId) return;
  const story = readStoryBookForm();
  if (!confirm(`确定永久删除“${story.title || "未命名故事"}”吗？这不会删除人物或聊天记忆。`)) return;
  const context = {
    userId: app.storyBookUserId,
    agentId: app.storyBookAgentId,
    agentUpdatedAt: app.storyBookAgentUpdatedAt,
    bookUpdatedAt: app.storyBookUpdatedAt,
    dialogSession: app.storyBookDialogSession,
  };
  app.storyBookDeleting = true;
  refreshStoryBookControls();
  try {
    const result = await mutate(
      "/api/agents/story-book",
      "DELETE",
      {
        userId: context.userId,
        agentId: context.agentId,
        storyId: app.storyBookSelectedId,
        expectedBookUpdatedAt: context.bookUpdatedAt,
      },
      { suppressErrorToast: true },
    );
    if (!storyBookContextMatches(context)) return;
    app.storyBookUpdatedAt = String(result.book?.updatedAt || "");
    app.storyBookStories = Array.isArray(result.book?.stories)
      ? result.book.stories.map(normalizeStoryBookEntry)
      : [];
    app.storyBookDeleting = false;
    selectStoryBookEntry(app.storyBookStories[0]?.id || "", false);
    renderStoryBookList();
    setStoryBookStatus("作品已删除，人物设定和聊天记忆没有改变。", "saved");
  } catch (error) {
    if (storyBookContextMatches(context)) {
      app.storyBookDeleting = false;
      refreshStoryBookControls();
      setStoryBookStatus(error.message || "故事删除失败，请稍后重试。", "error");
    }
  }
}

function openPersonaDialog() {
  const agent = currentAgent();
  const dialog = $("#persona-dialog");
  if (!agent) {
    toast("请先选择一个人物。", true);
    return;
  }
  $("#persona-dialog-title").textContent = `${agent.name} · 人物设定`;
  renderCurrentPersonaSummary(agent);
  renderRoleplayStyleEditor(agent);
  renderWritingStyleExamplesLauncher(agent);
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $("#persona-close")?.focus());
}

async function refreshState() {
  try {
    const response = await fetch("/api/state", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("无法读取后台状态。");
    app.state = await response.json();
    ensureSelection();
    renderMetrics();
    renderProviders();
    renderUserPicker();
    renderAgents();
    $("#footer-status").textContent =
      `LOCAL / ${app.state.providers.filter((item) => item.configured).length} PROVIDERS READY`;
  } catch (error) {
    toast(error.message, true);
  }
}

function ensureSelection() {
  const users = app.state?.users ?? [];
  if (!users.length) {
    app.selectedUserId = "";
    app.selectedAgentId = "";
    return;
  }
  if (!users.some((user) => user.userId === app.selectedUserId)) {
    app.selectedUserId = users[0].userId;
  }
  const user = currentUser();
  if (!user?.agents.some((agent) => agent.id === app.selectedAgentId)) {
    app.selectedAgentId = user?.activeAgentId ?? user?.agents[0]?.id ?? "";
  }
}

function renderMetrics() {
  const users = app.state?.users ?? [];
  const providers = app.state?.providers ?? [];
  const agentCount = users.reduce((total, user) => total + user.agents.length, 0);
  const memoryCount = users.reduce(
    (total, user) =>
      total +
      user.agents.reduce((sum, agent) => sum + agent.memoryCount, 0),
    0,
  );
  $("#metrics").innerHTML = [
    metric("Users", users.length),
    metric("Agents", agentCount),
    metric("Providers", providers.filter((item) => item.configured).length),
    metric("Memory", memoryCount),
  ].join("");
}

function metric(label, value) {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong></article>`;
}

function renderUserPicker() {
  const select = $("#user-select");
  const users = app.state?.users ?? [];
  if (!users.length) {
    select.innerHTML = '<option value="">尚无微信用户</option>';
    select.disabled = true;
    $("#new-agent").disabled = true;
    $("#import-card").disabled = true;
    return;
  }
  select.disabled = false;
  $("#new-agent").disabled = false;
  $("#import-card").disabled = false;
  select.innerHTML = users
    .map(
      (user) =>
        `<option value="${escapeAttr(user.userId)}"${user.userId === app.selectedUserId ? " selected" : ""}>${escapeHtml(user.userId)} · ${user.agents.length} Agents</option>`,
    )
    .join("");
}

function renderAgents() {
  const user = currentUser();
  const list = $("#agent-list");
  if (!user) {
    list.innerHTML = '<div class="empty-list">暂无 Agent</div>';
    $("#agent-editor").innerHTML = emptyEditor(
      "等待第一位用户",
      "请先在微信中给机器人发送一条消息。",
    );
    renderPersonaAssistantContext();
    return;
  }

  list.innerHTML = user.agents
    .map((agent) => {
      const selected = agent.id === app.selectedAgentId;
      const active = agent.id === user.activeAgentId;
      return `
        <button class="agent-item${selected ? " selected" : ""}" data-agent-id="${escapeAttr(agent.id)}" aria-pressed="${selected ? "true" : "false"}">
          <span class="agent-avatar">${escapeHtml(agent.name.slice(0, 1).toUpperCase())}</span>
          <span>
            <strong>${escapeHtml(agent.name)}</strong>
            <small>${escapeHtml(agent.providerId || app.state.defaultProviderId)} · ${agent.memoryCount} working / ${agent.totalMemoryCount || 0} total</small>
          </span>
          ${active ? '<span class="active-dot" title="当前 Agent"></span>' : ""}
        </button>`;
    })
    .join("");

  $$(".agent-item").forEach((button) => {
    button.addEventListener("click", () => {
      if (app.selectedAgentId !== button.dataset.agentId) {
        clearPersonaDraft({ clearRequest: true });
      }
      app.selectedAgentId = button.dataset.agentId;
      renderAgents();
    });
  });
  renderEditor();
}

function imageBehaviorFromAgent(agent = currentAgent()) {
  const source = agent?.imageBehavior || {};
  const mode = IMAGE_BEHAVIOR_MODES.has(source.mode)
    ? source.mode
    : "explicit";
  return {
    mode,
    cooldownMinutes: 0,
    allowAutonomous: source.allowAutonomous === true,
    visualIdentityPrompt: String(source.visualIdentityPrompt || ""),
  };
}

function imageBehaviorModeLabel(mode) {
  if (mode === "off") return "关闭发图";
  if (mode === "natural") return "自然发送";
  return "仅明确请求";
}

function renderImageBehaviorPanel(agent, status = "") {
  const behavior = imageBehaviorFromAgent(agent);
  const checked = (mode) => (behavior.mode === mode ? " checked" : "");
  return `
    <section
      class="image-behavior-panel"
      id="image-behavior-panel"
      aria-labelledby="image-behavior-title"
    >
      <div class="image-behavior-head">
        <div>
          <span class="mini-label">VISUAL EXPRESSION / PER AGENT</span>
          <h4 id="image-behavior-title">图片行为</h4>
          <p>决定这个人物何时会发图，以及生成画面时应保持怎样的视觉身份；不影响识别你发来的图片。</p>
        </div>
        <span class="autonomy-state ${behavior.mode === "natural" ? "is-on" : "is-off"}" id="image-behavior-mode-chip">${escapeHtml(imageBehaviorModeLabel(behavior.mode))}</span>
      </div>
      <form
        class="image-behavior-form"
        id="image-behavior-form"
        data-user-id="${escapeAttr(app.selectedUserId)}"
        data-agent-id="${escapeAttr(agent.id)}"
        data-source-updated-at="${escapeAttr(agent.updatedAt || "")}"
      >
        <fieldset class="image-behavior-modes">
          <legend>发送方式</legend>
          <div class="image-behavior-mode-options">
            <label>
              <input type="radio" name="imageBehaviorMode" value="off"${checked("off")}>
              <span><strong>关闭</strong><small>人物不会生成或发送图片，仍可看懂收到的图片</small></span>
            </label>
            <label>
              <input type="radio" name="imageBehaviorMode" value="explicit"${checked("explicit")}>
              <span><strong>仅明确请求</strong><small>你明确要求画图时才发送</small></span>
            </label>
            <label>
              <input type="radio" name="imageBehaviorMode" value="natural"${checked("natural")}>
              <span><strong>自然发送</strong><small>人物判断图片比纯文字更自然时发送</small></span>
            </label>
          </div>
        </fieldset>
        <div class="image-behavior-settings">
          <label class="image-autonomous-toggle">
            <input name="allowAutonomous" type="checkbox"${behavior.allowAutonomous ? " checked" : ""}>
            <span>
              <strong>允许主动联系时配图</strong>
              <small>默认关闭；只有“自然发送”模式会实际使用。没有时间间隔或每日图片上限，主动消息仍受微信会话能力限制。</small>
            </span>
          </label>
        </div>
        <label class="image-visual-identity-field" for="visual-identity-prompt">
          视觉身份设定
          <textarea
            id="visual-identity-prompt"
            name="visualIdentityPrompt"
            rows="5"
            maxlength="8000"
            placeholder="例如：写实手机随拍；保持同一张脸、黑色齐肩短发和清淡妆容；画面自然，不出现水印或文字。"
          >${escapeHtml(behavior.visualIdentityPrompt)}</textarea>
          <small>用于维持人物外貌、服装习惯和图片风格；不会写入聊天记忆。</small>
        </label>
        <div class="image-behavior-actions">
          <span class="image-behavior-status${status ? " is-saved" : ""}" id="image-behavior-status" aria-live="polite">${escapeHtml(status || "修改只对当前人物生效，保存后下一轮对话开始使用。")}</span>
          <button class="button primary" type="submit" id="save-image-behavior">保存图片行为</button>
        </div>
      </form>
    </section>`;
}

function bindImageBehaviorPanel() {
  const form = $("#image-behavior-form");
  if (!form) return;
  form.addEventListener("change", (event) => {
    if (event.target?.name !== "imageBehaviorMode") return;
    const chip = $("#image-behavior-mode-chip");
    const mode = event.target.value;
    chip.textContent = imageBehaviorModeLabel(mode);
    chip.className = `autonomy-state ${mode === "natural" ? "is-on" : "is-off"}`;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveImageBehavior(form);
  });
}

function imageBehaviorValueFromForm(form) {
  const mode = form.elements.imageBehaviorMode?.value;
  if (!IMAGE_BEHAVIOR_MODES.has(mode)) {
    throw new Error("请选择图片发送方式。");
  }
  return {
    mode,
    cooldownMinutes: 0,
    allowAutonomous: form.elements.allowAutonomous?.checked === true,
    visualIdentityPrompt: String(
      form.elements.visualIdentityPrompt?.value || "",
    ).trim(),
  };
}

function setImageBehaviorFormBusy(form, busy) {
  form.setAttribute("aria-busy", busy ? "true" : "false");
  form.querySelectorAll("input, textarea, button").forEach((field) => {
    field.disabled = busy;
  });
}

async function saveImageBehavior(form) {
  const user = currentUser();
  const agent = currentAgent();
  if (
    !user ||
    !agent ||
    form.dataset.userId !== user.userId ||
    form.dataset.agentId !== agent.id
  ) {
    toast("当前人物已经切换，本次图片行为修改未保存。", true);
    return;
  }
  const sourceUpdatedAt = form.dataset.sourceUpdatedAt || "";
  if (!sourceUpdatedAt || sourceUpdatedAt !== agent.updatedAt) {
    toast("人物设定已经变化，请确认最新内容后再保存图片行为。", true);
    return;
  }

  let imageBehavior;
  try {
    imageBehavior = imageBehaviorValueFromForm(form);
  } catch (error) {
    toast(error.message || "图片行为设置不完整。", true);
    return;
  }

  const requestedUserId = user.userId;
  const requestedAgentId = agent.id;
  const savingKey = `${requestedUserId}\u0000${requestedAgentId}`;
  if (app.imageBehaviorSavingKeys.has(savingKey)) return;
  app.imageBehaviorSavingKeys.add(savingKey);
  setImageBehaviorFormBusy(form, true);
  const status = form.querySelector("#image-behavior-status");
  status.textContent = "正在保存图片行为…";
  status.className = "image-behavior-status";

  try {
    const result = await mutate(
      "/api/agents/image-behavior",
      "POST",
      {
        userId: requestedUserId,
        agentId: requestedAgentId,
        expectedUpdatedAt: sourceUpdatedAt,
        imageBehavior,
      },
      { suppressErrorToast: true },
    );
    mergeUpdatedAgent(requestedUserId, result.agent);
    if (agentSelectionMatches(requestedUserId, requestedAgentId)) {
      const panel = $("#image-behavior-panel");
      const updated = currentAgent();
      if (panel && updated) {
        panel.outerHTML = renderImageBehaviorPanel(
          updated,
          "图片行为已保存。",
        );
        bindImageBehaviorPanel();
      }
    }
    toast(`“${agent.name}”的图片行为已保存。`);
  } catch (error) {
    const message = error.message || "图片行为保存失败。";
    if (
      agentSelectionMatches(requestedUserId, requestedAgentId) &&
      form.isConnected
    ) {
      status.textContent = message;
      status.className = "image-behavior-status is-error";
    }
    toast(`“${agent.name}”的图片行为保存失败：${message}`, true);
  } finally {
    app.imageBehaviorSavingKeys.delete(savingKey);
    if (form.isConnected) setImageBehaviorFormBusy(form, false);
  }
}

function renderEditor() {
  const user = currentUser();
  const agent = currentAgent();
  if (!user || !agent) {
    $("#agent-editor").innerHTML = emptyEditor(
      "选择一个 Agent",
      "从左侧选择 Agent 后即可编辑。",
    );
    renderPersonaAssistantContext();
    return;
  }
  const active = agent.id === user.activeAgentId;
  const directorEvent = directorEventFromAgent(agent);
  const directorEventModeActive =
    (agent.conversationMode || (agent.roleplay ? "roleplay" : "wechat")) ===
    "roleplay";
  const directorEventStatus = directorEvent.enabled
    ? directorEventModeActive
      ? "已启用"
      : "等待情景模式"
    : "未启用";
  $("#agent-editor").innerHTML = `
    <div class="editor-head">
      <div>
        <p class="eyebrow">AGENT / ${escapeHtml(agent.id.slice(0, 8).toUpperCase())}</p>
        <h3>${escapeHtml(agent.name)}</h3>
      </div>
      <span class="status-chip">${active ? "ACTIVE NOW" : "AVAILABLE"}</span>
    </div>
    <button
      class="persona-launch-card"
      type="button"
      id="open-persona-dialog"
      aria-haspopup="dialog"
      aria-controls="persona-dialog"
    >
      <span class="persona-launch-mark">P</span>
      <span class="persona-launch-copy">
        <small>PERSONA CARD / AI CO-WRITER</small>
        <strong>查看完整设定与 AI 修改</strong>
        <span>身份、性格、场景、${agent.roleplay?.lorebook?.entries?.length || 0} 条世界书设定</span>
      </span>
      <span class="persona-launch-action">打开 <b aria-hidden="true">↗</b></span>
    </button>
    <button
      class="persona-launch-card director-event-launch-card${directorEvent.enabled ? " is-enabled" : ""}"
      type="button"
      id="open-director-event"
      aria-haspopup="dialog"
      aria-controls="director-event-dialog"
    >
      <span class="persona-launch-mark director-event-launch-mark">D</span>
      <span class="persona-launch-copy">
        <small>ROLEPLAY DIRECTOR / FIXED PREMISE</small>
        <strong>${escapeHtml(directorEvent.title || "设置导演事件")}</strong>
        <span>${escapeHtml(
          directorEvent.premise ||
            "把事件设为已经确定的事实，让人物直接进入互动；仅在情景模式生效。",
        )}</span>
      </span>
      <span class="persona-launch-action director-event-launch-action">
        <em class="autonomy-state ${directorEvent.enabled ? "is-on" : "is-off"}">${escapeHtml(directorEventStatus)}</em>
        <b aria-hidden="true">↗</b>
      </span>
    </button>
    <button
      class="persona-launch-card story-book-launch-card"
      type="button"
      id="open-story-book"
      aria-haspopup="dialog"
      aria-controls="story-book-dialog"
    >
      <span class="persona-launch-mark story-book-launch-mark">S</span>
      <span class="persona-launch-copy">
        <small>STORY BOOK / FULL PROSE</small>
        <strong>故事书与 AI 正文写作</strong>
        <span>保存多篇作品，把你的剧情构想扩写成可直接阅读的完整正文。</span>
      </span>
      <span class="persona-launch-action">打开 <b aria-hidden="true">↗</b></span>
    </button>
    <div class="agent-dashboard">
      ${renderImageBehaviorPanel(agent)}
      <section class="weather-panel" id="weather-panel" aria-labelledby="weather-panel-title" aria-live="polite">
        ${renderWeatherLoading()}
      </section>
      <section class="autonomy-panel" id="autonomy-panel" aria-labelledby="autonomy-panel-title" aria-live="polite">
        ${renderAutonomyLoading()}
      </section>
      <details class="memory-tools">
        <summary>
          <span>
            <strong>记忆与调试</strong>
            <small>${agent.memoryCount} 条工作消息 · ${agent.totalMemoryCount || 0} 条完整聊天 · ${agent.memoryCompressionCount || 0} 次模型压缩</small>
          </span>
          <span class="field-count">按需查看</span>
        </summary>
        <div class="memory-tools-body">
          <div class="memory-strip">
            <div>
              <strong>独立记忆</strong>
              <span>修改人物不会自动删除或重写这些内容。</span>
            </div>
            <div>
              <button class="button ghost" type="button" id="view-episode-archive"${agent.totalMemoryCount ? "" : " disabled"}>查看全部事件记忆</button>
              <button class="button ghost" type="button" id="view-summary-history"${agent.memoryCompressionCount ? "" : " disabled"}>查看全部摘要版本</button>
              <button class="button ghost" type="button" id="view-prompts">查看 Prompt</button>
              <button class="button ghost" type="button" id="view-history"${agent.totalMemoryCount ? "" : " disabled"}>查看全部 ${agent.totalMemoryCount || 0} 条聊天</button>
              <button class="button ghost" type="button" id="clear-memory"${agent.totalMemoryCount ? "" : " disabled"}>清空全部</button>
            </div>
          </div>
          <div class="memory-inspector">
            <div>
              <span class="mini-label">CURRENT CURATED SUMMARY</span>
              <strong class="memory-card-title">当前生效摘要</strong>
              <p>${agent.memorySummary ? escapeHtml(agent.memorySummary) : "尚未触发模型压缩。工作窗口超过阈值后会在后台整理。"}</p>
            </div>
            <div>
              <span class="mini-label">DURABLE FACTS</span>
              <div class="fact-list">${renderFacts(agent.memoryFacts)}</div>
            </div>
            <div>
              <span class="mini-label">KEY EPISODES</span>
              <div class="fact-list">${renderEpisodes(agent.memoryEpisodes)}</div>
            </div>
          </div>
          <section class="working-memory">
            <div class="working-memory-head">
              <div>
                <span class="mini-label">CURRENT WORKING MEMORY</span>
                <strong>模型下一轮直接看到的最近对话（不是完整归档）</strong>
              </div>
              <span>${agent.memoryMessages?.length || 0} 条</span>
            </div>
            <div class="memory-message-list">
              ${renderMemoryMessages(agent.memoryMessages, agent.name, "当前还没有对话记忆。")}
            </div>
          </section>
        </div>
      </details>
      <div class="editor-actions">
        <button class="button ghost" type="button" id="export-card">导出角色卡</button>
        <button class="button ghost" type="button" id="activate-agent"${active ? " disabled" : ""}>设为当前 Agent</button>
        <button class="button danger" type="button" id="delete-agent"${active || user.agents.length === 1 ? " disabled" : ""}>删除 Agent</button>
      </div>
    </div>`;

  renderPersonaAssistantContext();

  $("#open-persona-dialog").addEventListener("click", openPersonaDialog);
  $("#open-director-event").addEventListener("click", openDirectorEventDialog);
  $("#open-story-book").addEventListener("click", openStoryBookDialog);
  bindImageBehaviorPanel();
  app.weatherSnapshot = null;
  app.weatherSnapshotKey = autonomySelectionKey(user.userId, agent.id);
  app.weatherRequestSequence += 1;
  if (app.state?.weatherAvailable === false) {
    renderWeatherUnavailable("当前启动方式没有接入每日天气服务。");
  } else {
    void loadWeatherPanel(user.userId, agent.id);
  }
  app.autonomySnapshot = null;
  app.autonomySnapshotKey = autonomySelectionKey(user.userId, agent.id);
  app.autonomyRequestSequence += 1;
  if (app.state?.autonomyAvailable === false) {
    renderAutonomyUnavailable(
      "当前启动方式没有接入自主生活服务。已有自主经历不会被删除。",
    );
  } else {
    void loadAutonomyPanel(user.userId, agent.id);
  }

  $("#export-card").addEventListener("click", () => {
    const query = new URLSearchParams({
      userId: user.userId,
      agentId: agent.id,
      version: "3",
    });
    window.location.assign(`/api/agents/export?${query}`);
  });

  $("#activate-agent").addEventListener("click", async () => {
    await mutate("/api/agents/activate", "POST", {
      userId: user.userId,
      agentId: agent.id,
    });
    toast(`已切换到 ${agent.name}。`);
    await refreshState();
  });

  $("#clear-memory").addEventListener("click", async () => {
    if (!confirm(`确定永久删除“${agent.name}”的 ${agent.totalMemoryCount || 0} 条完整聊天、摘要和长期记忆吗？`)) return;
    await mutate("/api/agents/clear-memory", "POST", {
      userId: user.userId,
      agentId: agent.id,
    });
    toast("完整聊天和全部记忆已清空。");
    await refreshState();
  });

  $("#view-history").addEventListener("click", () => {
    void openHistoryDialog(user.userId, agent);
  });

  $("#view-summary-history").addEventListener("click", () => {
    void openMemorySummaryHistoryDialog(user.userId, agent);
  });
  $("#view-episode-archive").addEventListener("click", () => {
    void openMemoryEpisodeArchiveDialog(user.userId, agent);
  });

  $("#view-prompts").addEventListener("click", () => {
    void openPromptTraceDialog(user.userId, agent);
  });

  $("#delete-agent").addEventListener("click", async () => {
    if (!confirm(`确定删除“${agent.name}”及其全部记忆吗？`)) return;
    await mutate("/api/agents", "DELETE", {
      userId: user.userId,
      agentId: agent.id,
    });
    app.selectedAgentId = "";
    clearPersonaDraft({ clearRequest: true });
    toast("Agent 已删除。");
    await refreshState();
  });
}

function renderWeatherLoading() {
  return `
    <div class="weather-panel-head">
      <div>
        <span class="mini-label">TOOLS / DAILY WEATHER</span>
        <h4 id="weather-panel-title">每日天气</h4>
      </div>
      <span class="autonomy-state">读取中</span>
    </div>
    <div class="autonomy-panel-message">正在读取天气工具与定时任务…</div>`;
}

function renderWeatherUnavailable(message) {
  const panel = $("#weather-panel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="weather-panel-head">
      <div>
        <span class="mini-label">TOOLS / DAILY WEATHER</span>
        <h4 id="weather-panel-title">每日天气</h4>
      </div>
      <span class="autonomy-state is-off">不可用</span>
    </div>
    <div class="autonomy-panel-message">${escapeHtml(message)}</div>`;
}

async function loadWeatherPanel(userId, agentId) {
  const key = autonomySelectionKey(userId, agentId);
  const requestSequence = ++app.weatherRequestSequence;
  app.weatherSnapshot = null;
  app.weatherSnapshotKey = key;
  const panel = $("#weather-panel");
  if (panel) panel.innerHTML = renderWeatherLoading();
  try {
    const query = new URLSearchParams({ userId, agentId });
    const response = await fetch(`/api/agents/weather?${query}`, {
      headers: { Accept: "application/json" },
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 404 || response.status === 503) {
      if (
        requestSequence === app.weatherRequestSequence &&
        autonomySelectionMatches(userId, agentId)
      ) {
        renderWeatherUnavailable(
          result.error || "当前启动方式没有接入每日天气服务。",
        );
      }
      return;
    }
    if (!response.ok) {
      throw new Error(result.error || "无法读取每日天气状态。");
    }
    if (
      requestSequence !== app.weatherRequestSequence ||
      !autonomySelectionMatches(userId, agentId)
    ) {
      return;
    }
    app.weatherSnapshot = normalizeWeatherSnapshot(
      result.weather ?? result.snapshot ?? result,
    );
    app.weatherSnapshotKey = key;
    renderWeatherPanel(app.weatherSnapshot);
  } catch (error) {
    if (
      requestSequence === app.weatherRequestSequence &&
      autonomySelectionMatches(userId, agentId)
    ) {
      renderWeatherUnavailable(error.message || "无法读取每日天气状态。");
    }
  }
}

function normalizeWeatherSnapshot(value) {
  const snapshot = value && typeof value === "object" ? value : {};
  return {
    enabled: snapshot.enabled === true,
    location: String(snapshot.location || ""),
    localTime: String(snapshot.localTime || "09:00"),
    timeZone: String(snapshot.timeZone || "Asia/Shanghai"),
    lastLocalDate: snapshot.lastLocalDate,
    lastRunAt: snapshot.lastRunAt,
    lastStatus: String(snapshot.lastStatus || "never"),
    lastError: String(snapshot.lastError || ""),
    lastMessage: String(snapshot.lastMessage || ""),
    deliveryAvailable: snapshot.deliveryAvailable === true,
    deliveryState: String(snapshot.deliveryState || "stale"),
    nextRunAt: snapshot.nextRunAt,
  };
}

function renderWeatherPanel(snapshot, options = {}) {
  const panel = $("#weather-panel");
  const user = currentUser();
  const agent = currentAgent();
  if (!panel || !user || !agent) return;
  const key = autonomySelectionKey(user.userId, agent.id);
  const busy = app.weatherBusyKeys.has(key);
  const deliveryLabel = {
    fresh: "微信回复凭证新鲜，可尝试发送",
    stale: "等待你再次给机器人发消息",
    unavailable: "仅后台模式，不能发送",
  }[snapshot.deliveryState] || "发送状态未知";
  const statusLabel = {
    never: "尚未运行",
    running: "执行中",
    waiting_context: "等待新消息",
    api_accepted: "微信接口已接受",
    failed: "执行失败",
    skipped: "已跳过",
  }[snapshot.lastStatus] || snapshot.lastStatus;
  panel.innerHTML = `
    <div class="weather-panel-head">
      <div>
        <span class="mini-label">TOOLS / DAILY WEATHER</span>
        <h4 id="weather-panel-title">每日天气</h4>
      </div>
      <span class="autonomy-state ${snapshot.enabled ? "is-on" : "is-off"}">
        ${snapshot.enabled ? "已开启" : "已关闭"}
      </span>
    </div>
    <p class="weather-intro">Agent 在聊天中可按需调用实时天气工具；这里可以额外设置每天主动发送。天气数据由程序保持准确，后面的一小句会由当前人物现场生成。</p>
    <form class="weather-form" id="weather-form">
      <label>
        天气地点
        <input name="location" maxlength="80" required value="${escapeAttr(snapshot.location)}" placeholder="例如：上海">
      </label>
      <label>
        每日时间
        <input name="localTime" type="time" required value="${escapeAttr(snapshot.localTime)}">
      </label>
      <label>
        时区
        <input name="timeZone" maxlength="100" required value="${escapeAttr(snapshot.timeZone)}" placeholder="Asia/Shanghai">
      </label>
      <label class="weather-switch">
        <input name="enabled" type="checkbox"${snapshot.enabled ? " checked" : ""}>
        <span>启用每日发送</span>
      </label>
      <div class="weather-actions">
        <button class="button primary" type="submit"${busy ? " disabled" : ""}>${busy ? "处理中…" : "保存设置"}</button>
        <button class="button ghost" type="button" id="weather-preview"${busy || !snapshot.location ? " disabled" : ""}>预览</button>
        <button class="button ghost" type="button" id="weather-send-now"${busy || !snapshot.location || !snapshot.deliveryAvailable ? " disabled" : ""}>立即测试发送</button>
      </div>
    </form>
    <div class="weather-overview">
      <div><span>主动发送通道</span><strong>${escapeHtml(deliveryLabel)}</strong></div>
      <div><span>下次计划</span><strong>${escapeHtml(snapshot.nextRunAt || "开启并保存后计算")}</strong></div>
      <div><span>最近状态</span><strong>${escapeHtml(statusLabel)}${snapshot.lastRunAt ? ` · ${escapeHtml(formatTimestamp(snapshot.lastRunAt))}` : ""}</strong></div>
    </div>
    ${
      options.previewMessage
        ? `<div class="weather-preview"><b>消息预览</b><p>${escapeHtml(options.previewMessage)}</p></div>`
        : snapshot.lastMessage
          ? `<div class="weather-preview"><b>最近提交的消息</b><p>${escapeHtml(snapshot.lastMessage)}</p></div>`
          : ""
    }
    ${
      options.errorMessage || snapshot.lastError
        ? `<div class="autonomy-inline-error">${escapeHtml(options.errorMessage || snapshot.lastError)}</div>`
        : ""
    }`;
  bindWeatherPanelActions(user.userId, agent.id);
}

function bindWeatherPanelActions(userId, agentId) {
  $("#weather-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveWeatherSettings(userId, agentId, event.currentTarget);
  });
  $("#weather-preview")?.addEventListener("click", () => {
    void runWeatherAction(userId, agentId, "preview");
  });
  $("#weather-send-now")?.addEventListener("click", () => {
    void runWeatherAction(userId, agentId, "send-now");
  });
}

async function saveWeatherSettings(userId, agentId, formElement) {
  const key = autonomySelectionKey(userId, agentId);
  const form = new FormData(formElement);
  const body = {
    userId,
    agentId,
    enabled: form.get("enabled") === "on",
    location: String(form.get("location") || ""),
    localTime: String(form.get("localTime") || ""),
    timeZone: String(form.get("timeZone") || ""),
  };
  await mutateWeatherPanel(userId, agentId, async () => {
    const result = await mutate(
      "/api/agents/weather/settings",
      "POST",
      body,
    );
    if (
      autonomySelectionMatches(userId, agentId) &&
      app.weatherSnapshotKey === key
    ) {
      app.weatherSnapshot = normalizeWeatherSnapshot(result.weather);
      toast("每日天气设置已保存。");
    }
    return {};
  });
}

async function runWeatherAction(userId, agentId, action) {
  const key = autonomySelectionKey(userId, agentId);
  await mutateWeatherPanel(userId, agentId, async () => {
    const result = await mutate(
      `/api/agents/weather/${action}`,
      "POST",
      { userId, agentId },
    );
    if (action === "preview") {
      if (
        autonomySelectionMatches(userId, agentId) &&
        app.weatherSnapshotKey === key
      ) {
        toast("天气消息预览已生成。");
      }
      return { previewMessage: result.preview?.message || "" };
    }
    if (
      autonomySelectionMatches(userId, agentId) &&
      app.weatherSnapshotKey === key
    ) {
      app.weatherSnapshot = normalizeWeatherSnapshot(result.weather);
      toast("天气消息已提交给微信接口。");
    }
    return {};
  });
}

async function mutateWeatherPanel(userId, agentId, operation) {
  const key = autonomySelectionKey(userId, agentId);
  if (
    app.weatherBusyKeys.has(key) ||
    !autonomySelectionMatches(userId, agentId) ||
    app.weatherSnapshotKey !== key ||
    !app.weatherSnapshot
  ) {
    return;
  }
  app.weatherBusyKeys.add(key);
  renderWeatherPanel(app.weatherSnapshot);
  let options = {};
  try {
    options = (await operation()) || {};
  } catch (error) {
    options = { errorMessage: error.message || "天气操作失败。" };
  } finally {
    app.weatherBusyKeys.delete(key);
    if (
      autonomySelectionMatches(userId, agentId) &&
      app.weatherSnapshotKey === key &&
      app.weatherSnapshot
    ) {
      renderWeatherPanel(app.weatherSnapshot, options);
    }
  }
}

function autonomySelectionKey(userId, agentId) {
  return `${userId}\0${agentId}`;
}

function autonomySelectionMatches(userId, agentId) {
  return (
    currentUser()?.userId === userId &&
    currentAgent()?.id === agentId
  );
}

function renderAutonomyLoading() {
  return `
    <div class="autonomy-panel-head">
      <div>
        <span class="mini-label">AUTONOMOUS LIFE</span>
        <h4 id="autonomy-panel-title">自主生活</h4>
      </div>
      <span class="autonomy-state">读取中</span>
    </div>
    <div class="autonomy-panel-message">正在读取这个人物的自主经历…</div>`;
}

function renderAutonomyUnavailable(message) {
  const panel = $("#autonomy-panel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="autonomy-panel-head">
      <div>
        <span class="mini-label">AUTONOMOUS LIFE</span>
        <h4 id="autonomy-panel-title">自主生活</h4>
      </div>
      <span class="autonomy-state is-off">不可用</span>
    </div>
    <div class="autonomy-panel-message">${escapeHtml(message)}</div>
    <div class="autonomy-actions" aria-label="自主生活控制">
      <button class="button ghost" type="button" disabled>开启</button>
      <button class="button ghost" type="button" disabled>关闭</button>
      <button class="button primary" type="button" disabled>立即生成</button>
    </div>`;
}

function renderAutonomyFailure(message, retry = true) {
  const panel = $("#autonomy-panel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="autonomy-panel-head">
      <div>
        <span class="mini-label">AUTONOMOUS LIFE</span>
        <h4 id="autonomy-panel-title">自主生活</h4>
      </div>
      <span class="autonomy-state is-error">读取失败</span>
    </div>
    <div class="autonomy-panel-message error-copy">${escapeHtml(message)}</div>
    ${
      retry
        ? '<div class="autonomy-actions"><button class="button ghost" type="button" id="autonomy-retry">重新读取</button></div>'
        : ""
    }`;
  $("#autonomy-retry")?.addEventListener("click", () => {
    const user = currentUser();
    const agent = currentAgent();
    if (user && agent) void loadAutonomyPanel(user.userId, agent.id);
  });
}

async function loadAutonomyPanel(userId, agentId) {
  const key = autonomySelectionKey(userId, agentId);
  const requestSequence = ++app.autonomyRequestSequence;
  app.autonomySnapshot = null;
  app.autonomySnapshotKey = key;
  const panel = $("#autonomy-panel");
  if (panel) panel.innerHTML = renderAutonomyLoading();

  try {
    const query = new URLSearchParams({ userId, agentId, limit: "20" });
    const response = await fetch(`/api/agents/autonomy?${query}`, {
      headers: { Accept: "application/json" },
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 404 || response.status === 503) {
      if (
        requestSequence === app.autonomyRequestSequence &&
        autonomySelectionMatches(userId, agentId)
      ) {
        renderAutonomyUnavailable(
          result.error || "当前启动方式没有接入自主生活服务。",
        );
      }
      return;
    }
    if (!response.ok) {
      throw new Error(result.error || "无法读取自主生活状态。");
    }
    if (
      requestSequence !== app.autonomyRequestSequence ||
      !autonomySelectionMatches(userId, agentId)
    ) {
      return;
    }
    const snapshot = normalizeAutonomySnapshot(
      result.autonomy ?? result.snapshot ?? result,
    );
    app.autonomySnapshot = snapshot;
    app.autonomySnapshotKey = key;
    renderAutonomyPanel(snapshot);
  } catch (error) {
    if (
      requestSequence === app.autonomyRequestSequence &&
      autonomySelectionMatches(userId, agentId)
    ) {
      renderAutonomyFailure(error.message || "无法读取自主生活状态。");
    }
  }
}

function normalizeAutonomySnapshot(value) {
  const snapshot = value && typeof value === "object" ? value : {};
  const events = Array.isArray(snapshot.events)
    ? [...snapshot.events]
        .sort(
          (left, right) =>
            Date.parse(right?.createdAt || "") -
            Date.parse(left?.createdAt || ""),
        )
        .slice(0, 20)
    : [];
  const parsedCount = Number(snapshot.eventCount);
  return {
    enabled: snapshot.enabled === true,
    enabledAt: snapshot.enabledAt,
    lastEvaluatedAt: snapshot.lastEvaluatedAt,
    lastGeneratedAt: snapshot.lastGeneratedAt,
    lastContactAttemptAt: snapshot.lastContactAttemptAt,
    lastInteractionAt: snapshot.lastInteractionAt,
    contactAvailable: snapshot.contactAvailable === true,
    eventCount: Number.isFinite(parsedCount)
      ? Math.max(0, parsedCount)
      : events.length,
    events,
  };
}

function renderAutonomyPanel(snapshot, options = {}) {
  const panel = $("#autonomy-panel");
  const user = currentUser();
  const agent = currentAgent();
  if (!panel || !user || !agent) return;
  const key = autonomySelectionKey(user.userId, agent.id);
  const busy = app.autonomyBusyKeys.has(key);
  const events = snapshot.events || [];
  const contactChannel = snapshot.contactAvailable
    ? `微信 iLink · 可尝试联系${
        snapshot.lastInteractionAt
          ? ` · 最近互动于 ${formatTimestamp(snapshot.lastInteractionAt)}`
          : ""
      }`
    : "微信 iLink · 等待用户再次发消息";
  panel.innerHTML = `
    <div class="autonomy-panel-head">
      <div>
        <span class="mini-label">AUTONOMOUS LIFE</span>
        <h4 id="autonomy-panel-title">自主生活</h4>
      </div>
      <span class="autonomy-state ${snapshot.enabled ? "is-on" : "is-off"}">
        ${snapshot.enabled ? "已开启" : "已关闭"}
      </span>
    </div>
    <div class="autonomy-overview">
      <div>
        <span>自主经历</span>
        <strong>${escapeHtml(snapshot.eventCount)}</strong>
      </div>
      <div>
        <span>最近检查</span>
        <strong>${escapeHtml(snapshot.lastEvaluatedAt ? formatTimestamp(snapshot.lastEvaluatedAt) : "暂无")}</strong>
      </div>
      <div>
        <span>最近记录</span>
        <strong>${escapeHtml(snapshot.lastGeneratedAt ? formatTimestamp(snapshot.lastGeneratedAt) : "暂无")}</strong>
      </div>
      <div class="autonomy-channel">
        <span>主动联系通道</span>
        <strong>${escapeHtml(contactChannel)}</strong>
      </div>
    </div>
    ${
      options.errorMessage
        ? `<div class="autonomy-inline-error">${escapeHtml(options.errorMessage)}</div>`
        : ""
    }
    <div class="autonomy-toolbar">
      <p>“立即生成”只会写入一段新经历，不会主动联系用户。</p>
      <div class="autonomy-actions" aria-label="自主生活控制">
        <button class="button ghost" type="button" id="autonomy-enable"${snapshot.enabled || busy ? " disabled" : ""}>开启</button>
        <button class="button ghost" type="button" id="autonomy-disable"${!snapshot.enabled || busy ? " disabled" : ""}>关闭</button>
        <button class="button primary" type="button" id="autonomy-generate"${busy ? " disabled" : ""}>${busy ? "处理中…" : "立即生成"}</button>
      </div>
    </div>
    <div class="autonomy-event-list" aria-label="最近自主经历">
      ${
        events.length
          ? events.map(renderAutonomyEvent).join("")
          : '<div class="autonomy-empty">还没有自主经历。可以等待自动生成，或点击“立即生成”创建第一条。</div>'
      }
    </div>`;
  bindAutonomyPanelActions(user.userId, agent.id);
}

function renderAutonomyEvent(event) {
  const importance = Math.max(
    1,
    Math.min(5, Number.parseInt(event?.importance, 10) || 1),
  );
  const contact = autonomyContactStatus(event?.contactStatus);
  const eventKind = autonomyEventKindLabel(event?.eventKind);
  const rawConversationValue = Number.parseInt(event?.conversationValue, 10);
  const conversationValue = Number.isFinite(rawConversationValue)
    ? Math.max(1, Math.min(5, rawConversationValue))
    : 0;
  return `
    <article class="autonomy-event">
      <header>
        <time datetime="${escapeAttr(event?.createdAt || "")}">${escapeHtml(formatTimestamp(event?.createdAt))}</time>
        ${eventKind ? `<span class="autonomy-importance">${escapeHtml(eventKind)}</span>` : ""}
        <span class="autonomy-importance">重要度 ${escapeHtml(importance)}/5</span>
        ${conversationValue ? `<span class="autonomy-importance">可聊性 ${escapeHtml(conversationValue)}/5</span>` : ""}
        <span class="autonomy-contact-status ${contact.className}">${escapeHtml(contact.label)}</span>
      </header>
      <p class="autonomy-summary">${escapeHtml(event?.summary || "未提供经历摘要。")}</p>
      <p class="autonomy-mood"><b>当前心境</b>${escapeHtml(event?.mood || "未记录")}</p>
      ${
        event?.conversationHook
          ? `<p class="autonomy-contact-detail"><b>可聊点</b>${escapeHtml(event.conversationHook)}</p>`
          : ""
      }
      ${
        event?.openThread
          ? `<p class="autonomy-contact-detail"><b>未决线索</b>${escapeHtml(event.openThread)}</p>`
          : ""
      }
      ${
        event?.contactReason
          ? `<p class="autonomy-contact-detail"><b>联系理由</b>${escapeHtml(event.contactReason)}</p>`
          : ""
      }
      ${
        event?.message
          ? `<p class="autonomy-contact-detail"><b>拟发送消息</b>${escapeHtml(event.message)}</p>`
          : ""
      }
    </article>`;
}

function autonomyEventKindLabel(kind) {
  const labels = {
    goal_progress: "目标进展",
    discovery: "新发现",
    decision: "作出决定",
    social: "现实互动",
    friction: "遇到阻碍",
    opportunity: "新机会",
    perspective_shift: "看法变化",
  };
  return labels[kind] || "";
}

function autonomyContactStatus(status) {
  const values = {
    not_requested: { label: "未计划联系", className: "is-idle" },
    pending: { label: "等待联系", className: "is-pending" },
    attempted: { label: "已尝试联系", className: "is-attempted" },
    failed: { label: "联系失败", className: "is-failed" },
  };
  return values[status] || values.not_requested;
}

function bindAutonomyPanelActions(userId, agentId) {
  $("#autonomy-enable")?.addEventListener("click", () => {
    void updateAutonomySetting(userId, agentId, true);
  });
  $("#autonomy-disable")?.addEventListener("click", () => {
    void updateAutonomySetting(userId, agentId, false);
  });
  $("#autonomy-generate")?.addEventListener("click", () => {
    void generateAutonomyEvent(userId, agentId);
  });
}

async function updateAutonomySetting(userId, agentId, enabled) {
  await mutateAutonomyPanel({
    userId,
    agentId,
    url: "/api/agents/autonomy/settings",
    body: { userId, agentId, enabled },
    successMessage: enabled
      ? "已开启这个人物的自主生活。"
      : "已关闭自主生活，已有经历会保留。",
  });
}

async function generateAutonomyEvent(userId, agentId) {
  await mutateAutonomyPanel({
    userId,
    agentId,
    url: "/api/agents/autonomy/generate",
    body: { userId, agentId },
    successMessage: "新的自主经历已经生成，不会主动联系用户。",
  });
}

async function mutateAutonomyPanel({
  userId,
  agentId,
  url,
  body,
  successMessage,
}) {
  const key = autonomySelectionKey(userId, agentId);
  if (app.autonomyBusyKeys.has(key)) return;
  if (
    !autonomySelectionMatches(userId, agentId) ||
    app.autonomySnapshotKey !== key ||
    !app.autonomySnapshot
  ) {
    return;
  }
  app.autonomyBusyKeys.add(key);
  renderAutonomyPanel(app.autonomySnapshot);
  let inlineError = "";
  try {
    const result = await mutate(url, "POST", body);
    if (!autonomySelectionMatches(userId, agentId)) return;
    const rawSnapshot = result.autonomy ?? result.snapshot;
    if (rawSnapshot) {
      app.autonomySnapshot = normalizeAutonomySnapshot(rawSnapshot);
      app.autonomySnapshotKey = key;
    } else {
      await loadAutonomyPanel(userId, agentId);
    }
    toast(successMessage);
  } catch (error) {
    inlineError = error.message || "操作失败，请稍后重试。";
  } finally {
    app.autonomyBusyKeys.delete(key);
    if (
      autonomySelectionMatches(userId, agentId) &&
      app.autonomySnapshotKey === key &&
      app.autonomySnapshot
    ) {
      renderAutonomyPanel(app.autonomySnapshot, {
        ...(inlineError ? { errorMessage: inlineError } : {}),
      });
    }
  }
}

function personaProfileFromAgent(agent = currentAgent()) {
  if (!agent) return null;
  const roleplay = agent.roleplay || {};
  return {
    name: String(agent.name || "").trim(),
    identity: String(agent.identity || "").trim(),
    conversationMode:
      agent.conversationMode || (agent.roleplay ? "roleplay" : "wechat"),
    roleplay: {
      nickname: String(roleplay.nickname || "").trim(),
      tags: Array.isArray(roleplay.tags) ? [...roleplay.tags] : [],
      personality: String(roleplay.personality || ""),
      scenario: String(roleplay.scenario || ""),
      stylePrompt: String(roleplay.stylePrompt || ""),
      firstMessage: String(roleplay.firstMessage || ""),
      alternateGreetings: Array.isArray(roleplay.alternateGreetings)
        ? [...roleplay.alternateGreetings]
        : [],
      exampleMessages: String(roleplay.exampleMessages || ""),
      systemPrompt: String(roleplay.systemPrompt || ""),
      postHistoryInstructions: String(
        roleplay.postHistoryInstructions || "",
      ),
    },
  };
}

async function generatePersonaDraft(target = "profile") {
  if (app.personaBusy || app.agentSaving) return;
  const user = currentUser();
  const agent = currentAgent();
  const styleOnly = target === "roleplayStyle";
  const input = styleOnly
    ? $("#roleplay-style-request")
    : $("#persona-request");
  const instruction = input.value.trim();
  const sourceDraft = personaProfileFromAgent(agent);
  if (!user || !agent || !sourceDraft) {
    toast("请先选择一个人物。", true);
    return;
  }
  const currentDraft = JSON.parse(JSON.stringify(sourceDraft));
  const styleField = $("#roleplay-style-prompt");
  if (
    styleField?.dataset.agentId === agent.id &&
    (!styleField.dataset.sourceUpdatedAt ||
      styleField.dataset.sourceUpdatedAt === agent.updatedAt)
  ) {
    currentDraft.roleplay.stylePrompt =
      styleField.value.trim();
  }
  if (!instruction) {
    toast(
      styleOnly
        ? "先描述你想要的情景模式文风。"
        : "先告诉助手你想怎样修改人物。",
      true,
    );
    input.focus();
    return;
  }
  if (app.state?.personaAssistantAvailable === false) {
    toast("人物设定助手当前不可用，请先配置远程模型。", true);
    return;
  }

  setPersonaBusy(true);
  const requestedUserId = user.userId;
  const requestedAgentId = agent.id;
  const requestSequence = ++app.personaRequestSequence;
  try {
    const result = await mutate("/api/agents/persona-draft", "POST", {
      userId: user.userId,
      agentId: agent.id,
      instruction,
      currentDraft,
      target,
    });
    if (
      !personaRequestMatches(
        requestSequence,
        requestedUserId,
        requestedAgentId,
      )
    ) {
      return;
    }
    app.personaDraft = result.profile;
    app.personaDraftAgentId = requestedAgentId;
    app.personaSourceUpdatedAt = result.sourceUpdatedAt || agent.updatedAt;
    app.personaSourceSnapshot = JSON.stringify(sourceDraft);
    app.personaWorkingSnapshot = JSON.stringify(currentDraft);
    app.personaDraftTarget = target;
    renderPersonaDraftResult(result, currentDraft);
    if (styleOnly) {
      setRoleplayStyleStatus(
        "AI 文风草稿已生成，请在右侧预览后应用并保存。",
        "saved",
      );
      $("#persona-result")?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
    $("#persona-assistant-status").textContent = "草稿就绪";
    $("#persona-assistant-status").className = "assistant-status ready";
  } catch (error) {
    if (
      personaRequestMatches(
        requestSequence,
        requestedUserId,
        requestedAgentId,
      )
    ) {
      $("#persona-assistant-status").textContent = "生成失败";
      $("#persona-assistant-status").className = "assistant-status";
      if (styleOnly) {
        setRoleplayStyleStatus(
          error.message || "AI 文风草稿生成失败。",
          "error",
        );
      }
    }
  } finally {
    if (app.personaRequestSequence === requestSequence) {
      setPersonaBusy(false);
    }
  }
}

async function saveRoleplayStylePrompt() {
  if (app.agentSaving || app.personaBusy) return;
  const user = currentUser();
  const agent = currentAgent();
  const field = $("#roleplay-style-prompt");
  if (!user || !agent) {
    toast("请先选择一个人物。", true);
    return;
  }
  if (
    field.dataset.agentId !== agent.id ||
    (field.dataset.sourceUpdatedAt &&
      field.dataset.sourceUpdatedAt !== agent.updatedAt)
  ) {
    renderRoleplayStyleEditor(agent);
    toast("人物设定已经变化，请确认最新内容后再保存。", true);
    return;
  }

  const stylePrompt = field.value.trim();
  const requestedUserId = user.userId;
  const requestedAgentId = agent.id;
  setAgentSaving(true);
  setRoleplayStyleStatus("正在保存文风 Prompt…");
  try {
    const result = await mutate(
      "/api/agents/update",
      "POST",
      {
        userId: user.userId,
        agentId: agent.id,
        expectedUpdatedAt: agent.updatedAt,
        name: agent.name,
        identity: agent.identity,
        ...(agent.providerId ? { providerId: agent.providerId } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        conversationMode:
          agent.conversationMode || (agent.roleplay ? "roleplay" : "wechat"),
        roleplay: {
          ...(agent.roleplay || {}),
          stylePrompt,
        },
      },
      { suppressErrorToast: true },
    );
    mergeUpdatedAgent(requestedUserId, result.agent);
    if (agentSelectionMatches(requestedUserId, requestedAgentId)) {
      clearPersonaDraft();
      const updated = currentAgent();
      renderCurrentPersonaSummary(updated);
      renderRoleplayStyleEditor(updated);
      setRoleplayStyleStatus(
        stylePrompt
          ? "文风 Prompt 已保存，仅在情景模式中生效。"
          : "文风 Prompt 已清空，将使用默认情景模式写法。",
        "saved",
      );
    }
    toast(`“${agent.name}”的情景模式文风已保存。`);
  } catch (error) {
    const message = error.message || "情景模式文风保存失败。";
    if (agentSelectionMatches(requestedUserId, requestedAgentId)) {
      setRoleplayStyleStatus(message, "error");
    }
    toast(`“${agent.name}”的文风保存失败：${message}`, true);
  } finally {
    setAgentSaving(false);
  }
}

function personaRequestMatches(sequence, userId, agentId) {
  return (
    app.personaRequestSequence === sequence &&
    currentUser()?.userId === userId &&
    currentAgent()?.id === agentId
  );
}

function agentSelectionMatches(userId, agentId) {
  return (
    currentUser()?.userId === userId &&
    currentAgent()?.id === agentId
  );
}

function personaSaveContextMatches(
  userId,
  agentId,
  draft,
  draftAgentId,
  sequence,
) {
  return (
    agentSelectionMatches(userId, agentId) &&
    app.personaDraft === draft &&
    app.personaDraftAgentId === draftAgentId &&
    app.personaRequestSequence === sequence
  );
}

function renderPersonaDraftResult(result, before) {
  const profile = result.profile;
  if (!profile) {
    $("#persona-result").innerHTML =
      '<div class="assistant-empty error-copy">模型没有返回可应用的人物草稿。</div>';
    return;
  }
  const changed = personaChangedFields(before, profile);
  $("#persona-result").innerHTML = `
    <div class="assistant-card">
      <h4>修改结果</h4>
      <p>${escapeHtml(result.summary || "已根据你的要求整理人物草稿。")}</p>
      <div class="assistant-diff-list">
        ${
          changed.length
            ? changed
                .map(
                  (change) => `
                    <article class="assistant-diff">
                      <div class="assistant-diff-head">
                        <b>${escapeHtml(change.label)}</b>
                        <span>已修改</span>
                      </div>
                      <div class="assistant-diff-block is-after">
                        <span>修改后</span>
                        <p>${escapeHtml(formatPersonaValue(change.path, change.after))}</p>
                      </div>
                      <div class="assistant-diff-block is-before">
                        <span>修改前</span>
                        <p>${escapeHtml(formatPersonaValue(change.path, change.before))}</p>
                      </div>
                    </article>`,
                )
                .join("")
            : '<div class="assistant-no-change">没有检测到实际修改，请换一种说法后重新生成。</div>'
        }
      </div>
    </div>
    <div class="assistant-result-actions">
      <button class="button primary assistant-save" type="button" id="persona-apply-save" data-can-apply="${changed.length ? "true" : "false"}"${changed.length ? "" : " disabled"}>应用并保存</button>
      <button class="button ghost" type="button" id="persona-discard">放弃草稿</button>
    </div>`;

  $("#persona-apply-save").addEventListener("click", () => {
    void applyPersonaDraft();
  });
  $("#persona-discard").addEventListener("click", clearPersonaDraft);
}

async function applyPersonaDraft() {
  if (app.agentSaving || app.personaBusy) return;
  const user = currentUser();
  const agent = currentAgent();
  const profile = app.personaDraft;
  if (
    !user ||
    !agent ||
    !profile ||
    app.personaDraftAgentId !== agent.id
  ) {
    toast("这份草稿已经不属于当前人物，请重新生成。", true);
    clearPersonaDraft();
    return;
  }
  if (
    app.personaSourceUpdatedAt &&
    agent.updatedAt &&
    app.personaSourceUpdatedAt !== agent.updatedAt
  ) {
    toast("人物已在草稿生成后发生变化，请重新生成以避免覆盖新内容。", true);
    clearPersonaDraft();
    return;
  }
  const currentSnapshot = personaProfileFromAgent(agent);
  if (
    !currentSnapshot ||
    !app.personaSourceSnapshot ||
    JSON.stringify(currentSnapshot) !== app.personaSourceSnapshot
  ) {
    toast("人物在草稿生成后发生了变化，请重新生成以避免覆盖。", true);
    clearPersonaDraft();
    return;
  }
  const currentWorkingSnapshot = JSON.parse(
    JSON.stringify(currentSnapshot),
  );
  const styleField = $("#roleplay-style-prompt");
  if (
    styleField?.dataset.agentId === agent.id &&
    (!styleField.dataset.sourceUpdatedAt ||
      styleField.dataset.sourceUpdatedAt === agent.updatedAt)
  ) {
    currentWorkingSnapshot.roleplay.stylePrompt =
      styleField.value.trim();
  }
  if (
    !app.personaWorkingSnapshot ||
    JSON.stringify(currentWorkingSnapshot) !== app.personaWorkingSnapshot
  ) {
    toast("人物输入在草稿生成后发生了变化，请重新生成。", true);
    clearPersonaDraft();
    return;
  }

  const savedDraft = app.personaDraft;
  const savedDraftAgentId = app.personaDraftAgentId;
  const savedDraftSequence = app.personaRequestSequence;
  setAgentSaving(true);
  $("#persona-assistant-status").textContent = "正在保存";
  $("#persona-assistant-status").className = "assistant-status busy";
  try {
    const result = await mutate(
      "/api/agents/update",
      "POST",
      {
        userId: user.userId,
        agentId: agent.id,
        expectedUpdatedAt: agent.updatedAt,
        name: profile.name,
        identity: profile.identity,
        ...(agent.providerId ? { providerId: agent.providerId } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        conversationMode: profile.conversationMode,
        roleplay: {
          ...(profile.roleplay || {}),
          ...(agent.roleplay?.writingStyleExamples
            ? {
                writingStyleExamples:
                  agent.roleplay.writingStyleExamples,
              }
            : {}),
          ...(agent.roleplay?.directorEvent
            ? { directorEvent: agent.roleplay.directorEvent }
            : {}),
          ...(agent.roleplay?.creator
            ? { creator: agent.roleplay.creator }
            : {}),
          ...(agent.roleplay?.characterVersion
            ? { characterVersion: agent.roleplay.characterVersion }
            : {}),
          ...(agent.roleplay?.creatorNotes
            ? { creatorNotes: agent.roleplay.creatorNotes }
            : {}),
          ...(agent.roleplay?.lorebook
            ? { lorebook: agent.roleplay.lorebook }
            : {}),
          ...(agent.roleplay?.characterCardExtensions
            ? {
                characterCardExtensions:
                  agent.roleplay.characterCardExtensions,
              }
            : {}),
        },
      },
      { suppressErrorToast: true },
    );
    mergeUpdatedAgent(user.userId, result.agent);
    if (
      personaSaveContextMatches(
        user.userId,
        agent.id,
        savedDraft,
        savedDraftAgentId,
        savedDraftSequence,
      )
    ) {
      clearPersonaDraft();
      renderAgents();
      if ($("#persona-dialog")?.open) $("#persona-dialog").close();
    }
    toast(`“${profile.name}”的人物设定已保存。`);
  } catch (error) {
    const message = error.message || "人物设定保存失败。";
    toast(`“${profile.name}”的人物设定保存失败：${message}`, true);
    if (
      personaSaveContextMatches(
        user.userId,
        agent.id,
        savedDraft,
        savedDraftAgentId,
        savedDraftSequence,
      )
    ) {
      $("#persona-assistant-status").textContent = "保存失败";
      $("#persona-assistant-status").className = "assistant-status";
    }
  } finally {
    setAgentSaving(false);
  }
}

function personaChangedFields(before, after) {
  const fields = [
    ["name", "名称"],
    ["identity", "身份描述"],
    ["conversationMode", "聊天表现"],
    ["roleplay.nickname", "角色昵称"],
    ["roleplay.tags", "标签"],
    ["roleplay.personality", "性格"],
    ["roleplay.scenario", "场景"],
    ["roleplay.stylePrompt", "情景模式文风"],
    ["roleplay.firstMessage", "开场白"],
    ["roleplay.alternateGreetings", "备用开场白"],
    ["roleplay.exampleMessages", "示例对话"],
    ["roleplay.systemPrompt", "系统提示词"],
    ["roleplay.postHistoryInstructions", "历史后指令"],
  ];
  return fields
    .map(([path, label]) => {
      const previous = valueAtPath(before, path);
      const next = valueAtPath(after, path);
      return {
        path,
        label,
        before: previous,
        after: next,
      };
    })
    .filter(
      ({ before: previous, after: next }) =>
        JSON.stringify(previous ?? "") !== JSON.stringify(next ?? ""),
    );
}

function valueAtPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function formatPersonaValue(path, value) {
  if (path === "conversationMode") {
    return value === "roleplay" ? "沉浸扮演" : "微信聊天";
  }
  if (Array.isArray(value)) {
    return value.length ? value.join("\n") : "（空）";
  }
  const text = String(value ?? "").trim();
  return text || "（空）";
}

function setPersonaBusy(busy) {
  app.personaBusy = busy;
  const assistant = $("#persona-assistant");
  const button = $("#persona-generate");
  const styleButton = $("#roleplay-style-generate");
  const styleSaveButton = $("#roleplay-style-save");
  const stylePrompt = $("#roleplay-style-prompt");
  const applyButton = $("#persona-apply-save");
  const discardButton = $("#persona-discard");
  assistant.setAttribute("aria-busy", busy ? "true" : "false");
  button.disabled = busy || !personaAssistantIsAvailable(currentAgent());
  styleButton.disabled =
    busy || !personaAssistantIsAvailable(currentAgent());
  styleSaveButton.disabled = busy || !currentAgent();
  stylePrompt.disabled = busy || app.agentSaving || !currentAgent();
  renderWritingStyleExamplesLauncher(currentAgent());
  if ($("#writing-examples-dialog")?.open) {
    renderWritingStyleExamplesManager();
  }
  if (applyButton) {
    applyButton.disabled =
      busy ||
      app.agentSaving ||
      applyButton.dataset.canApply !== "true";
  }
  if (discardButton) discardButton.disabled = busy || app.agentSaving;
  if (busy) {
    button.textContent = "正在生成…";
    styleButton.textContent = "正在生成…";
    $("#persona-assistant-status").textContent = "思考中";
    $("#persona-assistant-status").className = "assistant-status busy";
  } else {
    button.textContent = "生成修改草稿";
    styleButton.textContent = "AI 生成详细规则";
  }
}

function setAgentSaving(saving) {
  app.agentSaving = saving;
  const agent = currentAgent();
  const available = personaAssistantIsAvailable(agent);
  $("#persona-generate").disabled =
    saving || app.personaBusy || !available;
  $("#roleplay-style-generate").disabled =
    saving || app.personaBusy || !available;
  $("#roleplay-style-save").disabled =
    saving || app.personaBusy || !agent;
  $("#roleplay-style-prompt").disabled =
    saving || app.personaBusy || !agent;
  renderWritingStyleExamplesLauncher(agent);
  if ($("#writing-examples-dialog")?.open) {
    renderWritingStyleExamplesManager();
  }
  const applyButton = $("#persona-apply-save");
  const discardButton = $("#persona-discard");
  if (applyButton) {
    applyButton.disabled =
      saving ||
      app.personaBusy ||
      applyButton.dataset.canApply !== "true";
  }
  if (discardButton) discardButton.disabled = saving || app.personaBusy;
}

function renderPersonaAssistantContext() {
  const agent = currentAgent();
  const status = $("#persona-assistant-status");
  const button = $("#persona-generate");
  const input = $("#persona-request");
  const shortcuts = $$("[data-persona-prompt]");
  const styleInput = $("#roleplay-style-request");
  const styleButton = $("#roleplay-style-generate");
  const styleSaveButton = $("#roleplay-style-save");
  const styleShortcuts = $$("[data-style-prompt]");
  $("#persona-dialog-title").textContent = agent
    ? `${agent.name} · 人物设定`
    : "人物设定";
  renderCurrentPersonaSummary(agent);
  renderWritingStyleExamplesLauncher(agent);
  if (
    !agent ||
    $("#roleplay-style-prompt")?.dataset.agentId !== agent.id ||
    $("#roleplay-style-prompt")?.dataset.sourceUpdatedAt !==
      (agent.updatedAt || "")
  ) {
    renderRoleplayStyleEditor(agent);
  }
  if (!agent) {
    $("#persona-assistant-context").textContent =
      "选择人物后，可以让 AI 帮你深化设定、检查矛盾或调整说话方式。";
    status.textContent = "待命";
    status.className = "assistant-status";
    button.disabled = true;
    input.disabled = true;
    styleInput.disabled = true;
    styleButton.disabled = true;
    styleSaveButton.disabled = true;
    shortcuts.forEach((item) => {
      item.disabled = true;
    });
    styleShortcuts.forEach((item) => {
      item.disabled = true;
    });
    return;
  }

  const providerId = agent.providerId || app.state?.defaultProviderId || "未配置";
  const provider = app.state?.providers?.find((item) => item.id === providerId);
  const available = personaAssistantIsAvailable(agent);
  $("#persona-assistant-context").textContent =
    `正在辅助修改“${agent.name}”。草稿使用 ${provider?.label || providerId} 生成并自动复核原意；确认后可直接保存，不会改动记忆或世界书。`;
  status.textContent = available ? "可使用" : "模型未配置";
  status.className = available ? "assistant-status ready" : "assistant-status";
  button.disabled = !available || app.personaBusy || app.agentSaving;
  input.disabled = !available;
  styleInput.disabled = !available;
  styleButton.disabled =
    !available || app.personaBusy || app.agentSaving;
  styleSaveButton.disabled = app.personaBusy || app.agentSaving;
  $("#roleplay-style-prompt").disabled =
    app.personaBusy || app.agentSaving;
  shortcuts.forEach((item) => {
    item.disabled = !available;
  });
  styleShortcuts.forEach((item) => {
    item.disabled = !available;
  });
}

function personaAssistantIsAvailable(agent) {
  if (!agent || app.state?.personaAssistantAvailable === false) return false;
  const providerId = agent.providerId || app.state?.defaultProviderId;
  const provider = app.state?.providers?.find((item) => item.id === providerId);
  return Boolean(provider && provider.api !== "echo" && provider.configured);
}

function writingExampleAssistantIsAvailable(agent) {
  if (
    !agent ||
    app.state?.writingExampleAssistantAvailable === false
  ) {
    return false;
  }
  const providerId = agent.providerId || app.state?.defaultProviderId;
  const provider = app.state?.providers?.find((item) => item.id === providerId);
  return Boolean(provider && provider.api !== "echo" && provider.configured);
}

function renderRoleplayStyleEditor(agent) {
  const field = $("#roleplay-style-prompt");
  const saveButton = $("#roleplay-style-save");
  if (!field || !saveButton) return;
  if (!agent) {
    field.value = "";
    field.disabled = true;
    field.dataset.agentId = "";
    field.dataset.sourceUpdatedAt = "";
    saveButton.disabled = true;
    updateRoleplayStyleCounter();
    setRoleplayStyleStatus("选择人物后即可设置情景模式文风。");
    return;
  }

  const stylePrompt = String(agent.roleplay?.stylePrompt || "");
  field.value = stylePrompt;
  field.disabled = app.personaBusy || app.agentSaving;
  field.dataset.agentId = agent.id;
  field.dataset.sourceUpdatedAt = agent.updatedAt || "";
  saveButton.disabled = app.personaBusy || app.agentSaving;
  updateRoleplayStyleCounter();
  setRoleplayStyleStatus(
    stylePrompt.trim()
      ? "当前文风 Prompt 已保存，仅在情景模式中生效。"
      : "尚未为这个人物单独设置情景文风。",
    stylePrompt.trim() ? "saved" : "",
  );
}

function updateRoleplayStyleCounter() {
  const field = $("#roleplay-style-prompt");
  const counter = $("#roleplay-style-count");
  if (!field || !counter) return;
  counter.textContent = `${field.value.length} / 20000`;
}

function refreshRoleplayStyleDirtyStatus() {
  const agent = currentAgent();
  const field = $("#roleplay-style-prompt");
  if (!agent || !field || field.dataset.agentId !== agent.id) return;
  const saved = String(agent.roleplay?.stylePrompt || "").trim();
  const current = field.value.trim();
  setRoleplayStyleStatus(
    current === saved
      ? current
        ? "当前内容已保存。"
        : "尚未为这个人物单独设置情景文风。"
      : "有尚未保存的文风修改。",
    current === saved ? "saved" : "",
  );
}

function setRoleplayStyleStatus(message, kind = "") {
  const status = $("#roleplay-style-status");
  if (!status) return;
  status.textContent = message;
  status.className = [
    "roleplay-style-status",
    kind === "saved" ? "is-saved" : "",
    kind === "error" ? "is-error" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function renderWritingStyleExamplesLauncher(agent) {
  const count = $("#writing-examples-launch-count");
  const button = $("#open-writing-examples");
  if (!count || !button) return;
  const examples = Array.isArray(agent?.roleplay?.writingStyleExamples)
    ? agent.roleplay.writingStyleExamples
    : [];
  count.textContent = `${examples.length} 条示例`;
  button.disabled =
    !agent || app.agentSaving || app.personaBusy ||
    app.writingStyleExamplesSaving || app.writingExampleAiBusy;
}

function openWritingStyleExamplesDialog() {
  const agent = currentAgent();
  if (!agent) {
    toast("请先选择一个人物。", true);
    return;
  }
  resetWritingExampleAiState({ incrementSequence: true });
  app.writingStyleExamplesDraft = Array.isArray(
    agent.roleplay?.writingStyleExamples,
  )
    ? agent.roleplay.writingStyleExamples.map((item) => String(item))
    : [];
  app.writingStyleExamplesAgentId = agent.id;
  app.writingStyleExamplesSourceUpdatedAt = agent.updatedAt || "";
  app.writingStyleExamplesSelectedIndex = app.writingStyleExamplesDraft.length
    ? 0
    : -1;
  $("#writing-examples-title").textContent = `${agent.name} · 写作示例库`;
  renderWritingStyleExamplesManager();
  const dialog = $("#writing-examples-dialog");
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => {
    if (app.writingStyleExamplesDraft.length) {
      const editor = $("#writing-example-editor");
      if (editor) editor.scrollTop = 0;
      $("#writing-example-text")?.focus({ preventScroll: true });
      return;
    }
    $("#writing-example-add")?.focus({ preventScroll: true });
  });
}

function renderWritingStyleExamplesManager() {
  const agent = currentAgent();
  const list = $("#writing-examples-list");
  const editor = $("#writing-example-editor");
  if (!list || !editor) return;
  const draft = app.writingStyleExamplesDraft;
  const busy = writingStyleExamplesBusy();
  const validSelection =
    app.writingStyleExamplesSelectedIndex >= 0 &&
    app.writingStyleExamplesSelectedIndex < draft.length;
  if (!validSelection) {
    app.writingStyleExamplesSelectedIndex = draft.length ? 0 : -1;
  }
  $("#writing-examples-agent").textContent = agent
    ? `当前人物：${agent.name}`
    : "尚未选择人物";
  $("#writing-example-add").disabled =
    busy || !agent || draft.length >= MAX_WRITING_STYLE_EXAMPLES;

  list.innerHTML = draft.length
    ? draft
        .map((example, index) => {
          const selected = index === app.writingStyleExamplesSelectedIndex;
          const preview = example.trim().replace(/\s+/g, " ") || "空白示例";
          return `
            <li class="writing-example-item${selected ? " selected" : ""}">
              <button
                class="writing-example-select"
                type="button"
                data-writing-example-action="select"
                data-index="${index}"
                aria-pressed="${selected ? "true" : "false"}"
                ${busy ? "disabled" : ""}
              >
                <span>示例 ${index + 1}</span>
                <p data-writing-example-preview="${index}">${escapeHtml(preview)}</p>
              </button>
              <div class="writing-example-order" role="group" aria-label="调整示例 ${index + 1} 的顺序">
                <button type="button" data-writing-example-action="up" data-index="${index}" aria-label="上移示例 ${index + 1}"${busy || index === 0 ? " disabled" : ""}>↑</button>
                <button type="button" data-writing-example-action="down" data-index="${index}" aria-label="下移示例 ${index + 1}"${busy || index === draft.length - 1 ? " disabled" : ""}>↓</button>
                <button class="is-delete" type="button" data-writing-example-action="delete" data-index="${index}" aria-label="删除示例 ${index + 1}"${busy ? " disabled" : ""}>×</button>
              </div>
            </li>`;
        })
        .join("")
    : '<li class="writing-examples-empty">还没有写作示例。添加一段你认可的叙事文字，Agent 会学习它的写法。</li>';

  const selectedIndex = app.writingStyleExamplesSelectedIndex;
  if (selectedIndex < 0) {
    editor.innerHTML = `
      <div class="writing-example-editor-empty">
        <span>Aa</span>
        <h3>建立第一条风格参考</h3>
        <p>可以粘贴你自己写的段落，也可以保存喜欢的表达示例。请确保你有权使用这些内容。</p>
        <button class="button primary" type="button" data-writing-example-action="add"${busy ? " disabled" : ""}>添加第一条示例</button>
      </div>`;
  } else {
    const example = draft[selectedIndex] ?? "";
    editor.innerHTML = `
      <div class="writing-example-editor-head">
        <div>
          <span class="mini-label">WRITING SAMPLE ${selectedIndex + 1}</span>
          <h3>示例 ${selectedIndex + 1}</h3>
        </div>
        <span>只学习写法，不继承剧情</span>
      </div>
      <label for="writing-example-text">
        示例正文
        <textarea id="writing-example-text" maxlength="${MAX_WRITING_STYLE_EXAMPLE_TEXT}" rows="16" placeholder="粘贴一段能代表目标文风的文字。建议包含完整的句子、段落节奏和你希望 Agent 模仿的描写方式。"${busy ? " disabled" : ""}>${escapeHtml(example)}</textarea>
      </label>
      <div class="field-help">
        <span>示例中的人物、地点和事件不会被当作当前事实。</span>
        <span id="writing-example-char-count">${example.length} / ${MAX_WRITING_STYLE_EXAMPLE_TEXT}</span>
      </div>
      ${writingExampleAiPanelMarkup(example, selectedIndex, busy)}`;
  }
  updateWritingStyleExamplesCount();
  refreshWritingStyleExamplesStatus();
}

function handleWritingStyleExampleAction(action, index) {
  if (writingStyleExamplesBusy()) return;
  resetWritingExampleAiState({ incrementSequence: true });
  let focusSelector = "";
  if (action === "select") {
    if (index < 0 || index >= app.writingStyleExamplesDraft.length) return;
    app.writingStyleExamplesSelectedIndex = index;
    focusSelector = "#writing-example-text";
  } else if (action === "up" && index > 0) {
    const draft = app.writingStyleExamplesDraft;
    [draft[index - 1], draft[index]] = [draft[index], draft[index - 1]];
    app.writingStyleExamplesSelectedIndex = index - 1;
    focusSelector = `[data-writing-example-action="up"][data-index="${index - 1}"]`;
  } else if (
    action === "down" &&
    index >= 0 &&
    index < app.writingStyleExamplesDraft.length - 1
  ) {
    const draft = app.writingStyleExamplesDraft;
    [draft[index + 1], draft[index]] = [draft[index], draft[index + 1]];
    app.writingStyleExamplesSelectedIndex = index + 1;
    focusSelector = `[data-writing-example-action="down"][data-index="${index + 1}"]`;
  } else if (action === "delete") {
    if (index < 0 || index >= app.writingStyleExamplesDraft.length) return;
    app.writingStyleExamplesDraft.splice(index, 1);
    app.writingStyleExamplesSelectedIndex = Math.min(
      index,
      app.writingStyleExamplesDraft.length - 1,
    );
    focusSelector = app.writingStyleExamplesDraft.length
      ? `[data-writing-example-action="select"][data-index="${app.writingStyleExamplesSelectedIndex}"]`
      : "#writing-example-add";
  } else {
    return;
  }
  renderWritingStyleExamplesManager();
  requestAnimationFrame(() => {
    const preferred = focusSelector
      ? document.querySelector(focusSelector)
      : null;
    const fallback = app.writingStyleExamplesSelectedIndex >= 0
      ? document.querySelector(
          `[data-writing-example-action="select"][data-index="${app.writingStyleExamplesSelectedIndex}"]`,
        )
      : $("#writing-example-add");
    const target = preferred && !preferred.disabled ? preferred : fallback;
    target?.focus({ preventScroll: true });
  });
}

function addWritingStyleExample() {
  if (writingStyleExamplesBusy()) return;
  if (app.writingStyleExamplesDraft.length >= MAX_WRITING_STYLE_EXAMPLES) {
    setWritingStyleExamplesStatus("每个人物最多保存 20 条写作示例。", "error");
    return;
  }
  resetWritingExampleAiState({ incrementSequence: true });
  app.writingStyleExamplesDraft.push("");
  app.writingStyleExamplesSelectedIndex =
    app.writingStyleExamplesDraft.length - 1;
  renderWritingStyleExamplesManager();
  requestAnimationFrame(() => {
    const editor = $("#writing-example-editor");
    if (editor) editor.scrollTop = 0;
    $("#writing-example-text")?.focus({ preventScroll: true });
  });
}

function updateWritingStyleExampleEditorMeta() {
  const index = app.writingStyleExamplesSelectedIndex;
  const example = app.writingStyleExamplesDraft[index] ?? "";
  const counter = $("#writing-example-char-count");
  if (counter) {
    counter.textContent = `${example.length} / ${MAX_WRITING_STYLE_EXAMPLE_TEXT}`;
  }
  const preview = document.querySelector(
    `[data-writing-example-preview="${index}"]`,
  );
  if (preview) {
    preview.textContent =
      example.trim().replace(/\s+/g, " ") || "空白示例";
  }
  updateWritingStyleExamplesCount();
  refreshWritingStyleExamplesStatus();
}

function writingExampleAiPanelMarkup(example, index, busy) {
  const agent = currentAgent();
  const available = writingExampleAssistantIsAvailable(agent);
  const aiBusy = app.writingExampleAiBusy;
  const disabled = busy || !available;
  const statusText = aiBusy
    ? "思考中"
    : available
      ? "可使用"
      : "模型未配置";
  const statusClass = aiBusy ? "busy" : available ? "ready" : "";
  const canGenerate =
    !disabled &&
    Boolean(example.trim()) &&
    Boolean(app.writingExampleAiInstruction.trim());
  return `
    <section
      class="writing-example-ai"
      id="writing-example-ai"
      aria-labelledby="writing-example-ai-title"
      aria-busy="${aiBusy ? "true" : "false"}"
      data-index="${index}"
    >
      <div class="writing-example-ai-head">
        <div>
          <span class="mini-label">AI SAMPLE EDITOR</span>
          <h4 id="writing-example-ai-title">AI 改写助手</h4>
        </div>
        <span class="assistant-status ${statusClass}" id="writing-example-ai-status">${statusText}</span>
      </div>
      <p class="writing-example-ai-intro">告诉助手你想怎样修改当前示例。AI 会忠实按要求生成完整改写预览，不会直接覆盖正文，也不会自动保存。</p>
      <div class="assistant-prompts writing-example-ai-prompts" aria-label="示例改写快捷要求">
        <button type="button" data-writing-example-ai-action="shortcut" data-writing-example-ai-prompt="保持原有情节、人物关系和事件不变，增强环境与感官细节。"${disabled ? " disabled" : ""}>增强环境</button>
        <button type="button" data-writing-example-ai-action="shortcut" data-writing-example-ai-prompt="保持原意和全部事实不变，调整句子长短和段落节奏，让行文更自然。"${disabled ? " disabled" : ""}>调整节奏</button>
        <button type="button" data-writing-example-ai-action="shortcut" data-writing-example-ai-prompt="保持原意、情节和人物表现不变，减少不自然的比喻和刻意修辞。"${disabled ? " disabled" : ""}>减少比喻</button>
      </div>
      <label class="writing-example-ai-request" for="writing-example-ai-request">
        你希望怎样修改？
        <textarea
          id="writing-example-ai-request"
          rows="4"
          maxlength="8000"
          placeholder="例如：保留所有事件和对白，只把环境写得更有空间感，并增加 Agent 可观察到的细微动作。"
          ${disabled ? "disabled" : ""}
        >${escapeHtml(app.writingExampleAiInstruction)}</textarea>
      </label>
      <div class="writing-example-ai-generate-row">
        <span>生成后请先预览，再决定是否应用到当前示例。</span>
        <button
          class="button primary"
          type="button"
          id="writing-example-ai-generate"
          data-writing-example-ai-action="generate"
          ${canGenerate ? "" : "disabled"}
        >${aiBusy ? "正在生成…" : "生成改写预览"}</button>
      </div>
      <p
        class="visually-hidden"
        id="writing-example-ai-live"
        role="status"
        aria-live="polite"
      >${escapeHtml(writingExampleAiLiveMessage())}</p>
      <div
        class="writing-example-ai-result"
        id="writing-example-ai-result"
      >${writingExampleAiResultMarkup()}</div>
    </section>`;
}

function writingExampleAiResultMarkup() {
  if (app.writingExampleAiBusy) {
    return '<div class="writing-example-ai-empty is-busy">正在理解你的修改要求并复核原意，请稍候…</div>';
  }
  if (app.writingExampleAiError) {
    return `<div class="writing-example-ai-empty is-error">${escapeHtml(app.writingExampleAiError)}</div>`;
  }
  if (app.writingExampleAiDraft === null) {
    return '<div class="writing-example-ai-empty">改写结果会先显示在这里；在你点击“应用到当前示例”前，正文不会改变。</div>';
  }

  const current = writingExampleAiPreviewIsCurrent();
  const sourceText = app.writingExampleAiSourceText;
  const draftText = app.writingExampleAiDraft;
  const changed = draftText.trim() !== sourceText.trim();
  const modelLabel = [
    app.writingExampleAiProviderId,
    app.writingExampleAiModel,
  ].filter(Boolean).join(" / ");
  return `
    <article class="writing-example-ai-preview${current ? "" : " is-stale"}">
      <div class="writing-example-ai-preview-head">
        <div>
          <strong>${current ? "改写预览" : "这份预览已经过期"}</strong>
          <span>${escapeHtml(app.writingExampleAiSummary || (changed ? "已生成完整改写。" : "AI 返回的内容与当前示例相同。"))}</span>
        </div>
        ${modelLabel ? `<small>${escapeHtml(modelLabel)}</small>` : ""}
      </div>
      <div class="writing-example-ai-comparison">
        <section>
          <span>修改前</span>
          <div>${escapeHtml(sourceText)}</div>
        </section>
        <section class="is-after">
          <span>修改后</span>
          <div>${escapeHtml(draftText)}</div>
        </section>
      </div>
      <div class="writing-example-ai-result-actions">
        <span>${current ? "应用后仍需点击底部“保存示例库”。" : "正文或人物已变化，请重新生成。"}</span>
        <div>
          <button class="button ghost" type="button" data-writing-example-ai-action="discard">放弃预览</button>
          <button class="button primary" type="button" data-writing-example-ai-action="apply"${current && changed ? "" : " disabled"}>应用到当前示例</button>
        </div>
      </div>
    </article>`;
}

function renderWritingExampleAiPanel() {
  const panel = $("#writing-example-ai");
  const index = app.writingStyleExamplesSelectedIndex;
  if (!panel || index < 0) return;
  const example = app.writingStyleExamplesDraft[index] ?? "";
  panel.outerHTML = writingExampleAiPanelMarkup(
    example,
    index,
    writingStyleExamplesBusy(),
  );
}

function renderWritingExampleAiResult() {
  const result = $("#writing-example-ai-result");
  if (result) result.innerHTML = writingExampleAiResultMarkup();
  const live = $("#writing-example-ai-live");
  if (live) live.textContent = writingExampleAiLiveMessage();
}

function writingExampleAiLiveMessage() {
  if (app.writingExampleAiBusy) return "AI 正在生成改写预览。";
  if (app.writingExampleAiError) return app.writingExampleAiError;
  if (app.writingExampleAiDraft !== null) {
    return "AI 改写预览已经生成，正文尚未改变。";
  }
  return "";
}

function refreshWritingExampleAiControls() {
  const agent = currentAgent();
  const index = app.writingStyleExamplesSelectedIndex;
  const example = app.writingStyleExamplesDraft[index] ?? "";
  const available = writingExampleAssistantIsAvailable(agent);
  const busy = writingStyleExamplesBusy();
  const request = $("#writing-example-ai-request");
  const generate = $("#writing-example-ai-generate");
  const status = $("#writing-example-ai-status");
  if (request) request.disabled = busy || !available;
  if (generate) {
    generate.disabled =
      busy || !available || !example.trim() ||
      !app.writingExampleAiInstruction.trim();
    generate.textContent = app.writingExampleAiBusy
      ? "正在生成…"
      : "生成改写预览";
  }
  $$("[data-writing-example-ai-action='shortcut']").forEach((button) => {
    button.disabled = busy || !available;
  });
  if (status) {
    status.textContent = app.writingExampleAiBusy
      ? "思考中"
      : available
        ? "可使用"
        : "模型未配置";
    status.className = [
      "assistant-status",
      app.writingExampleAiBusy ? "busy" : available ? "ready" : "",
    ].filter(Boolean).join(" ");
  }
}

function handleWritingExampleAiAction(target) {
  const action = target.dataset.writingExampleAiAction;
  if (action === "shortcut") {
    if (writingStyleExamplesBusy()) return;
    clearWritingExampleAiResult({
      incrementSequence: true,
      preserveInstruction: false,
    });
    app.writingExampleAiInstruction =
      target.dataset.writingExampleAiPrompt || "";
    renderWritingExampleAiPanel();
    requestAnimationFrame(() => {
      $("#writing-example-ai-request")?.focus({ preventScroll: true });
    });
    return;
  }
  if (action === "generate") {
    void generateWritingExampleAiDraft();
    return;
  }
  if (action === "apply") {
    applyWritingExampleAiDraft();
    return;
  }
  if (action === "discard") {
    discardWritingExampleAiDraft();
  }
}

async function generateWritingExampleAiDraft() {
  if (writingStyleExamplesBusy()) return;
  const dialog = $("#writing-examples-dialog");
  const user = currentUser();
  const agent = currentAgent();
  const index = app.writingStyleExamplesSelectedIndex;
  const sourceText = app.writingStyleExamplesDraft[index] ?? "";
  const sourceUpdatedAt = agent?.updatedAt || "";
  const instruction = app.writingExampleAiInstruction.trim();
  if (!dialog?.open || !user || !agent || index < 0) {
    setWritingStyleExamplesStatus("当前示例已经变化，请重新打开示例库。", "error");
    return;
  }
  if (!writingExampleAssistantIsAvailable(agent)) {
    setWritingStyleExamplesStatus("AI 改写助手当前不可用，请先配置远程模型。", "error");
    return;
  }
  if (!sourceText.trim()) {
    setWritingStyleExamplesStatus("请先填写示例正文，再让 AI 修改。", "error");
    $("#writing-example-text")?.focus();
    return;
  }
  if (!instruction) {
    setWritingStyleExamplesStatus("先告诉 AI 你希望怎样修改当前示例。", "error");
    $("#writing-example-ai-request")?.focus();
    return;
  }
  if (
    !sourceUpdatedAt ||
    app.writingStyleExamplesAgentId !== agent.id ||
    app.writingStyleExamplesSourceUpdatedAt !== sourceUpdatedAt
  ) {
    setWritingStyleExamplesStatus(
      "人物设定已发生变化，请关闭并重新打开示例库。",
      "error",
    );
    return;
  }

  const requestSequence = ++app.writingExampleAiRequestSequence;
  app.writingExampleAiBusy = true;
  app.writingExampleAiAgentId = agent.id;
  app.writingExampleAiIndex = index;
  app.writingExampleAiSourceText = sourceText;
  app.writingExampleAiSourceUpdatedAt = sourceUpdatedAt;
  app.writingExampleAiPreviewSequence = 0;
  app.writingExampleAiDraft = null;
  app.writingExampleAiSummary = "";
  app.writingExampleAiProviderId = "";
  app.writingExampleAiModel = "";
  app.writingExampleAiError = "";
  const editor = $("#writing-example-editor");
  const previousScrollTop = editor?.scrollTop || 0;
  renderWritingStyleExamplesManager();
  if (editor) editor.scrollTop = previousScrollTop;
  setWritingStyleExamplesStatus("AI 正在生成改写预览…");

  const context = {
    agentId: agent.id,
    index,
    sourceText,
    sourceUpdatedAt,
    requestSequence,
  };
  try {
    const result = await mutate(
      "/api/agents/writing-example-draft",
      "POST",
      {
        userId: user.userId,
        agentId: agent.id,
        expectedUpdatedAt: sourceUpdatedAt,
        instruction,
        currentExample: sourceText,
      },
      { suppressErrorToast: true },
    );
    if (!writingExampleAiRequestMatches(context)) return;
    if (String(result.sourceUpdatedAt || "") !== sourceUpdatedAt) {
      throw new Error("人物设定在生成期间发生了变化，请重新生成。");
    }
    const draftText = String(result.example ?? "").trim();
    if (!draftText) throw new Error("AI 没有返回可用的示例正文。");
    if (draftText.length > MAX_WRITING_STYLE_EXAMPLE_TEXT) {
      throw new Error(
        `AI 返回的示例超过 ${MAX_WRITING_STYLE_EXAMPLE_TEXT} 个字符，请缩小修改范围后重试。`,
      );
    }
    app.writingExampleAiBusy = false;
    app.writingExampleAiPreviewSequence = requestSequence;
    app.writingExampleAiDraft = draftText;
    app.writingExampleAiSummary = String(result.summary || "").trim();
    app.writingExampleAiProviderId = String(result.providerId || "").trim();
    app.writingExampleAiModel = String(result.model || "").trim();
    renderWritingStyleExamplesManager();
    setWritingStyleExamplesStatus(
      "AI 改写预览已生成；正文尚未改变，也尚未保存。",
    );
    requestAnimationFrame(() => {
      const editor = $("#writing-example-editor");
      const resultPanel = $("#writing-example-ai-result");
      if (editor && resultPanel) {
        editor.scrollTo({
          top: Math.max(
            0,
            resultPanel.offsetTop - editor.offsetTop - 16,
          ),
          behavior: "smooth",
        });
      }
      const dialog = $("#writing-examples-dialog");
      if (dialog) dialog.scrollTop = 0;
    });
  } catch (error) {
    if (!writingExampleAiRequestMatches(context)) return;
    app.writingExampleAiBusy = false;
    app.writingExampleAiError =
      error.message || "AI 示例改写失败，请稍后重试。";
    renderWritingStyleExamplesManager();
    setWritingStyleExamplesStatus(app.writingExampleAiError, "error");
  }
}

function applyWritingExampleAiDraft() {
  if (writingStyleExamplesBusy()) return;
  if (!writingExampleAiPreviewIsCurrent()) {
    app.writingExampleAiError = "正文或人物已发生变化，请重新生成改写预览。";
    renderWritingExampleAiResult();
    return;
  }
  const index = app.writingExampleAiIndex;
  const draftText = String(app.writingExampleAiDraft || "").trim();
  if (!draftText || draftText.length > MAX_WRITING_STYLE_EXAMPLE_TEXT) {
    app.writingExampleAiError = "这份 AI 草稿无法应用，请重新生成。";
    renderWritingExampleAiResult();
    return;
  }
  app.writingStyleExamplesDraft[index] = draftText;
  clearWritingExampleAiResult({
    incrementSequence: true,
    preserveInstruction: true,
  });
  renderWritingStyleExamplesManager();
  setWritingStyleExamplesStatus(
    "AI 改写已应用到当前示例草稿，尚未保存。请确认后点击“保存示例库”。",
  );
  requestAnimationFrame(() => {
    $("#writing-example-text")?.focus({ preventScroll: true });
  });
}

function discardWritingExampleAiDraft() {
  if (writingStyleExamplesBusy()) return;
  clearWritingExampleAiResult({
    incrementSequence: true,
    preserveInstruction: true,
  });
  renderWritingExampleAiPanel();
  setWritingStyleExamplesStatus(
    writingStyleExamplesDirty()
      ? "已放弃 AI 预览；示例库仍有尚未保存的其他修改。"
      : "已放弃 AI 预览，示例正文未改变。",
  );
}

function writingExampleAiRequestMatches(context) {
  const agent = currentAgent();
  return Boolean(
    $("#writing-examples-dialog")?.open &&
    app.writingExampleAiRequestSequence === context.requestSequence &&
    app.writingExampleAiAgentId === context.agentId &&
    app.writingExampleAiIndex === context.index &&
    app.writingExampleAiSourceText === context.sourceText &&
    app.writingExampleAiSourceUpdatedAt === context.sourceUpdatedAt &&
    app.writingStyleExamplesAgentId === context.agentId &&
    app.writingStyleExamplesSelectedIndex === context.index &&
    app.writingStyleExamplesDraft[context.index] === context.sourceText &&
    app.writingStyleExamplesSourceUpdatedAt === context.sourceUpdatedAt &&
    agent?.id === context.agentId &&
    agent.updatedAt === context.sourceUpdatedAt
  );
}

function writingExampleAiPreviewIsCurrent() {
  if (
    app.writingExampleAiDraft === null ||
    app.writingExampleAiPreviewSequence !==
      app.writingExampleAiRequestSequence
  ) {
    return false;
  }
  return writingExampleAiRequestMatches({
    agentId: app.writingExampleAiAgentId,
    index: app.writingExampleAiIndex,
    sourceText: app.writingExampleAiSourceText,
    sourceUpdatedAt: app.writingExampleAiSourceUpdatedAt,
    requestSequence: app.writingExampleAiPreviewSequence,
  });
}

function writingExampleAiHasResult() {
  return Boolean(
    app.writingExampleAiBusy ||
    app.writingExampleAiDraft !== null ||
    app.writingExampleAiError,
  );
}

function clearWritingExampleAiResult({
  incrementSequence = false,
  preserveInstruction = true,
} = {}) {
  if (incrementSequence) app.writingExampleAiRequestSequence += 1;
  const instruction = preserveInstruction
    ? app.writingExampleAiInstruction
    : "";
  app.writingExampleAiInstruction = instruction;
  app.writingExampleAiBusy = false;
  app.writingExampleAiAgentId = "";
  app.writingExampleAiIndex = -1;
  app.writingExampleAiSourceText = "";
  app.writingExampleAiSourceUpdatedAt = "";
  app.writingExampleAiPreviewSequence = 0;
  app.writingExampleAiDraft = null;
  app.writingExampleAiSummary = "";
  app.writingExampleAiProviderId = "";
  app.writingExampleAiModel = "";
  app.writingExampleAiError = "";
}

function resetWritingExampleAiState({ incrementSequence = false } = {}) {
  clearWritingExampleAiResult({
    incrementSequence,
    preserveInstruction: false,
  });
}

function updateWritingStyleExamplesCount() {
  const count = app.writingStyleExamplesDraft.length;
  const total = app.writingStyleExamplesDraft.reduce(
    (sum, example) => sum + example.length,
    0,
  );
  $("#writing-examples-count").textContent =
    `${count} / ${MAX_WRITING_STYLE_EXAMPLES} 条 · ${total} / ${MAX_WRITING_STYLE_EXAMPLES_TEXT} 字`;
}

function validateWritingStyleExamplesDraft() {
  const draft = app.writingStyleExamplesDraft;
  if (draft.length > MAX_WRITING_STYLE_EXAMPLES) {
    return "每个人物最多保存 20 条写作示例。";
  }
  if (draft.some((example) => !example.trim())) {
    return "请填写或删除空白示例。";
  }
  if (draft.some((example) => example.trim().length > MAX_WRITING_STYLE_EXAMPLE_TEXT)) {
    return `每条示例不能超过 ${MAX_WRITING_STYLE_EXAMPLE_TEXT} 个字符。`;
  }
  const total = draft.reduce(
    (sum, example) => sum + example.trim().length,
    0,
  );
  if (total > MAX_WRITING_STYLE_EXAMPLES_TEXT) {
    return `示例总长度不能超过 ${MAX_WRITING_STYLE_EXAMPLES_TEXT} 个字符。`;
  }
  return "";
}

function normalizedWritingStyleExamplesDraft() {
  return app.writingStyleExamplesDraft.map((example) => example.trim());
}

function savedWritingStyleExamples(agent = currentAgent()) {
  return Array.isArray(agent?.roleplay?.writingStyleExamples)
    ? agent.roleplay.writingStyleExamples.map((item) => String(item).trim())
    : [];
}

function writingStyleExamplesDirty() {
  const agent = currentAgent();
  if (!agent || agent.id !== app.writingStyleExamplesAgentId) return false;
  return JSON.stringify(normalizedWritingStyleExamplesDraft()) !==
    JSON.stringify(savedWritingStyleExamples(agent));
}

function writingStyleExamplesBusy() {
  return Boolean(
    app.writingStyleExamplesSaving || app.writingExampleAiBusy ||
    app.agentSaving || app.personaBusy,
  );
}

function refreshWritingStyleExamplesStatus() {
  const validation = validateWritingStyleExamplesDraft();
  const dirty = writingStyleExamplesDirty();
  const save = $("#writing-examples-save");
  if (app.writingStyleExamplesSaving) {
    setWritingStyleExamplesStatus("正在保存示例库…");
  } else if (validation) {
    setWritingStyleExamplesStatus(validation, "error");
  } else if (dirty) {
    setWritingStyleExamplesStatus("有尚未保存的示例修改。");
  } else if (app.writingStyleExamplesDraft.length) {
    setWritingStyleExamplesStatus("当前示例库已保存。", "saved");
  } else {
    setWritingStyleExamplesStatus("尚未添加写作示例。");
  }
  save.disabled = writingStyleExamplesBusy() || Boolean(validation) || !dirty;
}

function setWritingStyleExamplesStatus(message, kind = "") {
  const status = $("#writing-examples-status");
  status.textContent = message;
  status.className = [
    kind === "saved" ? "is-saved" : "",
    kind === "error" ? "is-error" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function requestCloseWritingStyleExamplesDialog() {
  const dialog = $("#writing-examples-dialog");
  if (!dialog.open || app.writingStyleExamplesSaving) return;
  const warnings = [];
  if (app.writingExampleAiBusy) {
    warnings.push(
      "AI 改写仍在后台生成；关闭会放弃本次结果，立即重新生成时可能需要等待当前任务结束。",
    );
  } else if (app.writingExampleAiDraft !== null) {
    warnings.push("AI 改写预览尚未应用，关闭后会丢失这份预览。");
  }
  if (writingStyleExamplesDirty()) {
    warnings.push("写作示例还有尚未保存的修改，关闭后会丢失这些修改。");
  }
  if (warnings.length && !confirm(`${warnings.join("\n\n")}\n\n确定关闭吗？`)) {
    return;
  }
  dialog.close();
}

async function saveWritingStyleExamples() {
  if (writingStyleExamplesBusy()) return;
  const user = currentUser();
  const agent = currentAgent();
  const validation = validateWritingStyleExamplesDraft();
  if (!user || !agent || agent.id !== app.writingStyleExamplesAgentId) {
    setWritingStyleExamplesStatus("当前人物已经变化，请关闭后重新打开。", "error");
    return;
  }
  if (validation) {
    setWritingStyleExamplesStatus(validation, "error");
    return;
  }
  if (
    app.writingStyleExamplesSourceUpdatedAt &&
    app.writingStyleExamplesSourceUpdatedAt !== agent.updatedAt
  ) {
    setWritingStyleExamplesStatus(
      "人物设定已在其他位置更新，无法直接保存。当前草稿仍显示在编辑器中；请先复制备份，再关闭并重新打开示例库。",
      "error",
    );
    return;
  }

  const examples = normalizedWritingStyleExamplesDraft();
  const requestedUserId = user.userId;
  const requestedAgentId = agent.id;
  let saveError = "";
  app.writingStyleExamplesSaving = true;
  renderWritingStyleExamplesManager();
  try {
    const result = await mutate(
      "/api/agents/update",
      "POST",
      {
        userId: user.userId,
        agentId: agent.id,
        expectedUpdatedAt: agent.updatedAt,
        name: agent.name,
        identity: agent.identity,
        ...(agent.providerId ? { providerId: agent.providerId } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        conversationMode:
          agent.conversationMode || (agent.roleplay ? "roleplay" : "wechat"),
        roleplay: {
          ...(agent.roleplay || {}),
          writingStyleExamples: examples,
        },
      },
      { suppressErrorToast: true },
    );
    mergeUpdatedAgent(requestedUserId, result.agent);
    if (!agentSelectionMatches(requestedUserId, requestedAgentId)) return;
    const updated = currentAgent();
    const styleField = $("#roleplay-style-prompt");
    if (styleField?.dataset.agentId === requestedAgentId) {
      styleField.dataset.sourceUpdatedAt = updated.updatedAt || "";
      refreshRoleplayStyleDirtyStatus();
    }
    if (app.personaDraftAgentId === requestedAgentId) {
      app.personaSourceUpdatedAt = updated.updatedAt || "";
    }
    app.writingStyleExamplesDraft = [...examples];
    app.writingStyleExamplesSourceUpdatedAt = updated.updatedAt || "";
    renderCurrentPersonaSummary(updated);
    renderWritingStyleExamplesLauncher(updated);
    toast(`“${updated.name}”的写作示例库已保存。`);
    $("#writing-examples-dialog").close();
  } catch (error) {
    if (agentSelectionMatches(requestedUserId, requestedAgentId)) {
      saveError = error.message || "写作示例库保存失败。";
    }
  } finally {
    app.writingStyleExamplesSaving = false;
    if ($("#writing-examples-dialog")?.open) {
      renderWritingStyleExamplesManager();
      if (saveError) {
        setWritingStyleExamplesStatus(saveError, "error");
      }
    }
    renderWritingStyleExamplesLauncher(currentAgent());
  }
}

function renderCurrentPersonaSummary(agent) {
  const container = $("#current-persona-summary");
  if (!container) return;
  if (!agent) {
    container.innerHTML =
      '<div class="assistant-empty">选择人物后，这里会展示当前已保存的具体设定。</div>';
    return;
  }

  const roleplay = agent.roleplay || {};
  const mode =
    (agent.conversationMode || (agent.roleplay ? "roleplay" : "wechat")) ===
    "wechat"
      ? "微信聊天"
      : "沉浸扮演";
  const tags = Array.isArray(roleplay.tags) ? roleplay.tags : [];
  const lorebookEntries = Array.isArray(roleplay.lorebook?.entries)
    ? roleplay.lorebook.entries
    : [];
  const writingStyleExamples = Array.isArray(roleplay.writingStyleExamples)
    ? roleplay.writingStyleExamples
    : [];
  const metaTags = [
    ...(roleplay.nickname ? [`昵称：${roleplay.nickname}`] : []),
    ...tags,
    ...(roleplay.creator ? [`作者：${roleplay.creator}`] : []),
    ...(roleplay.characterVersion
      ? [`版本：${roleplay.characterVersion}`]
      : []),
    ...(lorebookEntries.length
      ? [`世界书：${lorebookEntries.length} 条`]
      : []),
    ...(writingStyleExamples.length
      ? [`写作示例：${writingStyleExamples.length} 条`]
      : []),
  ];
  const lorebookText = lorebookEntries
    .map((entry, index) => {
      const title = entry.name || `条目 ${index + 1}`;
      const keys = Array.isArray(entry.keys) ? entry.keys.join("、") : "";
      return [
        `${entry.enabled === false ? "（已停用）" : ""}${title}`,
        keys ? `关键词：${keys}` : "",
        entry.content || "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  const fields = [
    ["身份描述", agent.identity],
    ["性格", roleplay.personality],
    ["生活与场景", roleplay.scenario],
    ["情景模式文风 Prompt", roleplay.stylePrompt],
    ["开场白", roleplay.firstMessage],
    [
      "备用开场白",
      Array.isArray(roleplay.alternateGreetings)
        ? roleplay.alternateGreetings.join("\n")
        : "",
    ],
    ["示例对话", roleplay.exampleMessages],
    ["系统提示词", roleplay.systemPrompt],
    ["历史后指令", roleplay.postHistoryInstructions],
    ["作者备注", roleplay.creatorNotes],
    ["世界书设定", lorebookText],
  ].filter(([, value]) => String(value || "").trim());

  container.innerHTML = `
    <div class="saved-persona-head">
      <div>
        <span>CURRENT / SAVED</span>
        <strong>${escapeHtml(agent.name)}</strong>
      </div>
      <i class="saved-persona-mode">${escapeHtml(mode)}</i>
    </div>
    ${
      metaTags.length
        ? `<div class="saved-persona-tags">${metaTags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
        : ""
    }
    <div class="saved-persona-fields">
      ${
        fields.length
          ? fields
              .map(
                ([label, value]) => `
                  <div class="saved-persona-field">
                    <b>${escapeHtml(label)}</b>
                    <p>${escapeHtml(value)}</p>
                  </div>`,
              )
              .join("")
          : '<p class="saved-persona-empty">当前人物还没有补充更多设定。</p>'
      }
    </div>`;
}

function clearPersonaDraft({ clearRequest = false } = {}) {
  const result = $("#persona-result");
  const shouldRestoreDialogFocus = Boolean(
    $("#persona-dialog")?.open &&
    result?.contains(document.activeElement),
  );
  app.personaRequestSequence += 1;
  if (app.personaBusy) {
    app.personaBusy = false;
    $("#persona-assistant").setAttribute("aria-busy", "false");
    $("#persona-generate").textContent = "生成修改草稿";
    $("#roleplay-style-generate").textContent = "AI 生成详细规则";
  }
  app.personaDraft = null;
  app.personaDraftAgentId = "";
  app.personaSourceUpdatedAt = "";
  app.personaSourceSnapshot = "";
  app.personaWorkingSnapshot = "";
  app.personaDraftTarget = "";
  if (clearRequest) {
    const request = $("#persona-request");
    if (request) request.value = "";
    const styleRequest = $("#roleplay-style-request");
    if (styleRequest) styleRequest.value = "";
  }
  if (result) {
    result.innerHTML = `
      <div class="assistant-empty">
        AI 会先生成修改预览并复核是否忠实于原意。确认后可直接“应用并保存”，记忆和世界书不会被自动改写。
      </div>`;
  }
  renderPersonaAssistantContext();
  refreshRoleplayStyleDirtyStatus();
  if (shouldRestoreDialogFocus) {
    requestAnimationFrame(() => {
      const request = $("#persona-request");
      if (request && !request.disabled) request.focus();
      else $("#persona-close")?.focus();
    });
  }
}

function renderFacts(facts) {
  if (!facts?.length) return '<span class="empty-copy">尚未提取到用户事实。</span>';
  return facts
    .map((fact) => `<span class="fact-chip"><b>${escapeHtml(fact.key)}</b>${escapeHtml(fact.value)}</span>`)
    .join("");
}

function renderEpisodes(episodes) {
  if (!episodes?.length) return '<span class="empty-copy">尚未整理出关键共同经历。</span>';
  return episodes
    .map((episode) => `<span class="fact-chip"><b>${escapeHtml(episode.title)} · ${episode.importance}/5</b>${escapeHtml(episode.content)}</span>`)
    .join("");
}

function renderMemoryMessages(messages, agentName, emptyText) {
  if (!messages?.length) {
    return `<div class="memory-empty">${escapeHtml(emptyText)}</div>`;
  }
  return messages
    .map((message) => {
      const isUser = message.role === "user";
      const speaker = isUser ? "用户" : agentName;
      return `
        <article class="memory-message ${isUser ? "user" : "assistant"}">
          <header>
            <strong>${escapeHtml(speaker)}</strong>
            <time>${escapeHtml(formatTimestamp(message.createdAt))}</time>
          </header>
          <p>${escapeHtml(message.content)}</p>
        </article>`;
    })
    .join("");
}

async function openMemoryEpisodeArchiveDialog(userId, agent) {
  const dialog = $("#episode-archive-dialog");
  clearEpisodeArchivePoll();
  app.episodeArchiveDialogSession += 1;
  app.episodeArchiveKey = `${userId}\0${agent.id}`;
  app.episodeArchive = [];
  app.episodeArchiveMajorEvents = [];
  app.episodeArchiveMeta = {
    userId,
    agentId: agent.id,
    agentName: agent.name,
  };
  $("#episode-archive-title").textContent = `${agent.name}的全部事件记忆`;
  $("#episode-archive-status").textContent = "正在读取事件记忆档案…";
  $("#episode-archive-search").value = "";
  $("#episode-archive-list").innerHTML =
    '<div class="memory-empty">正在加载…</div>';
  $("#episode-archive-notice").hidden = true;
  $("#episode-organization-status").hidden = true;
  $("#episode-rebuild-progress").hidden = true;
  if (!dialog.open) dialog.showModal();
  await loadMemoryEpisodeArchive();
}

async function loadMemoryEpisodeArchive() {
  const dialog = $("#episode-archive-dialog");
  const meta = app.episodeArchiveMeta;
  if (!dialog.open || !meta?.userId || !meta?.agentId) return;
  const requestKey = `${meta.userId}\0${meta.agentId}`;
  const requestSequence = ++app.episodeArchiveRequestSequence;
  const query = new URLSearchParams({
    userId: meta.userId,
    agentId: meta.agentId,
  });
  try {
    const response = await fetch(`/api/agents/memory-episodes?${query}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("无法读取完整事件记忆。");
    const payload = await response.json();
    if (
      requestSequence !== app.episodeArchiveRequestSequence ||
      requestKey !== app.episodeArchiveKey ||
      !dialog.open
    ) {
      return;
    }
    app.episodeArchive = Array.isArray(payload.episodes)
      ? payload.episodes
      : [];
    app.episodeArchiveMajorEvents = Array.isArray(payload.majorEvents)
      ? payload.majorEvents
      : [];
    app.episodeArchiveMeta = {
      ...meta,
      ...payload,
    };
    renderMemoryEpisodeArchive();
    if (
      payload.rebuild?.status === "running" ||
      payload.organization?.status === "running"
    ) {
      clearEpisodeArchivePoll();
      app.episodeArchivePollTimer = window.setTimeout(() => {
        void loadMemoryEpisodeArchive();
      }, 1_500);
    }
  } catch (error) {
    if (
      requestSequence !== app.episodeArchiveRequestSequence ||
      requestKey !== app.episodeArchiveKey ||
      !dialog.open
    ) {
      return;
    }
    $("#episode-archive-status").textContent = "读取失败";
    $("#episode-archive-list").innerHTML =
      `<div class="memory-empty error-copy">${escapeHtml(error.message || "读取失败。")}</div>`;
  }
}

function renderMemoryEpisodeArchive() {
  const meta = app.episodeArchiveMeta || {};
  const rebuild = meta.rebuild || { status: "idle" };
  const organization = meta.organization || { status: "idle" };
  const query = $("#episode-archive-search").value
    .trim()
    .toLocaleLowerCase();
  const assignedDetailKeys = new Set();
  const matchedMajorEvents = app.episodeArchiveMajorEvents
    .map((majorEvent) => {
      const details = Array.isArray(majorEvent?.details)
        ? majorEvent.details
        : [];
      for (const detail of details) {
        assignedDetailKeys.add(memoryEpisodeIdentity(detail));
      }
      for (const detailKey of majorEvent?.detailKeys || []) {
        assignedDetailKeys.add(String(detailKey));
      }
      const parentMatches =
        query && memoryEpisodeTextMatches(majorEvent, query, ["title", "summary"]);
      const matchingDetails =
        query && !parentMatches
          ? details.filter((detail) =>
              memoryEpisodeTextMatches(detail, query, ["title", "content"]),
            )
          : details;
      if (query && !parentMatches && matchingDetails.length === 0) return null;
      return { majorEvent, details: matchingDetails, parentMatches };
    })
    .filter(Boolean);
  const ungroupedEpisodes = app.episodeArchive.filter(
    (episode) => !assignedDetailKeys.has(memoryEpisodeIdentity(episode)),
  );
  const matchedUngroupedEpisodes = query
    ? ungroupedEpisodes.filter((episode) =>
        memoryEpisodeTextMatches(episode, query, ["title", "content"]),
      )
    : ungroupedEpisodes;
  const matchedDetailCount =
    matchedMajorEvents.reduce(
      (count, entry) => count + entry.details.length,
      0,
    ) + matchedUngroupedEpisodes.length;
  const missing = Number(meta.missingLegacyCompressionCount) || 0;
  const rebuiltCount = Number(meta.sourceMessageCount) || 0;
  const notice = $("#episode-archive-notice");
  if (rebuiltCount > 0) {
    notice.hidden = false;
    notice.innerHTML = `已从 <b>${rebuiltCount}</b> 条完整聊天重建旧事件。重建内容来自原始聊天，但不等同于过去模型曾输出的原文。`;
  } else if (missing > 0) {
    notice.hidden = false;
    notice.innerHTML = `旧版本曾覆盖 <b>${missing}</b> 次压缩产生的事件列表，原来的精确措辞已经无法还原；完整聊天仍在，可点击“从完整聊天重建”。`;
  } else {
    notice.hidden = true;
    notice.textContent = "";
  }

  if (rebuild.status === "running") {
    $("#episode-archive-status").textContent =
      `正在重建：已处理 ${Number(rebuild.processedMessages) || 0} / ${Number(rebuild.totalMessages) || 0} 条聊天`;
  } else if (organization.status === "running") {
    $("#episode-archive-status").textContent =
      `正在把 ${Number(organization.sourceEpisodes) || app.episodeArchive.length} 条事件细节整理为大事件`;
  } else if (rebuild.status === "error") {
    $("#episode-archive-status").textContent =
      `上次重建失败：${rebuild.error || "请稍后重试"}`;
  } else {
    $("#episode-archive-status").textContent = query
      ? `共保存 ${app.episodeArchiveMajorEvents.length} 个大事件、${app.episodeArchive.length} 条细节；找到 ${matchedMajorEvents.length} 个大事件、${matchedDetailCount} 条细节`
      : `共 ${app.episodeArchiveMajorEvents.length} 个大事件 · ${app.episodeArchive.length} 条事件细节`;
  }

  renderMemoryEpisodeOrganizationStatus(organization);

  const rebuildButton = $("#episode-archive-rebuild");
  rebuildButton.disabled =
    rebuild.status === "running" ||
    organization.status === "running" ||
    meta.rebuildAvailable === false;
  rebuildButton.textContent =
    rebuild.status === "running"
      ? "正在重建…"
      : rebuiltCount > 0
        ? "重新从完整聊天提炼"
        : "从完整聊天重建";

  const organizeButton = $("#episode-archive-organize");
  organizeButton.disabled =
    rebuild.status === "running" ||
    organization.status === "running" ||
    meta.organizeAvailable === false ||
    app.episodeArchive.length === 0;
  organizeButton.textContent =
    organization.status === "running"
      ? "正在整理…"
      : app.episodeArchiveMajorEvents.length
        ? "重新整理大事件"
        : "整理为大事件";

  const progress = $("#episode-rebuild-progress");
  if (rebuild.status === "running") {
    const processed = Number(rebuild.processedMessages) || 0;
    const total = Number(rebuild.totalMessages) || 0;
    progress.hidden = false;
    $("#episode-rebuild-progress-label").textContent =
      `模型正在分批提炼，已找到 ${Number(rebuild.extractedEpisodes) || 0} 条候选事件`;
    $("#episode-rebuild-progress-count").textContent =
      `${processed} / ${total || "…"}`;
    $("#episode-rebuild-progress-bar").max = Math.max(1, total);
    $("#episode-rebuild-progress-bar").value = Math.min(processed, total || 1);
  } else {
    progress.hidden = true;
  }

  const sections = [];
  if (matchedMajorEvents.length) {
    sections.push(`
      <section class="episode-archive-section">
        <header class="episode-archive-section-head">
          <div>
            <strong>大事件</strong>
            <span>展开可查看其中保留的事件细节</span>
          </div>
          <b>${matchedMajorEvents.length}</b>
        </header>
        <div class="episode-major-list">
          ${matchedMajorEvents
            .map((entry) => renderArchivedMajorEvent(entry, Boolean(query)))
            .join("")}
        </div>
      </section>`);
  }
  if (matchedUngroupedEpisodes.length) {
    sections.push(`
      <section class="episode-archive-section episode-ungrouped-section">
        <header class="episode-archive-section-head">
          <div>
            <strong>${app.episodeArchiveMajorEvents.length ? "尚未归入大事件的细节" : "尚未整理的事件细节"}</strong>
            <span>${app.episodeArchiveMajorEvents.length ? "这些原始细节仍然完整保留" : "可点击“整理为大事件”建立层级"}</span>
          </div>
          <b>${matchedUngroupedEpisodes.length}</b>
        </header>
        <div class="episode-detail-list">
          ${matchedUngroupedEpisodes.map(renderArchivedMemoryEpisode).join("")}
        </div>
      </section>`);
  }
  $("#episode-archive-list").innerHTML = sections.length
    ? sections.join("")
    : `<div class="memory-empty">${query ? "没有找到包含该关键词的大事件或事件细节。" : "当前还没有事件记忆。"}</div>`;
}

function renderMemoryEpisodeOrganizationStatus(organization) {
  const status = $("#episode-organization-status");
  status.className = "episode-organization-status";
  if (organization.status === "running") {
    status.hidden = false;
    status.classList.add("running");
    status.textContent =
      "模型正在整理已经保存的事件细节，不会重新读取完整聊天。整理期间原有细节保持不变。";
    return;
  }
  if (organization.status === "error") {
    status.hidden = false;
    status.classList.add("error");
    status.innerHTML = `<b>大事件整理失败：</b>${escapeHtml(organization.error || "请稍后重试。")} 原有事件细节没有丢失。`;
    return;
  }
  if (organization.status === "complete") {
    status.hidden = false;
    status.classList.add("complete");
    status.textContent =
      `已把现有事件细节整理为 ${Number(organization.majorEvents) || app.episodeArchiveMajorEvents.length} 个大事件；原有细节仍完整保留。`;
    return;
  }
  status.hidden = true;
  status.textContent = "";
}

function renderArchivedMajorEvent(entry, openForSearch) {
  const majorEvent = entry.majorEvent || {};
  const details = entry.details || [];
  const majorEventTimeRange = renderMajorEventTimeRange(majorEvent);
  const statusLabel =
    {
      ongoing: "仍在发展",
      resolved: "已经告一段落",
      uncertain: "状态未定",
    }[majorEvent.status] || "状态未定";
  const groupBadges = [
    majorEvent.currentlyActive ? "当前相关" : "",
    statusLabel,
  ].filter(Boolean);
  return `
    <details class="episode-major-card"${openForSearch ? " open" : ""}>
      <summary>
        <div class="episode-major-heading">
          <span class="episode-major-kicker">大事件 · 重要度 ${Number(majorEvent.importance) || 1}/5</span>
          <strong>${escapeHtml(majorEvent.title || "未命名大事件")}</strong>
          <p>${escapeHtml(majorEvent.summary || "尚未生成大事件摘要。")}</p>
        </div>
        <div class="episode-major-summary-meta">
          <span>${details.length} 条细节</span>
          <span class="episode-major-chevron" aria-hidden="true">⌄</span>
        </div>
      </summary>
      <div class="episode-major-body">
        <div class="episode-major-meta">
          <div class="episode-badges">
            ${groupBadges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("")}
          </div>
          ${majorEventTimeRange}
        </div>
        <div class="episode-detail-list">
          ${details.map(renderArchivedMemoryEpisode).join("")}
        </div>
      </div>
    </details>`;
}

function renderArchivedMemoryEpisode(episode) {
  const badges = [];
  if (episode.currentlyActive) badges.push("当前生效");
  if (episode.reconstructed) badges.push("来源：聊天重建");
  if (episode.migratedBaseline) badges.push("来源：旧版迁移");
  if (!episode.reconstructed && !episode.migratedBaseline) {
    badges.push("来源：日常记忆整理");
  }
  const seenCount = Number(episode.seenCount) || 1;
  const hasOccurredAt = hasMemoryTimestamp(episode.occurredAt);
  return `
    <article class="episode-archive-card episode-detail-card">
      <header>
        <div>
          <strong>${escapeHtml(episode.title || "未命名事件")}</strong>
          <span>重要度 ${Number(episode.importance) || 1}/5</span>
        </div>
        <div class="episode-badges">
          ${badges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("")}
        </div>
      </header>
      <p>${escapeHtml(episode.content || "")}</p>
      ${
        hasOccurredAt
          ? `<div class="episode-occurrence-time">
              <span>发生于</span>
              <time datetime="${escapeAttr(String(episode.occurredAt))}">${escapeHtml(formatTimestamp(episode.occurredAt))}</time>
            </div>`
          : ""
      }
      <footer>
        <span>首次记录 ${escapeHtml(formatTimestamp(episode.firstSeenAt))}</span>
        <span>${seenCount > 1 ? `在 ${seenCount} 次整理中出现` : "记录 1 次"}</span>
      </footer>
    </article>`;
}

function renderMajorEventTimeRange(majorEvent) {
  const firstOccurredAt = hasMemoryTimestamp(majorEvent?.firstOccurredAt)
    ? majorEvent.firstOccurredAt
    : null;
  const lastOccurredAt = hasMemoryTimestamp(majorEvent?.lastOccurredAt)
    ? majorEvent.lastOccurredAt
    : null;
  const firstSeenAt = hasMemoryTimestamp(majorEvent?.firstSeenAt)
    ? majorEvent.firstSeenAt
    : null;
  const lastSeenAt = hasMemoryTimestamp(majorEvent?.lastSeenAt)
    ? majorEvent.lastSeenAt
    : null;
  const start = firstOccurredAt || firstSeenAt;
  const end = lastOccurredAt || lastSeenAt;
  if (!start && !end) {
    return '<span class="episode-major-time-range">时间范围未知</span>';
  }
  const parts = [];
  if (start) {
    parts.push(
      `${firstOccurredAt ? "开始发生" : "首次记录"} ${formatTimestamp(start)}`,
    );
  }
  if (end && String(end) !== String(start)) {
    parts.push(
      `${lastOccurredAt ? "最近发生" : "最后记录"} ${formatTimestamp(end)}`,
    );
  }
  return `<span class="episode-major-time-range">${escapeHtml(parts.join(" — "))}</span>`;
}

function hasMemoryTimestamp(value) {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" || value.trim() !== "")
  );
}

function memoryEpisodeIdentity(episode) {
  return String(episode?.sourceKey || episode?.id || "");
}

function memoryEpisodeTextMatches(value, query, fields) {
  return fields
    .map((field) => value?.[field])
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase()
    .includes(query);
}

async function startMemoryEpisodeOrganization() {
  const meta = app.episodeArchiveMeta;
  if (!meta?.userId || !meta?.agentId) return;
  const dialog = $("#episode-archive-dialog");
  const requestKey = `${meta.userId}\0${meta.agentId}`;
  const dialogSession = app.episodeArchiveDialogSession;
  const isCurrentDialog = () =>
    dialog.open &&
    dialogSession === app.episodeArchiveDialogSession &&
    requestKey === app.episodeArchiveKey;
  const confirmed = window.confirm(
    "这只会把已经保存的事件细节交给当前模型，整理成“大事件 → 事件细节”的层级；不会重新读取完整聊天，也不会删除或改写原有细节。是否继续？",
  );
  if (!confirmed || !isCurrentDialog()) return;
  const button = $("#episode-archive-organize");
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    const response = await fetch("/api/agents/memory-episodes/organize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WeBot-Request": "admin",
      },
      body: JSON.stringify({
        userId: meta.userId,
        agentId: meta.agentId,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "无法启动大事件整理。");
    }
    if (!isCurrentDialog()) return;
    toast("大事件整理已开始，原有事件细节会全部保留。");
    await loadMemoryEpisodeArchive();
  } catch (error) {
    if (!isCurrentDialog()) return;
    renderMemoryEpisodeArchive();
    toast(error.message || "无法启动大事件整理。", true);
  }
}

async function startMemoryEpisodeRebuild() {
  const meta = app.episodeArchiveMeta;
  if (!meta?.userId || !meta?.agentId) return;
  const dialog = $("#episode-archive-dialog");
  const requestKey = `${meta.userId}\0${meta.agentId}`;
  const dialogSession = app.episodeArchiveDialogSession;
  const isCurrentDialog = () =>
    dialog.open &&
    dialogSession === app.episodeArchiveDialogSession &&
    requestKey === app.episodeArchiveKey;
  const confirmed = window.confirm(
    "这会把该 Agent 的完整聊天分批交给当前模型，重新提炼历史事件记忆。原始聊天不会被修改，但会产生少量模型调用费用。是否继续？",
  );
  if (!confirmed || !isCurrentDialog()) return;
  const button = $("#episode-archive-rebuild");
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    const response = await fetch("/api/agents/memory-episodes/rebuild", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WeBot-Request": "admin",
      },
      body: JSON.stringify({
        userId: meta.userId,
        agentId: meta.agentId,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "无法启动事件记忆重建。");
    }
    if (!isCurrentDialog()) return;
    toast("事件记忆重建已开始，可在这里查看进度。");
    await loadMemoryEpisodeArchive();
  } catch (error) {
    if (!isCurrentDialog()) return;
    button.disabled = false;
    button.textContent = "从完整聊天重建";
    toast(error.message || "无法启动事件记忆重建。", true);
  }
}

function clearEpisodeArchivePoll() {
  if (!app.episodeArchivePollTimer) return;
  window.clearTimeout(app.episodeArchivePollTimer);
  app.episodeArchivePollTimer = 0;
}

async function openMemorySummaryHistoryDialog(userId, agent) {
  const dialog = $("#summary-history-dialog");
  const query = new URLSearchParams({ userId, agentId: agent.id });
  const requestKey = `${userId}\0${agent.id}`;
  const requestSequence = ++app.summaryHistoryRequestSequence;
  app.summaryHistoryKey = requestKey;
  app.summarySnapshots = [];
  app.summaryHistoryCompressionCount = agent.memoryCompressionCount || 0;
  $("#summary-history-title").textContent = `${agent.name}的总结记忆历史`;
  $("#summary-history-status").textContent = "正在读取全部摘要版本…";
  $("#summary-history-search").value = "";
  $("#summary-history-list").innerHTML =
    '<div class="memory-empty">正在加载…</div>';
  if (!dialog.open) dialog.showModal();

  try {
    const response = await fetch(`/api/agents/memory-summaries?${query}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("无法读取总结记忆历史。");
    const payload = await response.json();
    if (
      requestSequence !== app.summaryHistoryRequestSequence ||
      requestKey !== app.summaryHistoryKey ||
      !dialog.open
    ) {
      return;
    }
    app.summarySnapshots = Array.isArray(payload.snapshots)
      ? payload.snapshots
      : [];
    app.summaryHistoryCompressionCount =
      Number(payload.compressionCount) || app.summarySnapshots.length;
    renderMemorySummaryHistory();
  } catch (error) {
    if (
      requestSequence !== app.summaryHistoryRequestSequence ||
      requestKey !== app.summaryHistoryKey ||
      !dialog.open
    ) {
      return;
    }
    $("#summary-history-status").textContent = "读取失败";
    $("#summary-history-list").innerHTML =
      `<div class="memory-empty error-copy">${escapeHtml(error.message || "读取失败。")}</div>`;
  }
}

function renderMemorySummaryHistory() {
  const query = $("#summary-history-search").value
    .trim()
    .toLocaleLowerCase();
  const matched = query
    ? app.summarySnapshots.filter((snapshot) =>
        memorySummarySearchText(snapshot).includes(query),
      )
    : app.summarySnapshots;
  const missingLegacy = Math.max(
    0,
    app.summaryHistoryCompressionCount - app.summarySnapshots.length,
  );
  const legacyNote = missingLegacy
    ? `；升级前另有 ${missingLegacy} 次压缩只保留了当时最后一版，无法精确还原旧版本`
    : "";
  $("#summary-history-status").textContent = query
    ? `共保存 ${app.summarySnapshots.length} 个版本，找到 ${matched.length} 个匹配结果${legacyNote}`
    : `已显示 ${app.summarySnapshots.length} 个摘要版本（累计 ${app.summaryHistoryCompressionCount} 次压缩）${legacyNote}`;
  $("#summary-history-list").innerHTML = matched.length
    ? matched.map(renderMemorySummarySnapshot).join("")
    : `<div class="memory-empty">${query ? "没有找到包含该关键词的总结记忆。" : "当前还没有总结记忆历史。"}</div>`;
}

function memorySummarySearchText(snapshot) {
  return [
    snapshot?.summary,
    ...(snapshot?.facts || []).flatMap((fact) => [fact?.key, fact?.value]),
    ...(snapshot?.episodes || []).flatMap((episode) => [
      episode?.title,
      episode?.content,
    ]),
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
}

function renderMemorySummarySnapshot(snapshot) {
  const sequence = Number(snapshot?.sequence) || 0;
  const facts = Array.isArray(snapshot?.facts) ? snapshot.facts : [];
  const episodes = Array.isArray(snapshot?.episodes) ? snapshot.episodes : [];
  const migrated = Boolean(snapshot?.migratedBaseline);
  return `
    <article class="summary-snapshot">
      <header>
        <div>
          <span class="summary-sequence">第 ${sequence} 次整理${migrated ? " · 旧版迁移基线" : ""}</span>
          <strong>${escapeHtml(formatTimestamp(snapshot?.createdAt))}</strong>
        </div>
        <span>${migrated ? "升级前仅存版本" : `本次压缩 ${Number(snapshot?.compressedMessageCount) || 0} 条`}</span>
      </header>
      ${
        migrated
          ? '<p class="summary-migration-note">这是升级时仍能恢复的当前摘要。更早各次整理的原始版本过去没有落盘，不能精确伪造；完整聊天仍然保留。</p>'
          : ""
      }
      <div class="summary-snapshot-copy">${escapeHtml(snapshot?.summary || "这次整理没有生成摘要正文。")}</div>
      <details class="summary-derived">
        <summary>查看当时的事实与关键经历（${facts.length} / ${episodes.length}）</summary>
        <div>
          <span class="mini-label">DURABLE FACTS</span>
          <div class="fact-list">${renderFacts(facts)}</div>
        </div>
        <div>
          <span class="mini-label">KEY EPISODES</span>
          <div class="fact-list">${renderEpisodes(episodes)}</div>
        </div>
      </details>
    </article>`;
}

async function openHistoryDialog(userId, agent) {
  const dialog = $("#history-dialog");
  const query = new URLSearchParams({ userId, agentId: agent.id });
  app.historyMessages = [];
  app.historyAgentName = agent.name;
  app.historyDownloadUrl = `/api/agents/history?${query}`;
  $("#history-title").textContent = `${agent.name}的完整聊天记忆`;
  $("#history-status").textContent = "正在读取全部聊天记录…";
  $("#history-search").value = "";
  $("#history-list").innerHTML = '<div class="memory-empty">正在加载…</div>';
  if (!dialog.open) dialog.showModal();

  try {
    const response = await fetch(app.historyDownloadUrl, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("无法读取完整聊天记录。");
    const payload = await response.json();
    app.historyMessages = Array.isArray(payload.messages) ? payload.messages : [];
    renderHistoryMessages();
  } catch (error) {
    $("#history-status").textContent = "读取失败";
    $("#history-list").innerHTML = `<div class="memory-empty error-copy">${escapeHtml(error.message || "读取失败。")}</div>`;
  }
}

function renderHistoryMessages() {
  const query = $("#history-search").value.trim().toLocaleLowerCase();
  const matched = query
    ? app.historyMessages.filter((message) =>
        String(message.content || "").toLocaleLowerCase().includes(query),
      )
    : app.historyMessages;
  $("#history-status").textContent = query
    ? `完整归档共 ${app.historyMessages.length} 条，找到 ${matched.length} 条匹配结果`
    : `已显示完整归档，共 ${app.historyMessages.length} 条`;
  const list = $("#history-list");
  list.innerHTML = renderMemoryMessages(
    matched,
    app.historyAgentName,
    query ? "没有找到包含该关键词的聊天。" : "当前没有聊天记录。",
  );
  if (!query) list.scrollTop = list.scrollHeight;
}

async function openPromptTraceDialog(userId, agent) {
  const dialog = $("#trace-dialog");
  app.promptTraces = [];
  app.selectedTraceId = "";
  app.traceUserId = userId;
  app.traceAgentId = agent.id;
  $("#trace-title").textContent = `${agent.name}的 Prompt Trace`;
  $("#trace-status").textContent = "正在读取最近模型调用…";
  $("#trace-list").innerHTML = '<div class="memory-empty">正在加载…</div>';
  $("#trace-detail").innerHTML = '<div class="memory-empty">正在加载…</div>';
  if (!dialog.open) dialog.showModal();

  try {
    const query = new URLSearchParams({ userId, agentId: agent.id, limit: "20" });
    const response = await fetch(`/api/agents/prompt-traces?${query}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("无法读取 Prompt Trace。");
    const payload = await response.json();
    app.promptTraces = Array.isArray(payload.traces) ? payload.traces : [];
    app.selectedTraceId = app.promptTraces[0]?.id || "";
    renderPromptTraceList();
    if (app.selectedTraceId) {
      await loadPromptTraceDetail(app.selectedTraceId);
    } else {
      $("#trace-status").textContent = "还没有模型调用记录";
      $("#trace-detail").innerHTML = [
        '<div class="memory-empty">',
        "在微信里和这个 Agent 对话一次后，这里会显示模型实际看到的人设、记忆、世界书和最近聊天。",
        "</div>",
      ].join("");
    }
  } catch (error) {
    $("#trace-status").textContent = "读取失败";
    $("#trace-list").innerHTML = "";
    $("#trace-detail").innerHTML = `<div class="memory-empty error-copy">${escapeHtml(error.message || "读取失败。")}</div>`;
  }
}

function renderPromptTraceList() {
  const traces = app.promptTraces;
  $("#trace-status").textContent = `保留最近 ${traces.length} 次模型调用`;
  $("#trace-list").innerHTML = traces
    .map((trace) => {
      const selected = trace.id === app.selectedTraceId;
      const status = trace.status === "success" ? "成功" : "失败";
      const model = trace.model || trace.providerId;
      return `
        <button class="trace-item${selected ? " selected" : ""}" type="button" data-trace-id="${escapeAttr(trace.id)}">
          <span class="trace-item-head">
            <strong>${escapeHtml(model)}</strong>
            <i class="trace-state ${escapeAttr(trace.status)}">${status}</i>
          </span>
          <small>${escapeHtml(formatTimestamp(trace.createdAt))} · ${Math.round(trace.durationMs || 0)} ms</small>
          <small>${trace.estimatedInputTokens || 0} / ${trace.budgetTokens || 0} 估算 tokens</small>
          <span class="trace-counts">采用 ${trace.includedBlocks || 0} · 裁剪 ${trace.truncatedBlocks || 0} · 省略 ${trace.omittedBlocks || 0}</span>
        </button>`;
    })
    .join("");
  $$(".trace-item").forEach((button) => {
    button.addEventListener("click", () => {
      app.selectedTraceId = button.dataset.traceId;
      renderPromptTraceList();
      void loadPromptTraceDetail(app.selectedTraceId);
    });
  });
}

async function loadPromptTraceDetail(traceId) {
  $("#trace-detail").innerHTML = '<div class="memory-empty">正在读取详细 Prompt…</div>';
  try {
    const query = new URLSearchParams({
      userId: app.traceUserId,
      agentId: app.traceAgentId,
      traceId,
    });
    const response = await fetch(`/api/agents/prompt-trace?${query}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("无法读取这条 Prompt Trace。");
    const payload = await response.json();
    if (app.selectedTraceId !== traceId) return;
    renderPromptTraceDetail(payload.trace);
  } catch (error) {
    $("#trace-detail").innerHTML = `<div class="memory-empty error-copy">${escapeHtml(error.message || "读取失败。")}</div>`;
  }
}

function renderPromptTraceDetail(trace) {
  if (!trace?.plan) {
    $("#trace-detail").innerHTML = '<div class="memory-empty">这条记录没有 Prompt 详情。</div>';
    return;
  }
  const plan = trace.plan;
  const usage = trace.usage || {};
  const usageLabel = usage.source === "provider" ? "模型返回" : "本地估算";
  const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
  const messages = Array.isArray(plan.input) ? plan.input : [];
  $("#trace-detail").innerHTML = `
    <div class="trace-overview">
      <div><span>Provider</span><strong>${escapeHtml(trace.providerLabel || trace.providerId)}</strong></div>
      <div><span>模式</span><strong>${plan.mode === "wechat" ? "微信聊天" : "沉浸扮演"}</strong></div>
      <div><span>输入预算</span><strong>${plan.estimatedInputTokens || 0} / ${plan.budgetTokens || 0}</strong></div>
      <div><span>实际用量</span><strong>${escapeHtml(formatUsage(usage))}</strong><small>${usageLabel}</small></div>
    </div>
    ${trace.storageTruncated ? '<div class="trace-warning">这条记录过大，私密存储中的正文已明确裁剪；统计信息仍保留。</div>' : ""}
    ${trace.error ? `<div class="trace-warning error-copy">${escapeHtml(trace.error.message || "模型调用失败。")}</div>` : ""}
    <section class="trace-section">
      <div class="trace-section-head">
        <div><span class="mini-label">PROMPT PLAN</span><strong>内容来源与裁剪结果</strong></div>
        <span>${blocks.length} 个区块</span>
      </div>
      <div class="trace-blocks">
        ${blocks.map(renderPromptBlock).join("")}
      </div>
    </section>
    <section class="trace-section">
      <div class="trace-section-head">
        <div><span class="mini-label">FINAL REQUEST</span><strong>最终发送给模型的内容</strong></div>
        <span>${messages.length + 1} 段</span>
      </div>
      <article class="trace-payload">
        <header><strong>SYSTEM / INSTRUCTIONS</strong></header>
        <pre>${escapeHtml(plan.instructions || "（空）")}</pre>
      </article>
      ${messages.map((message, index) => `
        <article class="trace-payload">
          <header><strong>${escapeHtml(String(message.role || "message").toUpperCase())} / ${index + 1}</strong></header>
          <pre>${escapeHtml(message.content || "（空）")}</pre>
        </article>`).join("")}
    </section>`;
}

function renderPromptBlock(block) {
  const statusLabels = {
    included: "已采用",
    truncated: "已裁剪",
    omitted: "已省略",
  };
  const reasonLabels = {
    section_limit: "超过单区块上限",
    input_budget: "超过总输入预算",
  };
  const status = block.status || "omitted";
  const detail = status === "omitted"
    ? reasonLabels[block.omissionReason] || "未加入最终 Prompt"
    : block.content || "（空）";
  return `
    <article class="trace-block ${escapeAttr(status)}">
      <header>
        <div><strong>${escapeHtml(block.label || block.id)}</strong><small>${escapeHtml(block.source || "unknown")} · ${escapeHtml(block.trust || "unknown")}</small></div>
        <span>${statusLabels[status] || status}</span>
      </header>
      <div class="trace-block-meta">优先级 ${block.priority || 0} · ${block.estimatedTokens || 0} / ${block.originalEstimatedTokens || 0} 估算 tokens${block.required ? " · 必需" : ""}</div>
      <pre>${escapeHtml(detail)}</pre>
    </article>`;
}

function formatUsage(usage) {
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : "?";
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : "?";
  return `${input} in / ${output} out`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function populateProviderSelect(select, selected) {
  const providers = app.state?.providers ?? [];
  select.innerHTML = [
    `<option value=""${selected ? "" : " selected"}>跟随全局默认（${escapeHtml(app.state?.defaultProviderId ?? "echo")}）</option>`,
    ...providers.map(
      (provider) =>
        `<option value="${escapeAttr(provider.id)}"${provider.id === selected ? " selected" : ""}>${escapeHtml(provider.label)}${provider.configured ? "" : " · 未配置"}</option>`,
    ),
  ].join("");
}

function renderProviders() {
  const container = $("#provider-grid");
  container.innerHTML = (app.state?.providers ?? [])
    .map((provider) => {
      const canManage = Boolean(provider.apiKeyEnv);
      const sourceText =
        provider.keySource === "environment"
          ? "环境变量"
          : provider.keySource === "stored"
            ? "私密存储"
            : "未配置";
      const mediaCapabilities = [
        provider.visionModel
          ? `图片理解 · ${provider.visionModel}`
          : "",
        provider.imageGenerationModel
          ? `图片生成 · ${provider.imageGenerationModel}`
          : "",
      ].filter(Boolean);
      const isLoopback = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/iu.test(
        provider.baseUrl || "",
      );
      return `
        <article class="provider-card${provider.configured ? " configured" : ""}">
          <div class="provider-head">
            <div>
              <span class="provider-id">${escapeHtml(provider.id.toUpperCase())}</span>
              <h3>${escapeHtml(provider.label)}</h3>
            </div>
            <span class="key-status${provider.configured ? " ok" : ""}">${escapeHtml(sourceText)}</span>
          </div>
          <div class="provider-meta">
            <div>${escapeHtml(provider.api)}</div>
            <div>${escapeHtml(provider.model || "无远程模型")}</div>
            <div>${escapeHtml(provider.baseUrl || "本地执行")}</div>
          </div>
          ${
            mediaCapabilities.length
              ? `<div class="provider-capabilities">${mediaCapabilities
                  .map((value) => `<span>${escapeHtml(value)}</span>`)
                  .join("")}</div>`
              : ""
          }
          ${
            isLoopback
              ? '<p class="provider-note">这里的 127.0.0.1 指运行 WeBot 的那台机器，不是当前浏览器。云端 WeBot 无法直接访问你 Mac 上的本机服务。</p>'
              : ""
          }
          ${
            canManage
              ? `<div class="key-form">
                  <label>
                    ${escapeHtml(provider.apiKeyEnv)}
                    <input type="password" autocomplete="new-password" data-key-input="${escapeAttr(provider.apiKeyEnv)}" placeholder="${provider.configured ? "已配置 · 输入新值可替换" : "粘贴 API Key"}">
                  </label>
                  <div class="key-actions">
                    <button class="button primary save-key" data-env="${escapeAttr(provider.apiKeyEnv)}">保存密钥</button>
                    <button class="button ghost clear-key" data-env="${escapeAttr(provider.apiKeyEnv)}"${provider.keySource !== "stored" ? " disabled" : ""}>清除本地值</button>
                  </div>
                </div>`
              : '<div class="key-form"><span class="key-status ok">无需 API Key</span></div>'
          }
        </article>`;
    })
    .join("");

  $$(".save-key").forEach((button) => {
    button.addEventListener("click", async () => {
      const env = button.dataset.env;
      const input = document.querySelector(`[data-key-input="${cssEscape(env)}"]`);
      if (!input.value.trim()) {
        toast("请先输入 API Key。", true);
        input.focus();
        return;
      }
      await mutate("/api/keys", "POST", {
        environmentName: env,
        value: input.value,
      });
      input.value = "";
      toast(`${env} 已安全保存并立即生效。`);
      await refreshState();
    });
  });

  $$(".clear-key").forEach((button) => {
    button.addEventListener("click", async () => {
      const env = button.dataset.env;
      if (!confirm(`确定清除本地保存的 ${env} 吗？`)) return;
      await mutate("/api/keys", "DELETE", { environmentName: env });
      toast(`${env} 的本地值已清除。`);
      await refreshState();
    });
  });
}

function mergeUpdatedAgent(userId, updatedAgent) {
  const user = app.state?.users.find((item) => item.userId === userId);
  const agent = user?.agents.find((item) => item.id === updatedAgent?.id);
  if (!agent || !updatedAgent) return;
  for (const key of [
    "providerId",
    "model",
    "roleplay",
    "conversationMode",
    "imageBehavior",
  ]) {
    if (!(key in updatedAgent)) delete agent[key];
  }
  Object.assign(agent, updatedAgent);
}

async function mutate(
  url,
  method,
  body,
  { suppressErrorToast = false } = {},
) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-WeBot-Request": "admin",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "操作失败。");
    if (!suppressErrorToast) toast(error.message, true);
    throw error;
  }
  return result;
}

function currentUser() {
  return app.state?.users.find((user) => user.userId === app.selectedUserId);
}

function currentAgent() {
  return currentUser()?.agents.find((agent) => agent.id === app.selectedAgentId);
}

function emptyEditor(title, body) {
  return `<div class="empty-state"><span class="empty-glyph">A</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div>`;
}

let toastTimer;
function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.setAttribute("role", isError ? "alert" : "status");
  element.classList.toggle("error", isError);
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function cssEscape(value) {
  return CSS.escape(String(value));
}
