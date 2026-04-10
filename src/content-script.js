const ROOT_CLASS = "trp-root";
const TRANSLATION_CLASS = "trp-translation";
const HIDDEN_CLASS = "trp-hidden";
const DATA_ID = "trpSegmentId";

const session = {
  hidden: false,
  segments: new Map(),
  clickHandlerAttached: false,
  translationColorTheme: "warm-taupe"
};

const COLOR_THEMES = {
  "deep-olive": {
    text: "#41493d",
    muted: "#717a6c",
    button: "#596352"
  },
  "charcoal-blue": {
    text: "#394756",
    muted: "#677584",
    button: "#4d5d6e"
  },
  "warm-taupe": {
    text: "#4d4338",
    muted: "#7f7467",
    button: "#6b5b4d"
  },
  "sage-olive": {
    text: "#4d5a48",
    muted: "#778270",
    button: "#667260"
  },
  "soft-amber": {
    text: "#9a6d2f",
    muted: "#b18c5a",
    button: "#b57b33"
  },
  "mist-blue": {
    text: "#62829a",
    muted: "#86a0b3",
    button: "#7695ab"
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    switch (message.type) {
      case "PREPARE_TRANSLATION":
        sendResponse(prepareTranslation(message.translationColorTheme));
        break;
      case "APPLY_TRANSLATION_THEME":
        applyTheme(message.translationColorTheme);
        sendResponse({ ok: true });
        break;
      case "TRANSLATION_BATCH_STARTED":
        markSegmentsPending(message.segmentIds || []);
        sendResponse({ ok: true });
        break;
      case "MARK_SEGMENTS_RETRYING":
        markSegmentsPending(message.segmentIds || []);
        sendResponse({ ok: true });
        break;
      case "TRANSLATION_BATCH_RESULT":
        applyTranslations(message.translations || []);
        sendResponse({ ok: true });
        break;
      case "TRANSLATION_BATCH_ERROR":
        markSegmentsFailed(message.segmentIds || [], message.error || "Translation failed.");
        sendResponse({ ok: true });
        break;
      case "TRANSLATION_SESSION_ERROR":
        sendResponse({ ok: true });
        break;
      case "TRANSLATION_STOPPED":
        sendResponse({ ok: true });
        break;
      case "TOGGLE_TRANSLATION_VISIBILITY":
        sendResponse({ ok: true, hidden: toggleVisibility() });
        break;
      case "CLEAR_TRANSLATION":
        clearTranslation();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return true;
});

function prepareTranslation(translationColorTheme) {
  clearTranslation();
  attachInlineActions();
  applyTheme(translationColorTheme);

  const segments = collectSegments();
  for (const segment of segments) {
    session.segments.set(segment.segmentId, segment);
  }

  return {
    ok: true,
    segments: segments.map(({ segmentId, text, context }) => ({ segmentId, text, context }))
  };
}

function clearTranslation() {
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
  document.querySelectorAll(`[data-${toDataAttribute(DATA_ID)}]`).forEach((node) => {
    delete node.dataset[DATA_ID];
  });
  session.hidden = false;
  session.segments.clear();
}

function applyTheme(themeKey) {
  session.translationColorTheme = COLOR_THEMES[themeKey] ? themeKey : "warm-taupe";
  const theme = COLOR_THEMES[session.translationColorTheme];
  document.documentElement.style.setProperty("--trp-text", theme.text);
  document.documentElement.style.setProperty("--trp-muted", theme.muted);
  document.documentElement.style.setProperty("--trp-button-bg", theme.button);
}

function collectSegments() {
  const segments = [
    ...collectCodeCommentSegments(),
    ...collectTableCellSegments(),
    ...collectSidebarNavSegments(),
    ...collectContentSegments()
  ];

  segments.sort((a, b) => {
    const priorityA = a.context === "nav" ? 1 : 0;
    const priorityB = b.context === "nav" ? 1 : 0;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    if (a.element === b.element) {
      return 0;
    }

    const position = a.element.compareDocumentPosition(b.element);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  });

  return segments;
}

function collectContentSegments() {
  const candidates = Array.from(
    document.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dd,dt,summary,div")
  );

  const segments = [];
  const seenTexts = new Set();
  let index = 0;

  for (const element of candidates) {
    if (!isEligibleElement(element)) {
      continue;
    }

    const text = normalizeText(element.innerText || "");
    if (!text || text.length < 18 || !isEnglishHeavy(text, { minLatin: 12 }) || looksLikeIdentifier(text)) {
      continue;
    }

    const signature = `${element.tagName}:${text}`;
    if (seenTexts.has(signature)) {
      continue;
    }

    seenTexts.add(signature);
    const segmentId = `segment-${index}`;
    index += 1;
    element.dataset[DATA_ID] = segmentId;

    segments.push({
      segmentId,
      text,
      element,
      context: "content"
    });
  }

  return segments;
}

function isEligibleElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (!isVisible(element)) {
    return false;
  }

  if (element.closest("script,style,noscript,svg,canvas,textarea,input,select,button,code,pre,kbd,samp")) {
    return false;
  }

  if (element.closest("nav,header,footer,aside,form,[role='navigation'],[contenteditable='true']")) {
    return false;
  }

  if (element.classList.contains(TRANSLATION_CLASS) || element.closest(`.${TRANSLATION_CLASS}`)) {
    return false;
  }

  if (element.tagName === "DIV") {
    if (element.closest("table") || element.querySelector("table")) {
      return false;
    }

    if (element.querySelector("nav, aside, [role='navigation']")) {
      return false;
    }

    if (element.querySelector("p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dd,dt")) {
      return false;
    }

    const childBlocks = Array.from(element.children).filter((child) => {
      if (!(child instanceof HTMLElement)) {
        return false;
      }
      const display = window.getComputedStyle(child).display;
      return display === "block" || display === "flex" || display === "grid";
    });

    if (childBlocks.length > 1) {
      return false;
    }
  }

  return true;
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function collectCodeCommentSegments() {
  const blocks = Array.from(document.body.querySelectorAll("pre, pre code, code"))
    .filter((element) => element instanceof HTMLElement)
    .filter((element) => isCodeBlockElement(element));

  const segments = [];
  const seenElements = new Set();
  let index = 0;

  for (const element of blocks) {
    const root = resolveCodeBlockRoot(element);
    if (!root || seenElements.has(root) || !isVisible(root)) {
      continue;
    }

    const codeText = root.innerText || root.textContent || "";
    const commentText = extractCommentText(codeText);
    if (!commentText) {
      continue;
    }

    seenElements.add(root);
    const segmentId = `code-comment-${index}`;
    index += 1;
    root.dataset[DATA_ID] = segmentId;

    segments.push({
      segmentId,
      text: commentText,
      element: root,
      kind: "code-comment",
      context: "code-comment"
    });
  }

  return segments;
}

function isCodeBlockElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.closest("script,style,noscript")) {
    return false;
  }

  const root = resolveCodeBlockRoot(element);
  if (!root) {
    return false;
  }

  const text = root.innerText || root.textContent || "";
  return text.trim().length >= 8;
}

