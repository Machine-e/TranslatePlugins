const statusBadge = document.querySelector("#status-badge");
const statusMessage = document.querySelector("#status-message");
const progressBar = document.querySelector("#progress-bar");
const progressText = document.querySelector("#progress-text");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const toggleButton = document.querySelector("#toggle-button");
const clearButton = document.querySelector("#clear-button");
const openOptionsButton = document.querySelector("#open-options");
const translationColorTheme = document.querySelector("#translation-color-theme");

const STORAGE_KEY = "providerConfig";
const DEFAULT_THEME = "warm-taupe";

let currentTabId = null;
let currentState = null;

init().catch((error) => {
  updateUi(null, error instanceof Error ? error.message : String(error));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "PAGE_STATUS_CHANGED" && message.state?.tabId === currentTabId) {
    currentState = message.state;
    updateUi(currentState);
  }
});

startButton.addEventListener("click", () => handleAction("START_TRANSLATION"));
stopButton.addEventListener("click", () => handleAction("STOP_TRANSLATION"));
toggleButton.addEventListener("click", () => handleAction("TOGGLE_TRANSLATION_VISIBILITY"));
clearButton.addEventListener("click", () => handleAction("CLEAR_TRANSLATION"));

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

translationColorTheme.addEventListener("change", async () => {
  try {
    await updateTranslationTheme(translationColorTheme.value);
  } catch (error) {
    updateUi(currentState, error instanceof Error ? error.message : String(error));
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  currentTabId = tab.id;
  const response = await chrome.runtime.sendMessage({
    type: "GET_PAGE_STATUS",
    tabId: currentTabId
  });
  currentState = response.state || null;
  await hydrateThemeControl();
  updateUi(currentState);
}

async function sendBackgroundMessage(type) {
  if (currentTabId === null) {
    throw new Error("No active tab found.");
  }

  const response = await chrome.runtime.sendMessage({
    type,
    tabId: currentTabId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The action failed.");
  }

  return response;
}

async function handleAction(type) {
  try {
    const response = await sendBackgroundMessage(type);
    currentState = response.state || (type === "CLEAR_TRANSLATION" ? null : currentState);

    if (type === "CLEAR_TRANSLATION") {
      updateUi(currentState, "当前页译文已清除。");
      return;
    }

    updateUi(currentState);
  } catch (error) {
    updateUi(currentState, error instanceof Error ? error.message : String(error));
  }
}

async function hydrateThemeControl() {
  const { [STORAGE_KEY]: config } = await chrome.storage.local.get(STORAGE_KEY);
  translationColorTheme.value = config?.translationColorTheme || DEFAULT_THEME;
}

async function updateTranslationTheme(theme) {
  if (currentTabId === null) {
    throw new Error("No active tab found.");
  }

  const response = await chrome.runtime.sendMessage({
    type: "SET_TRANSLATION_COLOR_THEME",
    tabId: currentTabId,
    translationColorTheme: theme
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Failed to update translation color.");
  }

  if (response.state) {
    currentState = response.state;
  }

  updateUi(currentState, "译文字体颜色已更新。");
}

function updateUi(state, overrideMessage) {
  const stage = state?.stage || "idle";
  const completed = state?.completedCount || 0;
  const total = state?.totalSegments || 0;
  const message = overrideMessage || state?.lastMessage || "点击“开始翻译”处理当前页面。";
  const hidden = Boolean(state?.hidden);
  const progress = total ? Math.round((completed / total) * 100) : 0;

  statusBadge.dataset.stage = stage;
  statusBadge.textContent = stageToLabel(stage);
  statusMessage.textContent = message;
  progressText.textContent = `${completed} / ${total}`;
  progressBar.style.width = `${progress}%`;
  toggleButton.textContent = hidden ? "显示译文" : "隐藏译文";

  startButton.disabled = stage === "running" || stage === "retrying";
  stopButton.disabled = !(stage === "running" || stage === "retrying");
  toggleButton.disabled = !state;
  clearButton.disabled = !state;
}

function stageToLabel(stage) {
  switch (stage) {
    case "running":
      return "翻译中";
    case "retrying":
      return "重试中";
    case "completed":
      return "已完成";
    case "partial":
      return "部分失败";
    case "stopped":
      return "已停止";
    case "error":
      return "错误";
    default:
      return "待命";
  }
}
