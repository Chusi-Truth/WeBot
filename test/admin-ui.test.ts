import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const publicFile = (name: string) =>
  readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = css.matchAll(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"),
  );
  for (const match of matches) {
    const prefix = css.slice(0, match.index).trimEnd();
    if (!prefix.endsWith(",")) return match[1]!;
  }
  throw new Error(`Missing CSS rule: ${selector}`);
}

describe("admin character studio", () => {
  it("shows media capabilities and explains loopback provider addresses", async () => {
    const [script, css] = await Promise.all([
      publicFile("admin.js"),
      publicFile("admin.css"),
    ]);

    expect(script).toContain("provider.visionModel");
    expect(script).toContain("provider.imageGenerationModel");
    expect(script).toContain("图片理解 ·");
    expect(script).toContain("图片生成 ·");
    expect(script).toContain("127.0.0.1 指运行 WeBot 的那台机器");
    expect(cssRule(css, ".provider-capabilities")).toMatch(
      /display:\s*flex;/,
    );
    expect(cssRule(css, ".provider-note")).toMatch(/line-height:\s*1\.55;/);
  });

  it("lets users dismiss the create-agent dialog without validating the form", async () => {
    const [html, script] = await Promise.all([
      publicFile("admin.html"),
      publicFile("admin.js"),
    ]);
    const agentDialog =
      html.match(
        /<dialog\b[^>]*\bid="agent-dialog"[^>]*>[\s\S]*?<\/dialog>/,
      )?.[0] ?? "";

    expect(agentDialog).toContain('aria-labelledby="agent-dialog-title"');
    expect(agentDialog).toContain('id="agent-dialog-title"');
    expect(agentDialog).toMatch(
      /id="agent-dialog-close"[\s\S]*?type="button"/,
    );
    expect(agentDialog).toMatch(
      /id="agent-dialog-cancel"[\s\S]*?type="button"/,
    );
    expect(agentDialog).toMatch(
      /id="create-agent-submit"[\s\S]*?type="submit"/,
    );
    expect(script).toContain(
      '$("#agent-dialog-close").addEventListener("click", closeAgentDialog)',
    );
    expect(script).toContain(
      '$("#agent-dialog-cancel").addEventListener("click", closeAgentDialog)',
    );
    expect(script).toContain("event.target === agentDialog");
    expect(script).toContain('event.key !== "Escape"');
    expect(script).toContain('$("#new-agent")?.focus()');
  });

  it("lets the page grow and scroll while keeping dialogs independently scrollable", async () => {
    const css = await publicFile("admin.css");

    expect(cssRule(css, "body")).toMatch(/overflow-y:\s*auto;/);
    expect(cssRule(css, "body")).not.toMatch(/overflow:\s*hidden;/);
    expect(cssRule(css, ".shell")).toMatch(/min-height:\s*100dvh;/);
    expect(cssRule(css, ".shell")).toMatch(/height:\s*auto;/);
    expect(cssRule(css, ".shell")).toMatch(/overflow:\s*visible;/);
    expect(cssRule(css, ".shell")).toMatch(
      /grid-template-rows:\s*auto 1fr 20px;/,
    );
    expect(cssRule(css, ".page-header")).toMatch(
      /position:\s*sticky;/,
    );
    expect(cssRule(css, ".page-header")).toMatch(/top:\s*0;/);
    expect(cssRule(css, ".page-header")).toMatch(/align-self:\s*start;/);
    expect(cssRule(css, ".page-header")).toMatch(
      /grid-template-rows:\s*52px auto 40px;/,
    );
    expect(cssRule(css, "main")).toMatch(/overflow:\s*visible;/);
    expect(cssRule(css, ".panel")).toMatch(/height:\s*auto;/);
    expect(cssRule(css, ".panel")).toMatch(/overflow:\s*visible;/);
    expect(cssRule(css, "#panel-agents.active")).toMatch(
      /grid-template-rows:\s*auto auto auto;/,
    );
    expect(cssRule(css, ".workspace")).toMatch(
      /grid-template-columns:\s*240px minmax\(480px,\s*1fr\);/,
    );
    expect(cssRule(css, ".workspace")).toMatch(/height:\s*auto;/);
    expect(cssRule(css, ".agent-list")).toMatch(/min-width:\s*0;/);
    expect(cssRule(css, ".agent-item")).toMatch(
      /grid-template-columns:\s*38px minmax\(0,\s*1fr\) auto;/,
    );
    expect(cssRule(css, ".agent-item > span:nth-child(2)")).toMatch(
      /min-width:\s*0;/,
    );
    expect(cssRule(css, ".editor-card")).toMatch(/overflow:\s*visible;/);
    expect(cssRule(css, ".autonomy-event-list")).toMatch(
      /max-height:\s*none;/,
    );
    expect(cssRule(css, ".autonomy-event-list")).toMatch(
      /overflow:\s*visible;/,
    );
    expect(cssRule(css, ".memory-message-list")).toMatch(
      /max-height:\s*none;/,
    );
    expect(cssRule(css, ".memory-message-list")).toMatch(
      /overflow:\s*visible;/,
    );
    expect(cssRule(css, ".assistant-scroll")).toMatch(
      /overflow-y:\s*auto;/,
    );
    expect(cssRule(css, ".persona-dialog-shell")).toMatch(
      /grid-template-rows:\s*auto minmax\(0,\s*1fr\);/,
    );
    expect(cssRule(css, ".persona-dialog-shell")).toMatch(
      /overflow:\s*hidden;/,
    );
    expect(cssRule(css, ".persona-dialog")).toMatch(
      /width:\s*min\(1360px,\s*calc\(100% - 16px\)\);/,
    );
    expect(cssRule(css, ".persona-dialog-workspace")).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1\.9fr\) minmax\(360px,\s*0\.8fr\);/,
    );
    expect(cssRule(css, ".persona-detail-pane")).toMatch(
      /overflow-y:\s*auto;/,
    );
    expect(cssRule(css, ".persona-dialog .assistant-diff-block p")).toMatch(
      /max-height:\s*none;[\s\S]*overflow:\s*visible;/,
    );
    expect(css).toMatch(
      /@media \(min-width:\s*821px\)[\s\S]*?#panel-agents > \.section-heading\s*\{[\s\S]*?display:\s*contents;/,
    );
    expect(css).toMatch(
      /#panel-agents > \.user-picker\s*\{[\s\S]*?grid-template-columns:\s*auto minmax\(0,\s*1fr\);/,
    );
    expect(css).toMatch(
      /@media \(max-height:\s*800px\) and \(min-width:\s*681px\)[\s\S]*?\.page-header\s*\{[\s\S]*?grid-template-rows:\s*48px auto 38px;/,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*820px\)[\s\S]*?\.agent-list-wrap\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*680px\)[\s\S]*?\.agent-list-wrap\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/,
    );
    expect(css).toMatch(
      /@media \(max-height:\s*500px\)[\s\S]*?\.page-header\s*\{[\s\S]*?grid-template-rows:\s*48px 38px;[\s\S]*?\.page-header \.hero\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*680px\) and \(max-height:\s*500px\)[\s\S]*?\.page-header\s*\{[\s\S]*?grid-template-rows:\s*50px 40px;[\s\S]*?\.page-header \.hero\s*\{[\s\S]*?display:\s*none;/,
    );
  });

  it("opens the complete persona and AI assistant in an accessible modal", async () => {
    const [html, script] = await Promise.all([
      publicFile("admin.html"),
      publicFile("admin.js"),
    ]);
    const workspace = html.slice(
      html.indexOf('<div class="workspace">'),
      html.indexOf('<section class="panel" id="panel-providers"'),
    );
    const personaDialog = html.match(
      /<dialog\b[^>]*\bid="persona-dialog"[^>]*>[\s\S]*?<\/dialog>/,
    )?.[0] ?? "";
    const personaDialogTag = personaDialog.match(/^<dialog\b[^>]*>/)?.[0] ?? "";
    const pageHeader = html.match(
      /<div class="page-header">[\s\S]*?<\/nav>\s*<\/div>/,
    )?.[0] ?? "";

    expect(pageHeader).toContain('class="topbar"');
    expect(pageHeader).toContain('class="hero"');
    expect(pageHeader).toContain('class="tabs"');
    expect(workspace).not.toContain('id="persona-assistant"');
    expect(html).toContain('id="persona-dialog"');
    expect(html).toContain('aria-labelledby="persona-dialog-title"');
    expect(html).toContain('aria-describedby="persona-dialog-description"');
    expect(personaDialogTag).not.toMatch(/\bopen\b/);
    expect(personaDialog).toContain('id="current-persona-summary"');
    expect(personaDialog).toContain('id="persona-assistant"');
    expect(personaDialog).toContain('id="persona-request"');
    expect(personaDialog).toContain('id="persona-generate"');
    expect(personaDialog).toContain('id="roleplay-style-prompt"');
    expect(personaDialog).toContain('id="roleplay-style-request"');
    expect(personaDialog).toContain('id="roleplay-style-save"');
    expect(personaDialog).toContain('id="roleplay-style-generate"');
    expect(personaDialog).toContain('id="persona-close"');
    expect(personaDialog).toContain('href="#persona-assistant"');
    for (const id of [
      "persona-assistant",
      "persona-request",
      "persona-generate",
      "roleplay-style-prompt",
      "roleplay-style-request",
      "roleplay-style-save",
      "roleplay-style-generate",
      "current-persona-summary",
    ]) {
      expect(html.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
    expect(script).toContain('id="open-persona-dialog"');
    expect(script).toContain('aria-haspopup="dialog"');
    expect(script).toContain('aria-controls="persona-dialog"');
    expect(script).toContain("dialog.showModal()");
    expect(script).toContain('personaDialog.addEventListener("close"');
    expect(script).toContain('$("#open-persona-dialog")?.focus()');
  });

  it("shows exact persona changes and supports one-click saving inside the modal", async () => {
    const [html, script] = await Promise.all([
      publicFile("admin.html"),
      publicFile("admin.js"),
    ]);
    const renderEditorSource = script.slice(
      script.indexOf("function renderEditor"),
      script.indexOf("function autonomySelectionKey"),
    );

    expect(html).toContain('id="persona-assistant"');
    expect(html).toContain('id="persona-request"');
    expect(html).toContain('id="persona-generate"');
    expect(html).toContain('id="current-persona-summary"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(script).toContain('mutate("/api/agents/persona-draft"');
    expect(script).toContain('generatePersonaDraft("roleplayStyle")');
    expect(script).toContain('target === "roleplayStyle"');
    expect(script).toContain("roleplay.stylePrompt");
    expect(script).toContain("currentDraft.roleplay.stylePrompt");
    expect(script).toContain(
      'agent.conversationMode || (agent.roleplay ? "roleplay" : "wechat")',
    );
    expect(script).toContain("field.disabled = true");
    expect(script).toContain(
      "agentSelectionMatches(requestedUserId, requestedAgentId)",
    );
    expect(script).toContain('$("#persona-discard")');
    expect(script).toContain("personaWorkingSnapshot");
    expect(script).toContain("人物输入在草稿生成后发生了变化");
    expect(script).toContain(
      'styleField?.dataset.agentId === agent.id',
    );
    expect(script).toContain(
      'styleField.dataset.sourceUpdatedAt === agent.updatedAt',
    );
    expect(script).toContain("情景模式文风 Prompt");
    expect(script).toContain("AI 生成详细规则");
    expect(html).toContain("保存当前 Prompt");
    expect(html).toContain("不会影响微信聊天模式");
    expect(script).toContain("CURRENT / SAVED");
    expect(script).toContain("当前已保存的具体设定");
    expect(script).toContain("世界书设定");
    expect(script).toContain("应用并保存");
    expect(script).not.toContain("只填入编辑器");
    expect(script).toContain("修改前");
    expect(script).toContain("修改后");
    expect(script).not.toContain("form.requestSubmit()");
    expect(script).toContain("修改结果");
    expect(script).not.toContain("<h4>修改建议</h4>");
    expect(script).not.toContain("保存人物");
    expect(script).toContain("personaProfileFromAgent(agent)");
    expect(script).toContain('"/api/agents/update"');
    expect(script).toContain("agent.roleplay?.lorebook");
    expect(script).toContain("agent.roleplay?.characterCardExtensions");
    expect(script).toContain("agent.providerId");
    expect(script).toContain("agent.model");
    expect(script).toContain('$("#persona-dialog").close()');
    expect(script).toContain("personaSaveContextMatches(");
    expect(script).toContain("suppressErrorToast: true");
    expect(script).toContain("shouldRestoreDialogFocus");
    expect(renderEditorSource).toContain('class="persona-launch-card"');
    expect(renderEditorSource).toContain('class="agent-dashboard"');
    expect(renderEditorSource).toContain('id="autonomy-panel"');
    expect(renderEditorSource).toContain('class="memory-tools"');
    expect(renderEditorSource).toContain('id="export-card"');
    expect(renderEditorSource).toContain('id="activate-agent"');
    expect(renderEditorSource).toContain('id="delete-agent"');
    expect(renderEditorSource).not.toContain('id="editor-form"');
    expect(renderEditorSource).not.toContain("Agent 名称");
    expect(renderEditorSource).not.toContain("身份描述");
    expect(renderEditorSource).not.toContain('class="roleplay-fields"');
  });

  it("manages per-agent writing samples in a separate bounded dialog", async () => {
    const [html, script, css] = await Promise.all([
      publicFile("admin.html"),
      publicFile("admin.js"),
      publicFile("admin.css"),
    ]);
    const personaDialog = html.match(
      /<dialog\b[^>]*\bid="persona-dialog"[^>]*>[\s\S]*?<\/dialog>/,
    )?.[0] ?? "";
    const examplesDialog = html.match(
      /<dialog\b[^>]*\bid="writing-examples-dialog"[^>]*>[\s\S]*?<\/dialog>/,
    )?.[0] ?? "";

    expect(personaDialog).toContain('id="open-writing-examples"');
    expect(personaDialog).toContain('aria-controls="writing-examples-dialog"');
    expect(personaDialog).not.toContain('id="writing-examples-list"');
    expect(examplesDialog).toContain('aria-labelledby="writing-examples-title"');
    expect(examplesDialog).toContain('aria-describedby="writing-examples-description"');
    for (const id of [
      "writing-examples-dialog",
      "writing-examples-list",
      "writing-example-editor",
      "writing-example-add",
      "writing-examples-save",
      "writing-examples-cancel",
      "writing-examples-close",
    ]) {
      expect(html.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
    expect(script).toContain("MAX_WRITING_STYLE_EXAMPLES = 20");
    expect(script).toContain("MAX_WRITING_STYLE_EXAMPLE_TEXT = 8_000");
    expect(script).toContain("MAX_WRITING_STYLE_EXAMPLES_TEXT = 48_000");
    expect(script).toContain('data-writing-example-action="up"');
    expect(script).toContain('data-writing-example-action="down"');
    expect(script).toContain('data-writing-example-action="delete"');
    expect(script).toContain("writingStyleExamples: examples");
    expect(script).toContain("expectedUpdatedAt: agent.updatedAt");
    expect(script).toContain("writingStyleExamplesDirty()");
    expect(script).toContain("AI 改写仍在后台生成");
    expect(script).toContain("AI 改写预览尚未应用");
    expect(script).toContain("写作示例还有尚未保存的修改");
    expect(script).toContain('dialog.addEventListener("cancel"');
    expect(script).toContain("if (saveError)");
    expect(script).toContain('escapeHtml(preview)');
    expect(script).toContain('$("#open-writing-examples")?.focus()');
    expect(script).toContain("agent.roleplay?.writingStyleExamples");
    expect(cssRule(css, ".writing-examples-launch")).toMatch(
      /grid-template-columns:\s*48px minmax\(0,\s*1fr\) auto;/,
    );
    expect(cssRule(css, ".writing-examples-shell")).toMatch(
      /grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;/,
    );
    expect(cssRule(css, ".writing-examples-workspace")).toMatch(
      /grid-template-columns:\s*minmax\(250px,\s*0\.72fr\) minmax\(0,\s*1\.28fr\);/,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*820px\)[\s\S]*?\.writing-examples-workspace\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
    );
  });

  it("previews AI writing-example edits before applying them to the local draft", async () => {
    const [script, css] = await Promise.all([
      publicFile("admin.js"),
      publicFile("admin.css"),
    ]);

    expect(script).toContain('id="writing-example-ai-request"');
    expect(script).toContain('id="writing-example-ai-result"');
    expect(script).toContain('data-writing-example-ai-action="generate"');
    expect(script).toContain('data-writing-example-ai-action="apply"');
    expect(script).toContain('data-writing-example-ai-action="discard"');
    expect(script).toContain(
      '"/api/agents/writing-example-draft"',
    );
    expect(script).toContain("expectedUpdatedAt: sourceUpdatedAt");
    expect(script).toContain("currentExample: sourceText");
    expect(script).toContain("writingExampleAiRequestMatches(context)");
    expect(script).toContain(
      "app.writingStyleExamplesDraft[index] = draftText",
    );
    expect(script).toContain("尚未保存。请确认后点击“保存示例库”");
    expect(script).toContain("escapeHtml(draftText)");
    expect(script).toContain("resetWritingExampleAiState({ incrementSequence: true })");
    expect(cssRule(css, "#writing-example-ai-request")).toMatch(
      /min-height:\s*104px;/,
    );
    expect(cssRule(css, ".writing-example-ai-comparison")).toMatch(
      /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*820px\)[\s\S]*?\.writing-example-ai-comparison\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
    );
  });

  it("configures per-agent natural image behavior without a daily cap", async () => {
    const [script, css] = await Promise.all([
      publicFile("admin.js"),
      publicFile("admin.css"),
    ]);
    const imageBehaviorSection = script.slice(
      script.indexOf("function imageBehaviorFromAgent"),
      script.indexOf("function renderEditor"),
    );
    const renderEditorSource = script.slice(
      script.indexOf("function renderEditor"),
      script.indexOf("function renderWeatherLoading"),
    );

    expect(imageBehaviorSection).toContain("cooldownMinutes: 0");
    expect(imageBehaviorSection).toMatch(
      /const mode = IMAGE_BEHAVIOR_MODES\.has\(source\.mode\)[\s\S]*?\? source\.mode\s*:\s*"explicit"/,
    );
    expect(imageBehaviorSection).toContain(
      "allowAutonomous: source.allowAutonomous === true",
    );
    expect(imageBehaviorSection).toContain('id="image-behavior-panel"');
    expect(imageBehaviorSection).toContain('id="image-behavior-form"');
    expect(imageBehaviorSection).toContain("图片行为");
    expect(imageBehaviorSection).toContain('value="off"');
    expect(imageBehaviorSection).toContain('value="explicit"');
    expect(imageBehaviorSection).toContain('value="natural"');
    expect(imageBehaviorSection).not.toContain('name="cooldownMinutes"');
    expect(imageBehaviorSection).toContain("没有时间间隔或每日图片上限");
    expect(imageBehaviorSection).not.toContain("dailyLimit");
    expect(imageBehaviorSection).toContain('name="allowAutonomous"');
    expect(imageBehaviorSection).toContain('name="visualIdentityPrompt"');
    expect(imageBehaviorSection).toContain('maxlength="8000"');
    expect(imageBehaviorSection).toContain("sourceUpdatedAt !== agent.updatedAt");
    expect(imageBehaviorSection).toContain(
      "form.dataset.userId !== user.userId",
    );
    expect(imageBehaviorSection).toContain(
      "form.dataset.agentId !== agent.id",
    );
    expect(imageBehaviorSection).toContain(
      "expectedUpdatedAt: sourceUpdatedAt",
    );
    expect(imageBehaviorSection).toContain(
      '"/api/agents/image-behavior"',
    );
    expect(imageBehaviorSection).not.toContain(
      '"/api/agents/update"',
    );
    expect(imageBehaviorSection).toContain("imageBehavior,");
    expect(imageBehaviorSection).toContain(
      "agentSelectionMatches(requestedUserId, requestedAgentId)",
    );
    expect(renderEditorSource).toContain("renderImageBehaviorPanel(agent)");
    expect(renderEditorSource).toContain("bindImageBehaviorPanel()");
    expect(script).toContain('"imageBehavior",');
    expect(cssRule(css, ".image-behavior-panel")).toMatch(
      /display:\s*grid;/,
    );
    expect(cssRule(css, ".image-behavior-mode-options")).toMatch(
      /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
    );
    expect(cssRule(css, ".image-behavior-settings")).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*680px\)[\s\S]*?\.image-behavior-mode-options\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
    );
  });

  it("shows and controls autonomous life without refreshing the whole editor", async () => {
    const script = await publicFile("admin.js");
    const autonomySection = script.slice(
      script.indexOf("function autonomySelectionKey"),
      script.indexOf("function personaProfileFromAgent"),
    );

    expect(script).toContain('id="autonomy-panel"');
    expect(script).toContain("自主生活");
    expect(script).toContain("主动联系通道");
    expect(script).toContain("最近检查");
    expect(script).toContain("最近记录");
    expect(script).toContain("不会主动联系用户");
    expect(script).toContain("最近自主经历");
    expect(script).toContain("当前心境");
    expect(script).toContain("重要度");
    expect(script).toContain("可聊性");
    expect(script).toContain("可聊点");
    expect(script).toContain("未决线索");
    expect(script).toContain("联系理由");
    expect(script).toContain("拟发送消息");
    expect(script).toContain('fetch(`/api/agents/autonomy?${query}`');
    expect(script).toContain('url: "/api/agents/autonomy/settings"');
    expect(script).toContain('url: "/api/agents/autonomy/generate"');
    expect(script).toContain("autonomySelectionMatches(userId, agentId)");
    expect(script).toContain("app.autonomyBusyKeys.has(key)");
    expect(script).toContain(
      'escapeHtml(event?.summary || "未提供经历摘要。")',
    );
    expect(script).toContain('escapeHtml(event?.mood || "未记录")');
    expect(script).toContain("escapeHtml(event.conversationHook)");
    expect(script).toContain("escapeHtml(event.openThread)");
    expect(script).toContain("escapeHtml(event.contactReason)");
    expect(script).toContain("escapeHtml(event.message)");
    expect(autonomySection).not.toContain("lastContextToken");
    expect(autonomySection).not.toContain("contactError");
    expect(autonomySection).not.toContain("refreshState()");
  });

  it("renders the complete chat archive instead of only the latest 200 messages", async () => {
    const [html, script] = await Promise.all([
      publicFile("admin.html"),
      publicFile("admin.js"),
    ]);
    const historyRenderer = script.slice(
      script.indexOf("function renderHistoryMessages"),
      script.indexOf("async function openPromptTraceDialog"),
    );

    expect(html).toContain("完整聊天记忆");
    expect(script).toContain(
      "查看全部 ${agent.totalMemoryCount || 0} 条聊天",
    );
    expect(script).toContain("不是完整归档");
    expect(historyRenderer).not.toContain("slice(-200)");
    expect(historyRenderer).toContain(
      "已显示完整归档，共 ${app.historyMessages.length} 条",
    );
    expect(historyRenderer).toMatch(
      /renderMemoryMessages\(\s*matched,\s*app\.historyAgentName,/,
    );
  });

  it("opens every persisted curated-memory version in a searchable dialog", async () => {
    const [html, script, css] = await Promise.all([
      publicFile("admin.html"),
      publicFile("admin.js"),
      publicFile("admin.css"),
    ]);
    const renderer = script.slice(
      script.indexOf("async function openMemorySummaryHistoryDialog"),
      script.indexOf("async function openHistoryDialog"),
    );

    expect(html).toContain('id="summary-history-dialog"');
    expect(html).toContain('id="summary-history-search"');
    expect(html).toContain('id="summary-history-list"');
    expect(html).toContain('id="summary-history-close"');
    expect(script).toContain('id="view-summary-history"');
    expect(script).toContain("查看全部摘要版本");
    expect(script).toContain("当前生效摘要");
    expect(script).toContain(
      '$("#summary-history-dialog").addEventListener("close"',
    );
    expect(script).toContain(
      'fetch(`/api/agents/memory-summaries?${query}`',
    );
    expect(renderer).toContain("app.summarySnapshots");
    expect(renderer).toContain("app.summaryHistoryRequestSequence");
    expect(renderer).toContain("requestKey !== app.summaryHistoryKey");
    expect(renderer).toContain("!dialog.open");
    expect(renderer).toContain("matched.map(renderMemorySummarySnapshot)");
    expect(renderer).toContain("snapshot?.summary");
    expect(renderer).toContain("snapshot?.facts");
    expect(renderer).toContain("snapshot?.episodes");
    expect(renderer).toContain("旧版迁移基线");
    expect(renderer).toContain("不能精确伪造");
    expect(renderer).not.toMatch(/slice\(\s*-\d+/);
    expect(cssRule(css, ".summary-history-list")).toMatch(
      /align-content:\s*start;/,
    );
    expect(cssRule(css, ".summary-snapshot-copy")).toMatch(
      /white-space:\s*pre-wrap;/,
    );
  });

  it("groups complete event details into searchable major events without losing rebuild controls", async () => {
    const [html, script, css] = await Promise.all([
      publicFile("admin.html"),
      publicFile("admin.js"),
      publicFile("admin.css"),
    ]);
    const renderer = script.slice(
      script.indexOf("async function openMemoryEpisodeArchiveDialog"),
      script.indexOf("async function openMemorySummaryHistoryDialog"),
    );

    expect(html).toContain('id="episode-archive-dialog"');
    expect(html).toContain('id="episode-archive-search"');
    expect(html).toContain('id="episode-archive-organize"');
    expect(html).toContain('id="episode-archive-rebuild"');
    expect(html).toContain('id="episode-rebuild-progress-bar"');
    expect(html).toContain("只会整理这里已经保存的事件细节");
    expect(html).toContain("不会重新读取完整聊天");
    expect(script).toContain('id="view-episode-archive"');
    expect(script).toContain("查看全部事件记忆");
    expect(script).toContain(
      '$("#episode-archive-dialog").addEventListener("close"',
    );
    expect(renderer).toContain(
      'fetch(`/api/agents/memory-episodes?${query}`',
    );
    expect(renderer).toContain(
      'fetch("/api/agents/memory-episodes/rebuild"',
    );
    expect(renderer).toContain(
      'fetch("/api/agents/memory-episodes/organize"',
    );
    expect(renderer).toContain("app.episodeArchiveRequestSequence");
    expect(renderer).toContain("requestKey !== app.episodeArchiveKey");
    expect(renderer).toContain("app.episodeArchiveDialogSession");
    expect(renderer).toContain("isCurrentDialog()");
    expect(renderer).toContain("app.episodeArchiveMajorEvents");
    expect(renderer).toContain("renderArchivedMajorEvent");
    expect(renderer).toContain('class="episode-major-card"');
    expect(renderer).toContain("majorEvent?.details");
    expect(renderer).toContain('["title", "summary"]');
    expect(renderer).toContain('["title", "content"]');
    expect(renderer).toContain("matchedUngroupedEpisodes");
    expect(renderer).toContain("来源：日常记忆整理");
    expect(renderer).toContain("episode.reconstructed");
    expect(renderer).toContain("来源：聊天重建");
    expect(renderer).toContain("来源：旧版迁移");
    expect(renderer).toContain("不会重新读取完整聊天");
    expect(renderer).toContain("不会删除或改写原有细节");
    expect(renderer).toContain("完整聊天分批交给当前模型");
    expect(renderer).toContain('"X-WeBot-Request": "admin"');
    expect(cssRule(css, ".episode-archive-list")).toMatch(
      /align-content:\s*start;/,
    );
    expect(cssRule(css, ".episode-major-card")).toMatch(
      /overflow:\s*hidden;/,
    );
    expect(cssRule(css, ".episode-major-card > summary")).toMatch(
      /cursor:\s*pointer;/,
    );
    expect(cssRule(css, ".episode-detail-list")).toMatch(
      /display:\s*grid;/,
    );
    expect(cssRule(css, ".episode-archive-card > p")).toMatch(
      /white-space:\s*pre-wrap;/,
    );
  });

  it("configures daily weather with isolated per-agent loading and mutations", async () => {
    const script = await publicFile("admin.js");
    const renderEditorSource = script.slice(
      script.indexOf("function renderEditor"),
      script.indexOf("function renderWeatherLoading"),
    );
    const weatherSection = script.slice(
      script.indexOf("function renderWeatherLoading"),
      script.indexOf("function autonomySelectionKey"),
    );

    expect(renderEditorSource).toContain('id="weather-panel"');
    expect(weatherSection).toContain("每日天气");
    expect(weatherSection).toContain("当前人物现场生成");
    expect(weatherSection).toContain("天气地点");
    expect(weatherSection).toContain('name="location"');
    expect(weatherSection).toContain("每日时间");
    expect(weatherSection).toContain('name="localTime"');
    expect(weatherSection).toContain("时区");
    expect(weatherSection).toContain('name="timeZone"');
    expect(weatherSection).toContain("启用每日发送");
    expect(weatherSection).toContain('name="enabled"');
    expect(weatherSection).toContain(">预览</button>");
    expect(weatherSection).toContain(">立即测试发送</button>");
    expect(weatherSection).toContain(
      'fetch(`/api/agents/weather?${query}`',
    );
    expect(weatherSection).toContain(
      '"/api/agents/weather/settings"',
    );
    expect(weatherSection).toContain(
      "`/api/agents/weather/${action}`",
    );
    expect(weatherSection).toContain('"preview"');
    expect(weatherSection).toContain('"send-now"');
    expect(weatherSection).toContain(
      'busy || !snapshot.location || !snapshot.deliveryAvailable',
    );

    expect(script).toContain("weatherSnapshotKey:");
    expect(script).toContain("weatherBusyKeys: new Set()");
    expect(script).toContain("weatherRequestSequence:");
    expect(weatherSection).toContain(
      "const requestSequence = ++app.weatherRequestSequence",
    );
    expect(weatherSection).toContain(
      "requestSequence !== app.weatherRequestSequence",
    );
    expect(weatherSection).toContain(
      "!autonomySelectionMatches(userId, agentId)",
    );
    expect(weatherSection).toContain("app.weatherBusyKeys.has(key)");
    expect(weatherSection).toContain("app.weatherSnapshotKey !== key");
    expect(weatherSection).not.toContain("contextToken");
    expect(weatherSection).not.toContain("refreshState()");
  });

  it("provides a private multi-work story book that generates full prose", async () => {
    const [html, script, css] = await Promise.all([
      publicFile("admin.html"),
      publicFile("admin.js"),
      publicFile("admin.css"),
    ]);
    expect(html).toContain('id="story-book-dialog"');
    expect(html).toContain('id="story-book-list"');
    expect(html).toContain('id="story-book-premise"');
    expect(html).toContain('id="story-book-content"');
    expect(html).toContain("完整故事正文，而不是剧情大纲");
    expect(html).toContain('data-story-book-prompt="忠实保留我的剧情构想');
    expect(script).toContain('id="open-story-book"');
    expect(script).toContain("openStoryBookDialog");
    expect(script).toContain('fetch(`/api/agents/story-book?${query}`');
    expect(script).toContain('"/api/agents/story-book-draft"');
    expect(script).toContain('"/api/agents/story-book"');
    expect(script).toContain("expectedBookUpdatedAt");
    expect(script).toContain("故事作品已保存到私有状态目录");
    expect(cssRule(css, ".story-book-workspace")).toMatch(
      /grid-template-columns:\s*230px minmax\(420px,\s*1fr\) minmax\(330px,\s*0\.62fr\);/,
    );
    expect(cssRule(css, ".story-book-content-label textarea")).toMatch(
      /min-height:\s*420px;/,
    );
  });
});