function resolveCodeBlockRoot(element) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  return element.closest("pre") || element;
}

function looksLikeIdentifier(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 50) {
    return false;
  }

  if (/\s/.test(trimmed)) {
    return false;
  }

  return /[\d_.-]/.test(trimmed) && /^[A-Za-z0-9_.:-]+$/.test(trimmed);
}

function collectTableCellSegments() {
  const cells = Array.from(document.body.querySelectorAll("table th, table td"));
  const segments = [];
  const seenSignatures = new Set();
  let index = 0;

  for (const cell of cells) {
    if (!(cell instanceof HTMLElement)) {
      continue;
    }

    if (!isVisible(cell)) {
      continue;
    }

    if (cell.closest(`.${TRANSLATION_CLASS}`)) {
      continue;
    }

    const text = normalizeText(cell.innerText || "");
    if (!text) {
      continue;
    }

    if (looksLikeIdentifier(text)) {
      continue;
    }

    if (text.length < 3 || !isEnglishHeavy(text, { minLatin: 3 })) {
      continue;
    }

    const row = cell.parentElement;
    const rowIndex = typeof row?.rowIndex === "number" ? row.rowIndex : "";
    const cellIndex = typeof cell.cellIndex === "number" ? cell.cellIndex : "";
    const signature = `${cell.tagName}:${rowIndex}:${cellIndex}:${text}`;
    if (seenSignatures.has(signature)) {
      continue;
    }
    seenSignatures.add(signature);

    const segmentId = `table-${index}`;
    index += 1;
    cell.dataset[DATA_ID] = segmentId;

    segments.push({
      segmentId,
      text,
      element: cell,
      context: "table"
    });
  }

  return segments;
}

