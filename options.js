const STORAGE_KEY = "providerConfig";
const BUILTIN_PROMPT_ID = "builtin-default";
const BUILTIN_PROMPT_LABEL = "内置默认提示词";
const BUILTIN_SYSTEM_PROMPT = [
  "You are a meticulous translator for technical webpages.",
  "Translate English webpage content into precise, natural, restrained Simplified Chinese for Chinese readers.",
  "Return valid JSON only.",
  "Output shape: {\"translations\":[{\"segmentId\":\"...\",\"translatedText\":\"...\"}]}",
  "Rules:",
  "- Accuracy and terminology consistency have priority over stylistic rewriting.",
  "- Keep the same segment order and segment IDs as the input.",
  "- Do not merge or split segments.",
  "- Use the provided page, section, table, navigation, and term-memory context to resolve meaning.",
  "- Preserve model names, product names, brand names, URLs, file paths, commands, and code identifiers when appropriate.",
  "- Preserve numbers, currencies, units, and table values; translate only the human-readable labels.",
  "- For content paragraphs, keep the meaning exact and the tone clear and controlled. Important technical terms may use 中文（English） on first helpful mention only.",
  "- For nav/table labels, keep translations concise and avoid unnecessary bilingual expansion.",
  "- For code comments, translate comments only, keep them comment-like, and never output code.",
  "- Do not add commentary, notes, or extra keys."
].join("\n");

const DEFAULTS = {
  providerBaseUrl: "",
  apiKey: "",
  model: "",
  requestTimeoutMs: 45000,
  batchSize: 6,
  translationColorTheme: "warm-taupe",
  promptPresets: [
    {
      id: BUILTIN_PROMPT_ID,
      label: BUILTIN_PROMPT_LABEL,
      content: BUILTIN_SYSTEM_PROMPT,
      builtIn: true
    }
  ],
  activePromptId: BUILTIN_PROMPT_ID
};

const form = document.querySelector("#config-form");
const saveStatus = document.querySelector("#save-status");
const resetButton = document.querySelector("#reset-defaults");
const addPromptButton = document.querySelector("#add-prompt");
const promptDraft = document.querySelector("#prompt-draft");
const promptList = document.querySelector("#prompt-list");

let promptState = {
  promptPresets: [...DEFAULTS.promptPresets],
  activePromptId: DEFAULTS.activePromptId
};

init().catch((error) => {
  showStatus(error instanceof Error ? error.message : String(error), true);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const data = readForm();
  if (!isValid(data)) {
    showStatus("请填写完整的 Base URL、API Key 和 Model，并确认 timeout 与 batch size 合法。", true);
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: data });
  showStatus("设置已保存。");
});

addPromptButton.addEventListener("click", () => {
  const content = promptDraft.value.trim();
  if (!content) {
    showStatus("先输入一套提示词再添加。", true);
    return;
  }

  const newPrompt = {
    id: buildPromptId(),
    label: derivePromptLabel(content),
    content,
    builtIn: false
  };

  promptState.promptPresets = [...promptState.promptPresets, newPrompt];
  promptState.activePromptId = newPrompt.id;
  promptDraft.value = "";
  renderPromptList();
  showStatus("提示词已添加，并已设为当前启用项。");
});

resetButton.addEventListener("click", () => {
  applyForm(normalizeStoredConfig(DEFAULTS));
  showStatus("已恢复默认值，记得点击保存。");
});

promptList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const promptId = target.dataset.promptId;
  if (!promptId) {
    return;
  }

  if (target.classList.contains("prompt-enable")) {
    promptState.activePromptId = promptId;
    renderPromptList();
    showStatus("已切换当前启用的提示词。");
    return;
  }

  if (target.classList.contains("prompt-delete")) {
    if (promptId === BUILTIN_PROMPT_ID) {
      showStatus("内置提示词不能删除。", true);
      return;
    }

    promptState.promptPresets = promptState.promptPresets.filter((prompt) => prompt.id !== promptId);
    if (promptState.activePromptId === promptId) {
      promptState.activePromptId = BUILTIN_PROMPT_ID;
    }
    renderPromptList();
    showStatus("提示词已删除。");
  }
});

async function init() {
  const { [STORAGE_KEY]: savedConfig } = await chrome.storage.local.get(STORAGE_KEY);
  applyForm(normalizeStoredConfig(savedConfig));
}

function readForm() {
  return {
    providerBaseUrl: document.querySelector("#provider-base-url").value.trim(),
    apiKey: document.querySelector("#api-key").value.trim(),
    model: document.querySelector("#model").value.trim(),
    requestTimeoutMs: Number(document.querySelector("#request-timeout-ms").value),
    batchSize: Number(document.querySelector("#batch-size").value),
    translationColorTheme: document.querySelector("#translation-color-theme").value,
    promptPresets: promptState.promptPresets,
    activePromptId: promptState.activePromptId
  };
}

