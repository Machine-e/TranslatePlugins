const STORAGE_KEY = "providerConfig";
const BUILTIN_PROMPT_ID = "builtin-default";
const BUILTIN_PROMPT_LABEL = "内置默认提示词";
const BUILTIN_SYSTEM_PROMPT = [
  "You are a professional webpage translator.",
  "Translate English text into natural, accurate, fluent Simplified Chinese.",
  "Return valid JSON only.",
  "Output shape: {\"translations\":[{\"segmentId\":\"...\",\"translatedText\":\"...\"}]}",
  "Rules:",
  "- Keep the same segment order and segment IDs as the input.",
  "- Do not merge or split segments.",
  "- Preserve model names, product names, brand names, URLs, file paths, commands, and code identifiers when appropriate.",
  "- Preserve numbers, currencies, units, and table values; translate only the human-readable labels.",
  "- For nav/table labels, keep translations concise.",
  "- For code comments, translate as comments; never output code.",
  "- Do not add commentary, notes, or extra keys."
].join("\n");

const DEFAULT_CONFIG = {
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

const PAGE_STATES = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const { [STORAGE_KEY]: savedConfig } = await chrome.storage.local.get(STORAGE_KEY);
  await chrome.storage.local.set({
    [STORAGE_KEY]: normalizeStoredConfig(savedConfig)
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopTask(tabId, false);
  PAGE_STATES.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    stopTask(tabId, false);
    PAGE_STATES.delete(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId ?? sender.tab?.id;

  (async () => {
    switch (message.type) {
      case "START_TRANSLATION":
        sendResponse(await startTranslation(tabId));
        break;
      case "STOP_TRANSLATION":
        sendResponse(await stopTask(tabId, true));
        break;
      case "GET_PAGE_STATUS":
        sendResponse(getStatusResponse(tabId));
        break;
      case "CLEAR_TRANSLATION":
        sendResponse(await clearTranslation(tabId));
        break;
      case "TOGGLE_TRANSLATION_VISIBILITY":
        sendResponse(await toggleTranslationVisibility(tabId));
        break;
      case "RETRY_TRANSLATION_SEGMENTS":
        sendResponse(await retryFailedSegments(tabId, message.segmentIds || [], message.segments || []));
        break;
      case "SET_TRANSLATION_COLOR_THEME":
        sendResponse(await setTranslationColorTheme(tabId, message.translationColorTheme));
        break;
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return true;
});

async function startTranslation(tabId) {
  ensureTabId(tabId);

  const existingState = PAGE_STATES.get(tabId);
  if (existingState?.running) {
    return { ok: true, state: serializeState(existingState) };
  }

  const config = await loadConfig();
  validateConfig(config);

  const extraction = await sendTabMessage(tabId, {
    type: "PREPARE_TRANSLATION",
    translationColorTheme: config.translationColorTheme
  });

  if (!extraction?.ok) {
    throw new Error(extraction?.error || "Failed to inspect page content.");
  }

  const state = createState(tabId, config, extraction);
  PAGE_STATES.set(tabId, state);
  broadcastStatus(state);

  if (state.totalSegments === 0) {
    state.running = false;
    state.stage = "completed";
    state.lastMessage = "No translatable English paragraphs were found on this page.";
    broadcastStatus(state);
    return { ok: true, state: serializeState(state) };
  }

  void runSegments(state, state.segments, false);

  return { ok: true, state: serializeState(state) };
}

async function retryFailedSegments(tabId, requestedSegmentIds, requestedSegments) {
  ensureTabId(tabId);

  const state = PAGE_STATES.get(tabId);
  const payloadSegments = normalizeSegmentPayload(requestedSegments);

  if (!state || state.running) {
    if (!payloadSegments.length) {
      if (!state) {
        throw new Error("There is no translation session for the current tab.");
      }
      return { ok: false, error: "Translation is already running for this page." };
    }

    const config = state?.config ?? (await loadConfig());
    validateConfig(config);
    await sendTabMessage(tabId, {
      type: "MARK_SEGMENTS_RETRYING",
      segmentIds: payloadSegments.map((segment) => segment.segmentId)
    });

    void runAdhocRetryTranslation(tabId, config, payloadSegments, state);
    return { ok: true, state: state ? serializeState(state) : null };
  }

  const failedIds = requestedSegmentIds.length
    ? requestedSegmentIds.filter((segmentId) => state.failedSegmentIds.has(segmentId))
    : Array.from(state.failedSegmentIds);

  if (!failedIds.length) {
    if (payloadSegments.length) {
      await sendTabMessage(tabId, {
        type: "MARK_SEGMENTS_RETRYING",
        segmentIds: payloadSegments.map((segment) => segment.segmentId)
      });
      void runAdhocRetryTranslation(tabId, state.config, payloadSegments, state);
      return { ok: true, state: serializeState(state) };
    }

    return { ok: false, error: "There are no failed segments to retry." };
  }

  state.running = true;
  state.stage = "retrying";
  state.lastMessage = `Retrying ${failedIds.length} segment(s)...`;
  state.abortController = new AbortController();
  broadcastStatus(state);

  const retrySegments = failedIds
    .map((segmentId) => state.segmentMap.get(segmentId))
    .filter(Boolean);

  await sendTabMessage(tabId, {
    type: "MARK_SEGMENTS_RETRYING",
    segmentIds: failedIds
  });

  void runSegments(state, retrySegments, true);

  return { ok: true, state: serializeState(state) };
}

async function runSegments(state, segments, isRetry) {
  const runController = state.abortController;
  if (!runController) {
    throw new Error("Translation controller is not available.");
  }

  const totalBatches = Math.ceil(segments.length / state.config.batchSize);

  try {
    const batches = chunkSegments(segments, state.config.batchSize);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      if (runController.signal.aborted) {
        throw new Error("Translation stopped.");
      }

      const batch = batches[batchIndex];
      const batchIds = batch.map((segment) => segment.segmentId);
      await sendTabMessage(state.tabId, {
        type: "TRANSLATION_BATCH_STARTED",
        segmentIds: batchIds,
        batchIndex,
        totalBatches,
        isRetry
      });

      try {
        const translations = await translateBatch(state, batch);
        const successfulIds = new Set();

        for (const item of translations) {
          if (state.segmentMap.has(item.segmentId)) {
            state.completedSegmentIds.add(item.segmentId);
            state.failedSegmentIds.delete(item.segmentId);
            successfulIds.add(item.segmentId);
          }
        }

        const missingIds = batchIds.filter((segmentId) => !successfulIds.has(segmentId));
        if (missingIds.length) {
          missingIds.forEach((segmentId) => state.failedSegmentIds.add(segmentId));
          await sendTabMessage(state.tabId, {
            type: "TRANSLATION_BATCH_ERROR",
            segmentIds: missingIds,
            error: "The model response did not include all segments from this batch."
          });
        }

        await sendTabMessage(state.tabId, {
          type: "TRANSLATION_BATCH_RESULT",
          translations,
          batchIndex,
          totalBatches,
          isRetry
        });
      } catch (error) {
        batchIds.forEach((segmentId) => state.failedSegmentIds.add(segmentId));
        await sendTabMessage(state.tabId, {
          type: "TRANSLATION_BATCH_ERROR",
          segmentIds: batchIds,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      state.completedCount = state.completedSegmentIds.size;
      state.failedCount = state.failedSegmentIds.size;
      state.stage = "running";
      state.lastMessage = `Completed ${state.completedCount}/${state.totalSegments} segment(s).`;
      broadcastStatus(state);
    }

    state.running = false;
    if (state.abortController === runController) {
      state.abortController = null;
    }
    state.completedCount = state.completedSegmentIds.size;
    state.failedCount = state.failedSegmentIds.size;

    if (state.failedCount > 0) {
      state.stage = "partial";
      state.lastMessage = `Finished with ${state.failedCount} failed segment(s).`;
    } else {
      state.stage = "completed";
      state.lastMessage = "Translation completed.";
    }

    broadcastStatus(state);
  } catch (error) {
    state.running = false;
    if (state.abortController === runController) {
      state.abortController = null;
    }

    if (error instanceof Error && error.message === "Translation stopped.") {
      state.stage = "stopped";
      state.lastMessage = "Translation stopped.";
    } else {
      state.stage = "error";
      state.lastMessage = error instanceof Error ? error.message : String(error);
      await sendTabMessage(state.tabId, {
        type: "TRANSLATION_SESSION_ERROR",
        error: state.lastMessage
      }).catch(() => {});
    }

    broadcastStatus(state);
  }
}

async function stopTask(tabId, notifyContent) {
  ensureTabId(tabId);

  const state = PAGE_STATES.get(tabId);
  if (!state) {
    return { ok: true, state: null };
  }

  if (state.abortController) {
    state.abortController.abort();
  }

  state.running = false;
  state.stage = "stopped";
  state.lastMessage = "Translation stopped.";
  broadcastStatus(state);

  if (notifyContent) {
    await sendTabMessage(tabId, { type: "TRANSLATION_STOPPED" }).catch(() => {});
  }

  return { ok: true, state: serializeState(state) };
}

async function clearTranslation(tabId) {
  ensureTabId(tabId);
  await stopTask(tabId, false).catch(() => {});
  PAGE_STATES.delete(tabId);
  await sendTabMessage(tabId, { type: "CLEAR_TRANSLATION" });
  return { ok: true, state: null };
}

async function toggleTranslationVisibility(tabId) {
  ensureTabId(tabId);
  const response = await sendTabMessage(tabId, { type: "TOGGLE_TRANSLATION_VISIBILITY" });

  const state = PAGE_STATES.get(tabId);
  if (state) {
    state.hidden = Boolean(response?.hidden);
    broadcastStatus(state);
  }

  return { ok: true, hidden: Boolean(response?.hidden), state: state ? serializeState(state) : null };
}

async function setTranslationColorTheme(tabId, translationColorTheme) {
  ensureTabId(tabId);

  if (!translationColorTheme?.trim()) {
    throw new Error("Translation color theme is required.");
  }

  const config = await loadConfig();
  const nextConfig = {
    ...config,
    translationColorTheme
  };

  await chrome.storage.local.set({
    [STORAGE_KEY]: nextConfig
  });

  const state = PAGE_STATES.get(tabId);
  if (state) {
    state.config.translationColorTheme = translationColorTheme;
    broadcastStatus(state);
  }

  await sendTabMessage(tabId, {
    type: "APPLY_TRANSLATION_THEME",
    translationColorTheme
  }).catch(() => {});

  return {
    ok: true,
    state: state ? serializeState(state) : null
  };
}

function getStatusResponse(tabId) {
  ensureTabId(tabId);
  const state = PAGE_STATES.get(tabId);
  return { ok: true, state: state ? serializeState(state) : null };
}

async function translateBatch(state, batch) {
  const endpoint = buildEndpoint(state.config.providerBaseUrl);
  const parentController = state.abortController;
  if (!parentController) {
    throw new Error("Translation controller is not available.");
  }

  const baseRequestBody = {
    model: state.config.model,
    temperature: 0,
    instructions: resolveSystemPrompt(state.config),
    input: buildUserPrompt(batch)
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), state.config.requestTimeoutMs);
  const bridgeAbort = () => controller.abort();
  parentController.signal.addEventListener("abort", bridgeAbort, { once: true });

  try {
    const attempts = buildTranslationAttempts(baseRequestBody, batch);
    let lastError = null;

    for (const attempt of attempts) {
      try {
        const rawContent = await requestProviderContent(endpoint, attempt, state.config.apiKey, controller.signal);
        const parsed = normalizeTranslations(rawContent);
        return parsed.filter((item) => item.segmentId && item.translatedText);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Translation failed.");
  } catch (error) {
    if (controller.signal.aborted || parentController.signal.aborted) {
      throw new Error("Translation stopped.");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    parentController.signal.removeEventListener("abort", bridgeAbort);
  }
}

function buildTranslationAttempts(baseRequestBody, batch) {
  return [withJsonSchemaFormat(baseRequestBody, batch), baseRequestBody];
}

function withJsonSchemaFormat(requestBody, batch) {
  const schema = buildTranslationJsonSchema(batch);
  return {
    ...requestBody,
    text: {
      format: {
        type: "json_schema",
        name: "translation_batch",
        description: "Batch translation results keyed by segmentId.",
        strict: true,
        schema
      },
      verbosity: "low"
    }
  };
}

function buildTranslationJsonSchema(batch) {
  const ids = batch.map((segment) => segment.segmentId).filter((id) => typeof id === "string");

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        minItems: ids.length,
        maxItems: ids.length,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            segmentId: {
              type: "string",
              enum: ids
            },
            translatedText: {
              type: "string"
            }
          },
          required: ["segmentId", "translatedText"]
        }
      }
    },
    required: ["translations"]
  };
}

function createState(tabId, config, extraction) {
  const segmentMap = new Map(extraction.segments.map((segment) => [segment.segmentId, segment]));
  return {
    tabId,
    running: true,
    stage: "running",
    hidden: false,
    config,
    segments: extraction.segments,
    segmentMap,
    abortController: new AbortController(),
    completedSegmentIds: new Set(),
    failedSegmentIds: new Set(),
    totalSegments: extraction.segments.length,
    completedCount: 0,
    failedCount: 0,
    lastMessage: "Translating page..."
  };
}

function serializeState(state) {
  return {
    tabId: state.tabId,
    running: state.running,
    stage: state.stage,
    hidden: state.hidden,
    totalSegments: state.totalSegments,
    completedCount: state.completedSegmentIds.size,
    failedCount: state.failedSegmentIds.size,
    lastMessage: state.lastMessage
  };
}

function chunkSegments(segments, batchSize) {
  const chunks = [];
  for (let index = 0; index < segments.length; index += batchSize) {
    chunks.push(segments.slice(index, index + batchSize));
  }
  return chunks;
}

function ensureTabId(tabId) {
  if (typeof tabId !== "number") {
    throw new Error("No active browser tab was found.");
  }
}

function buildEndpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

async function loadConfig() {
  const { [STORAGE_KEY]: savedConfig } = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeStoredConfig(savedConfig);
}

function validateConfig(config) {
  if (!config.providerBaseUrl?.trim()) {
    throw new Error("Provider base URL is required.");
  }
  if (!config.apiKey?.trim()) {
    throw new Error("API key is required.");
  }
  if (!config.model?.trim()) {
    throw new Error("Model is required.");
  }
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 5000) {
    throw new Error("Request timeout must be at least 5000 ms.");
  }
  if (!Number.isFinite(config.batchSize) || config.batchSize < 1 || config.batchSize > 20) {
    throw new Error("Batch size must be between 1 and 20.");
  }
}

function buildUserPrompt(batch) {
  return [
    "Translate each item into Simplified Chinese.",
    "Return valid JSON only.",
    "Use the item's context to keep the translation appropriate:",
    "- nav: concise UI label",
    "- table: concise header/cell label, keep numbers/currency/model names unchanged",
    "- content: natural reading flow",
    "- code-comment: translate comments only (no code)",
    "",
    JSON.stringify(
      {
        items: batch.map((segment) => ({
          segmentId: segment.segmentId,
          context: segment.context || "content",
          sourceText: segment.text
        }))
      },
      null,
      2
    )
  ].join("\n");
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error(`Could not communicate with page content: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requestProviderContent(endpoint, requestBody, apiKey, signal) {
  let streamingError = null;
  let streamingStatus = null;
  let streamingStatusText = "";

  try {
    const streamingResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        ...requestBody,
        stream: true
      }),
      signal
    });

    if (streamingResponse.ok) {
      const contentType = streamingResponse.headers.get("content-type") || "";
      try {
        return contentType.includes("text/event-stream")
          ? await readSseContent(streamingResponse)
          : await readJsonContent(streamingResponse);
      } catch (error) {
        streamingError = error;
      }
    } else {
      streamingStatus = streamingResponse.status;
      streamingStatusText = streamingResponse.statusText;

      if (!shouldFallbackToNonStreaming(streamingResponse.status)) {
        const errorText = await safeReadText(streamingResponse);
        throw new Error(
          `Provider request failed (${streamingResponse.status}): ${errorText || streamingResponse.statusText}`
        );
      }
    }
  } catch (error) {
    streamingError = error;
  }

  if (signal.aborted) {
    throw new Error("Translation stopped.");
  }

  const fallbackResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      ...requestBody,
      stream: false
    }),
    signal
  });

  if (!fallbackResponse.ok) {
    const errorText = await safeReadText(fallbackResponse);
    let suffix = "";
    if (streamingStatus !== null) {
      suffix = ` (streaming attempt status: ${streamingStatus} ${streamingStatusText || ""})`;
    } else if (streamingError) {
      suffix = ` (streaming attempt error: ${streamingError instanceof Error ? streamingError.message : String(streamingError)})`;
    }

    throw new Error(
      `Provider request failed (${fallbackResponse.status}): ${errorText || fallbackResponse.statusText}${suffix}`
    );
  }

  try {
    return await readJsonContent(fallbackResponse);
  } catch (error) {
    if (streamingError) {
      throw new Error(
        `Provider response parsing failed (non-streaming). Streaming attempt error: ${
          streamingError instanceof Error ? streamingError.message : String(streamingError)
        }. Non-streaming parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  }
}

function shouldFallbackToNonStreaming(status) {
  return status === 400 || status === 404 || status === 415 || status === 422;
}

async function readSseContent(response) {
  if (!response.body) {
    throw new Error("Provider returned an empty stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let doneText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const lines = event
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"));

      for (const line of lines) {
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        const parsed = JSON.parse(payload);
        const extracted = extractTextFromSseEvent(parsed);
        if (extracted.delta) {
          content += extracted.delta;
        }
        if (extracted.done) {
          doneText = extracted.done;
        }
      }
    }
  }

  if (buffer.trim()) {
    const lines = buffer
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"));

    for (const line of lines) {
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      const parsed = JSON.parse(payload);
      const extracted = extractTextFromSseEvent(parsed);
      if (extracted.delta) {
        content += extracted.delta;
      }
      if (extracted.done) {
        doneText = extracted.done;
      }
    }
  }

  const trimmedContent = content.trim();
  const trimmedDone = doneText.trim();
  if (trimmedDone && trimmedDone.length > trimmedContent.length) {
    return trimmedDone;
  }
  return trimmedContent;
}

async function readJsonContent(response) {
  const data = await response.json();
  const outputText = extractOutputText(data);
  if (!outputText) {
    throw new Error("Provider returned an empty response.");
  }
  return outputText.trim();
}

function normalizeContentPart(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text") {
          return item.text || "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

function extractTextFromSseEvent(event) {
  if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
    return { delta: event.delta, done: "" };
  }

  if (event?.type === "response.output_text.done" && typeof event.text === "string") {
    return { delta: "", done: event.text };
  }

  if (event?.type === "response.completed" && event.response) {
    return { delta: "", done: extractOutputText(event.response) || "" };
  }

  const chatDelta = event?.choices?.[0]?.delta?.content;
  const normalizedChatDelta = normalizeContentPart(chatDelta);
  if (normalizedChatDelta) {
    return { delta: normalizedChatDelta, done: "" };
  }

  if (typeof event?.delta === "string") {
    return { delta: event.delta, done: "" };
  }

  return { delta: "", done: "" };
}

function extractOutputText(payload) {
  if (!payload) {
    return "";
  }

  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (Array.isArray(payload.output)) {
    const parts = [];
    for (const item of payload.output) {
      const contentItems = Array.isArray(item?.content) ? item.content : [];
      for (const part of contentItems) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
    if (parts.length) {
      return parts.join("");
    }
  }

  const messageContent = payload.choices?.[0]?.message?.content;
  return normalizeContentPart(messageContent);
}

function normalizeTranslations(rawContent) {
  const jsonText = extractJsonText(rawContent);
  const parsed = JSON.parse(jsonText);

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.translations)) {
    return parsed.translations;
  }

  throw new Error("The provider response did not contain a translations array.");
}

function extractJsonText(rawContent) {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new Error("The provider returned an empty response.");
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch (_) {
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const start = objectStart === -1 ? arrayStart : arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart);
    const objectEnd = trimmed.lastIndexOf("}");
    const arrayEnd = trimmed.lastIndexOf("]");
    const end = Math.max(objectEnd, arrayEnd);

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Could not locate valid JSON in provider response.");
    }

    const candidate = trimmed.slice(start, end + 1);
    JSON.parse(candidate);
    return candidate;
  }
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (_) {
    return "";
  }
}