function collectSidebarNavSegments() {
  const container = findSidebarNavContainer();
  if (!container) {
    return [];
  }

  const segments = [];
  const seenSignatures = new Set();
  let index = 0;

  const candidates = [
    ...Array.from(container.querySelectorAll("a")),
    ...Array.from(container.querySelectorAll("h2,h3,h4"))
  ];

  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    if (!isVisible(element)) {
      continue;
    }

    if (element.closest("script,style,noscript,svg,canvas,textarea,input,select")) {
      continue;
    }

    if (element.closest(`.${TRANSLATION_CLASS}`)) {
      continue;
    }

    const text = normalizeText(element.innerText || "");
    if (!text || text.length < 3 || !isEnglishHeavy(text, { minLatin: 3 })) {
      continue;
    }

    const href = element.tagName === "A" ? element.getAttribute("href") || "" : "";
    const signature = `${element.tagName}:${href}:${text}`;
    if (seenSignatures.has(signature)) {
      continue;
    }
    seenSignatures.add(signature);

    const segmentId = `nav-${index}`;
    index += 1;
    element.dataset[DATA_ID] = segmentId;

    segments.push({
      segmentId,
      text,
      element,
      context: "nav"
    });
  }

  return segments;
}

function findSidebarNavContainer() {
  const candidates = Array.from(document.querySelectorAll("nav, aside, [role='navigation']"))
    .filter((element) => element instanceof HTMLElement)
    .filter((element) => isVisible(element));

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  const scored = candidates
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { element, rect, area: rect.width * rect.height };
    })
    .filter(({ rect }) => rect.width >= 140 && rect.width <= 480)
    .filter(({ rect }) => rect.height >= viewportHeight * 0.45)
    .filter(({ rect }) => rect.left >= -20 && rect.left <= viewportWidth * 0.4)
    .filter(({ rect }) => rect.top >= -20 && rect.top <= viewportHeight * 0.35)
    .sort((a, b) => b.area - a.area);

  return scored[0]?.element || null;
}

function isEnglishHeavy(text, options = {}) {
  const chineseMatches = text.match(/[\u3400-\u9fff]/g) || [];
  const latinMatches = text.match(/[A-Za-z]/g) || [];
  const minLatin = Number.isFinite(options.minLatin) ? options.minLatin : 12;

  if (latinMatches.length < minLatin) {
    return false;
  }

  return latinMatches.length >= chineseMatches.length * 2;
}

function extractCommentText(codeText) {
  const comments = [];
  const blockCommentPattern = /\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''/g;
  let blockMatch;

  while ((blockMatch = blockCommentPattern.exec(codeText)) !== null) {
    const normalized = cleanComment(blockMatch[0]);
    if (normalized) {
      comments.push(normalized);
    }
  }

  const lines = codeText.split(/\r?\n/);
  for (const line of lines) {
    const inlineComment = extractLineComment(line);
    if (inlineComment) {
      comments.push(inlineComment);
    }
  }

  const uniqueComments = Array.from(new Set(comments.map((comment) => comment.trim()).filter(Boolean)));
  return uniqueComments.join("\n");
}