function applyForm(config) {
  document.querySelector("#provider-base-url").value = config.providerBaseUrl || "";
  document.querySelector("#api-key").value = config.apiKey || "";
  document.querySelector("#model").value = config.model || "";
  document.querySelector("#request-timeout-ms").value = String(config.requestTimeoutMs || DEFAULTS.requestTimeoutMs);
  document.querySelector("#batch-size").value = String(config.batchSize || DEFAULTS.batchSize);
  document.querySelector("#translation-color-theme").value = config.translationColorTheme || DEFAULTS.translationColorTheme;
  promptDraft.value = "";
  promptState = {
    promptPresets: config.promptPresets,
    activePromptId: config.activePromptId
  };
  renderPromptList();
}

function isValid(config) {
  return Boolean(
    config.providerBaseUrl &&
      config.apiKey &&
      config.model &&
      Number.isFinite(config.requestTimeoutMs) &&
      config.requestTimeoutMs >= 5000 &&
      Number.isFinite(config.batchSize) &&
      config.batchSize >= 1 &&
      config.batchSize <= 20 &&
      Array.isArray(config.promptPresets) &&
      config.promptPresets.length >= 1 &&
      config.promptPresets.some((prompt) => prompt.id === config.activePromptId)
  );
}

function showStatus(message, isError = false) {
  saveStatus.textContent = message;
  saveStatus.style.color = isError ? "#9a3921" : "#6b5d49";
}

function renderPromptList() {
  promptList.innerHTML = "";

  for (const prompt of promptState.promptPresets) {
    const item = document.createElement("article");
    item.className = `prompt-item${prompt.id === promptState.activePromptId ? " active" : ""}`;
    item.title = prompt.content;

    const meta = document.createElement("div");
    meta.className = "prompt-meta";

    const title = document.createElement("p");
    title.className = "prompt-title";
    title.textContent = prompt.label;

    const preview = document.createElement("p");
    preview.className = "prompt-preview";
    preview.textContent = collapsePromptPreview(prompt.content);

    meta.append(title, preview);

    const actions = document.createElement("div");
    actions.className = "prompt-actions";

    if (!prompt.builtIn) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "prompt-delete";
      deleteButton.dataset.promptId = prompt.id;
      deleteButton.textContent = "删除";
      actions.append(deleteButton);
    }

    const enableButton = document.createElement("button");
    enableButton.type = "button";
    enableButton.className = `prompt-enable${prompt.id === promptState.activePromptId ? " active" : ""}`;
    enableButton.dataset.promptId = prompt.id;
    enableButton.textContent = prompt.id === promptState.activePromptId ? "已启用" : "启用";
    actions.append(enableButton);

    item.append(meta, actions);
    promptList.append(item);
  }
}

function normalizeStoredConfig(savedConfig) {
  const merged = {
    ...DEFAULTS,
    ...savedConfig,
    requestTimeoutMs: Number(savedConfig?.requestTimeoutMs || DEFAULTS.requestTimeoutMs),
    batchSize: Number(savedConfig?.batchSize || DEFAULTS.batchSize)
  };

  const promptPresets = [
    {
      id: BUILTIN_PROMPT_ID,
      label: BUILTIN_PROMPT_LABEL,
      content: BUILTIN_SYSTEM_PROMPT,
      builtIn: true
    }
  ];

  const existingPrompts = Array.isArray(savedConfig?.promptPresets) ? savedConfig.promptPresets : [];
  for (const prompt of existingPrompts) {
    if (!prompt?.id || prompt.id === BUILTIN_PROMPT_ID) {
      continue;
    }

    const content = typeof prompt.content === "string" ? prompt.content.trim() : "";
    if (!content) {
      continue;
    }

    promptPresets.push({
      id: prompt.id,
      label: typeof prompt.label === "string" && prompt.label.trim() ? prompt.label.trim() : derivePromptLabel(content),
      content,
      builtIn: false
    });
  }

  if (!existingPrompts.length && typeof savedConfig?.systemPrompt === "string" && savedConfig.systemPrompt.trim()) {
    const legacyContent = savedConfig.systemPrompt.trim();
    promptPresets.push({
      id: "migrated-legacy-prompt",
      label: derivePromptLabel(legacyContent),
      content: legacyContent,
      builtIn: false
    });
  }

  const activePromptId = promptPresets.some((prompt) => prompt.id === savedConfig?.activePromptId)
    ? savedConfig.activePromptId
    : promptPresets[promptPresets.length - 1].id;

  return {
    providerBaseUrl: merged.providerBaseUrl,
    apiKey: merged.apiKey,
    model: merged.model,
    requestTimeoutMs: merged.requestTimeoutMs,
    batchSize: merged.batchSize,
    translationColorTheme: merged.translationColorTheme || DEFAULTS.translationColorTheme,
    promptPresets,
    activePromptId
  };
}

function derivePromptLabel(content) {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > 14 ? `${collapsed.slice(0, 14)}...` : collapsed || "未命名提示词";
}

function collapsePromptPreview(content) {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > 34 ? `${collapsed.slice(0, 34)}...` : collapsed;
}

function buildPromptId() {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