function broadcastStatus(state) {
  chrome.runtime.sendMessage({
    type: "PAGE_STATUS_CHANGED",
    state: serializeState(state)
  }).catch(() => {});
}

function normalizeSegmentPayload(segments) {
  if (!Array.isArray(segments)) {
    return [];
  }

  const cleaned = [];
  const seen = new Set();

  for (const segment of segments) {
    if (!segment?.segmentId || typeof segment.segmentId !== "string") {
      continue;
    }
    if (typeof segment.text !== "string") {
      continue;
    }

    const segmentId = segment.segmentId.trim();
    const text = segment.text.trim();
    if (!segmentId || !text) {
      continue;
    }

    if (seen.has(segmentId)) {
      continue;
    }
    seen.add(segmentId);

    const context = typeof segment.context === "string" ? segment.context.trim() : "";
    cleaned.push({ segmentId, text, context });
  }

  return cleaned;
}

async function runAdhocRetryTranslation(tabId, config, segments, stateToUpdate) {
  const tempState = {
    tabId,
    config,
    abortController: new AbortController(),
    segmentMap: new Map(segments.map((segment) => [segment.segmentId, segment])),
    completedSegmentIds: new Set(),
    failedSegmentIds: new Set()
  };

  try {
    const translations = await translateBatch(tempState, segments);
    const successfulIds = new Set();

    for (const item of translations) {
      if (typeof item.segmentId === "string" && item.translatedText) {
        successfulIds.add(item.segmentId);
      }
    }

    if (stateToUpdate) {
      for (const segment of segments) {
        if (successfulIds.has(segment.segmentId)) {
          stateToUpdate.completedSegmentIds.add(segment.segmentId);
          stateToUpdate.failedSegmentIds.delete(segment.segmentId);
        } else {
          stateToUpdate.failedSegmentIds.add(segment.segmentId);
        }
      }
      stateToUpdate.completedCount = stateToUpdate.completedSegmentIds.size;
      stateToUpdate.failedCount = stateToUpdate.failedSegmentIds.size;
      broadcastStatus(stateToUpdate);
    }

    const missingIds = segments.map((segment) => segment.segmentId).filter((segmentId) => !successfulIds.has(segmentId));
    if (missingIds.length) {
      await sendTabMessage(tabId, {
        type: "TRANSLATION_BATCH_ERROR",
        segmentIds: missingIds,
        error: "The model response did not include all segments from this retry."
      });
    }

    await sendTabMessage(tabId, {
      type: "TRANSLATION_BATCH_RESULT",
      translations,
      batchIndex: 0,
      totalBatches: 1,
      isRetry: true
    });
  } catch (error) {
    const segmentIds = segments.map((segment) => segment.segmentId);

    if (stateToUpdate) {
      segmentIds.forEach((segmentId) => stateToUpdate.failedSegmentIds.add(segmentId));
      stateToUpdate.completedCount = stateToUpdate.completedSegmentIds.size;
      stateToUpdate.failedCount = stateToUpdate.failedSegmentIds.size;
      broadcastStatus(stateToUpdate);
    }

    await sendTabMessage(tabId, {
      type: "TRANSLATION_BATCH_ERROR",
      segmentIds,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => {});
  }
}

function normalizeStoredConfig(savedConfig) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...savedConfig,
    requestTimeoutMs: Number(savedConfig?.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs),
    batchSize: Number(savedConfig?.batchSize || DEFAULT_CONFIG.batchSize)
  };

  const promptPresets = [];
  const existingPrompts = Array.isArray(savedConfig?.promptPresets) ? savedConfig.promptPresets : [];
  const hasBuiltInPrompt = existingPrompts.some((prompt) => prompt?.id === BUILTIN_PROMPT_ID);

  promptPresets.push({
    id: BUILTIN_PROMPT_ID,
    label: BUILTIN_PROMPT_LABEL,
    content: BUILTIN_SYSTEM_PROMPT,
    builtIn: true
  });

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

  if (!hasBuiltInPrompt && typeof savedConfig?.systemPrompt === "string" && savedConfig.systemPrompt.trim()) {
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
    : promptPresets[promptPresets.length - 1]?.id || BUILTIN_PROMPT_ID;

  return {
    providerBaseUrl: merged.providerBaseUrl,
    apiKey: merged.apiKey,
    model: merged.model,
    requestTimeoutMs: merged.requestTimeoutMs,
    batchSize: merged.batchSize,
    translationColorTheme: merged.translationColorTheme || DEFAULT_CONFIG.translationColorTheme,
    promptPresets,
    activePromptId
  };
}

function resolveSystemPrompt(config) {
  const activePrompt = config.promptPresets?.find((prompt) => prompt.id === config.activePromptId);
  return activePrompt?.content || BUILTIN_SYSTEM_PROMPT;
}

function derivePromptLabel(content) {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > 18 ? `${collapsed.slice(0, 18)}...` : collapsed || "未命名提示词";
}