function extractLineComment(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("//")) {
    return cleanComment(trimmed);
  }

  if (trimmed.startsWith("#")) {
    return cleanComment(trimmed);
  }

  const slashIndex = line.indexOf("//");
  if (slashIndex >= 0) {
    return cleanComment(line.slice(slashIndex));
  }

  const hashIndex = line.indexOf(" #");
  if (hashIndex >= 0) {
    return cleanComment(line.slice(hashIndex + 1));
  }

  return "";
}

function cleanComment(comment) {
  return comment
    .replace(/^\/\*+/, "")
    .replace(/\*\/$/, "")
    .replace(/^\/\//, "")
    .replace(/^#/, "")
    .replace(/^'''|'''$/g, "")
    .replace(/^"""|"""$/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .join("\n")
    .trim();
}

function markSegmentsPending(segmentIds) {
  for (const segmentId of segmentIds) {
    const segment = session.segments.get(segmentId);
    if (!segment?.element?.isConnected) {
      continue;
    }

    const container = ensureTranslationContainer(segment, segmentId);
    container.dataset.status = "pending";
    container.innerHTML = "";

    const label = document.createElement("div");
    label.className = "trp-status";
    label.textContent = "正在翻译...";
    container.append(label);
  }
}

function applyTranslations(translations) {
  for (const item of translations) {
    const segment = session.segments.get(item.segmentId);
    if (!segment?.element?.isConnected) {
      continue;
    }

    const container = ensureTranslationContainer(segment, item.segmentId);
    container.dataset.status = "done";
    container.innerHTML = "";

    const translationText = document.createElement("div");
    translationText.className = "trp-text";
    translationText.textContent = item.translatedText;
    container.append(translationText);
  }
}

function markSegmentsFailed(segmentIds, errorMessage) {
  for (const segmentId of segmentIds) {
    const segment = session.segments.get(segmentId);
    if (!segment?.element?.isConnected) {
      continue;
    }

    const container = ensureTranslationContainer(segment, segmentId);
    container.dataset.status = "failed";
    container.innerHTML = "";

    const label = document.createElement("div");
    label.className = "trp-status";
    label.textContent = "翻译失败";

    const detail = document.createElement("div");
    detail.className = "trp-error";
    detail.textContent = errorMessage;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "trp-inline-button";
    button.dataset.segmentId = segmentId;
    button.textContent = "重试该段";

    container.append(label, detail, button);
  }
}

function ensureTranslationContainer(segment, segmentId) {
  let container = document.querySelector(`.${TRANSLATION_CLASS}[data-segment-id="${segmentId}"]`);
  if (container) {
    return container;
  }

  const element = segment.element;
  container = document.createElement("div");
  container.className = `${TRANSLATION_CLASS} ${ROOT_CLASS}`;
  container.dataset.segmentId = segmentId;
  if (segment.context) {
    container.dataset.context = segment.context;
  }
  if (session.hidden) {
    container.classList.add(HIDDEN_CLASS);
  }

  if (segment.context === "table" && (element.tagName === "TD" || element.tagName === "TH")) {
    element.append(container);
  } else {
    element.insertAdjacentElement("afterend", container);
  }
  return container;
}

function toggleVisibility() {
  session.hidden = !session.hidden;
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => {
    node.classList.toggle(HIDDEN_CLASS, session.hidden);
  });
  return session.hidden;
}

function attachInlineActions() {
  if (session.clickHandlerAttached) {
    return;
  }

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("trp-inline-button")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const segmentId = target.dataset.segmentId;
    if (!segmentId) {
      return;
    }

    const segment = session.segments.get(segmentId);
    const payload = segment ? [{ segmentId, text: segment.text, context: segment.context || "" }] : [];

    target.setAttribute("disabled", "true");
    target.textContent = "重试中...";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "RETRY_TRANSLATION_SEGMENTS",
        segmentIds: [segmentId],
        segments: payload
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Retry failed.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markSegmentsFailed([segmentId], message);
    }
  });

  session.clickHandlerAttached = true;
}

function toDataAttribute(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
