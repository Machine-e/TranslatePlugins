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

const AUTO_RETRY_BATCH_ATTEMPTS = 1;
const AUTO_RETRY_SEGMENT_ATTEMPTS = 1;
const AUTO_RETRY_BASE_DELAY_MS = 900;
const SERVICE_WORKER_KEEPALIVE_INTERVAL_MS = 25 * 1000;

const PAGE_STATES = new Map();
let serviceWorkerKeepAliveRefs = 0;
let serviceWorkerKeepAliveTimer = null;

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

  const batches = chunkSegments(segments, state.config.batchSize);
  const totalBatches = batches.length;
  await startServiceWorkerKeepAlive();

  try {
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
        const batchResult = await translateBatchWithAutoRetry(state, batch);
        const translations = batchResult.translations;
        const successfulIds = new Set();

        for (const item of translations) {
          if (state.segmentMap.has(item.segmentId)) {
            state.completedSegmentIds.add(item.segmentId);
            state.failedSegmentIds.delete(item.segmentId);
            successfulIds.add(item.segmentId);
          }
        }

        const failedIds = Array.isArray(batchResult.failedIds) && batchResult.failedIds.length
          ? batchResult.failedIds
          : batchIds.filter((segmentId) => !successfulIds.has(segmentId));

        if (failedIds.length) {
          failedIds.forEach((segmentId) => state.failedSegmentIds.add(segmentId));
          await sendTabMessage(state.tabId, {
            type: "TRANSLATION_BATCH_ERROR",
            segmentIds: failedIds,
            error: batchResult.error || "Translation failed after automatic retry."
          });
        }

        if (translations.length) {
          await sendTabMessage(state.tabId, {
            type: "TRANSLATION_BATCH_RESULT",
            translations,
            batchIndex,
            totalBatches,
            isRetry
          });
        }
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
  } finally {
    stopServiceWorkerKeepAlive();
  }
}

async function translateBatchWithAutoRetry(state, batch) {
  let lastError = null;
  const totalBatchAttempts = 1 + AUTO_RETRY_BATCH_ATTEMPTS;

  for (let attemptIndex = 0; attemptIndex < totalBatchAttempts; attemptIndex += 1) {
    try {
      const translations = await translateBatch(state, batch);
      const missingSegments = getMissingSegments(batch, translations);

      if (!missingSegments.length) {
        return {
          translations,
          failedIds: [],
          error: ""
        };
      }

      const recovered = await translateSegmentsIndividuallyWithRetry(state, missingSegments);
      return {
        translations: mergeTranslations(translations, recovered.translations),
        failedIds: recovered.failedIds,
        error: recovered.failedIds.length
          ? recovered.error || "Some segments still failed after automatic retry."
          : ""
      };
    } catch (error) {
      lastError = error;

      if (attemptIndex < totalBatchAttempts - 1) {
        await waitForAutoRetryDelay(state.abortController?.signal, getAutoRetryDelayMs(attemptIndex));
      }
    }
  }

  if (batch.length > 1) {
    const recovered = await translateSegmentsIndividuallyWithRetry(state, batch);
    if (recovered.translations.length || recovered.failedIds.length) {
      return {
        translations: recovered.translations,
        failedIds: recovered.failedIds,
        error: recovered.error || toErrorMessage(lastError) || "Translation failed after automatic retry."
      };
    }
  }

  return {
    translations: [],
    failedIds: batch.map((segment) => segment.segmentId),
    error: toErrorMessage(lastError) || "Translation failed after automatic retry."
  };
}

async function translateSegmentsIndividuallyWithRetry(state, segments) {
  const translations = [];
  const failedIds = [];
  const errors = [];
  const totalSegmentAttempts = 1 + AUTO_RETRY_SEGMENT_ATTEMPTS;

  for (const segment of segments) {
    let succeeded = false;
    let lastError = null;

    for (let attemptIndex = 0; attemptIndex < totalSegmentAttempts; attemptIndex += 1) {
      try {
        const result = await translateBatch(state, [segment]);
        const translatedItem = result.find((item) => item.segmentId === segment.segmentId && item.translatedText);
        if (!translatedItem) {
          throw new Error("The model response did not include this segment.");
        }

        translations.push(translatedItem);
        succeeded = true;
        break;
      } catch (error) {
        lastError = error;

        if (attemptIndex < totalSegmentAttempts - 1) {
          await waitForAutoRetryDelay(state.abortController?.signal, getAutoRetryDelayMs(attemptIndex));
        }
      }
    }

    if (!succeeded) {
      failedIds.push(segment.segmentId);
      errors.push(toErrorMessage(lastError));
    }
  }

  return {
    translations,
    failedIds,
    error: buildAutomaticRetryFailureMessage(errors)
  };
}

function getMissingSegments(batch, translations) {
  const translatedIds = new Set(translations.map((item) => item.segmentId));
  return batch.filter((segment) => !translatedIds.has(segment.segmentId));
}

function mergeTranslations(primary, secondary) {
  const merged = [];
  const seen = new Set();

  for (const item of [...primary, ...secondary]) {
    if (!item?.segmentId || seen.has(item.segmentId)) {
      continue;
    }

    seen.add(item.segmentId);
    merged.push(item);
  }

  return merged;
}

function getAutoRetryDelayMs(attemptIndex) {
  return AUTO_RETRY_BASE_DELAY_MS * (attemptIndex + 1);
}

async function waitForAutoRetryDelay(signal, delayMs) {
  if (!delayMs || delayMs <= 0) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    function handleAbort() {
      clearTimeout(timer);
      reject(new Error("Translation stopped."));
    }

    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error("Translation stopped."));
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function buildAutomaticRetryFailureMessage(errors) {
  const firstMeaningful = errors.find((message) => typeof message === "string" && message.trim());
  return firstMeaningful || "Translation failed after automatic retry.";
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "");
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), state.config.requestTimeoutMs);
  const bridgeAbort = () => controller.abort();
  parentController.signal.addEventListener("abort", bridgeAbort, { once: true });

  try {
    let lastError = null;
    const qualityNotes = [];

    for (let qualityPass = 0; qualityPass < 2; qualityPass += 1) {
      const requestProfiles = buildRequestProfiles(state, batch, {
        isRetryPass: qualityPass > 0,
        validationNote: qualityPass > 0 ? qualityNotes[qualityNotes.length - 1] || "" : ""
      });

      for (const profile of requestProfiles) {
        const attempts = buildTranslationAttempts(profile.requestBody, batch, profile.allowJsonSchema);

        for (const attempt of attempts) {
          try {
            const rawContent = await requestProviderContent(endpoint, attempt, state.config.apiKey, controller.signal);
            const parsed = normalizeTranslations(rawContent, batch);
            validateTranslations(batch, parsed);
            updateTermMemory(state, batch, parsed);
            return parsed;
          } catch (error) {
            lastError = error;
            if (!isCompatibilityFallbackCandidate(error)) {
              continue;
            }
          }
        }
      }

      if (lastError) {
        qualityNotes.push(lastError instanceof Error ? lastError.message : String(lastError));
      }
    }

    if (isSingleContextBatch(batch, "nav") && batch.length > 1 && isCompatibilityFallbackCandidate(lastError)) {
      return await translateItemsIndividually(state, batch);
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

async function translateItemsIndividually(state, batch) {
  const results = [];

  for (const segment of batch) {
    const translated = await translateBatch(state, [segment]);
    results.push(...translated);
  }

  return results;
}

function buildRequestProfiles(state, batch, options = {}) {
  const sharedRequest = {
    model: state.config.model,
    temperature: 0,
    instructions: resolveSystemPrompt(state.config)
  };

  if (isSingleContextBatch(batch, "nav")) {
    return [
      {
        mode: "nav-compact",
        allowJsonSchema: false,
        requestBody: {
          ...sharedRequest,
          input: buildNavUserPrompt(batch)
        }
      },
      {
        mode: "compatibility",
        allowJsonSchema: false,
        requestBody: {
          ...sharedRequest,
          input: buildCompatibilityUserPrompt(batch)
        }
      }
    ];
  }

  return [
    {
      mode: "enhanced",
      allowJsonSchema: true,
      requestBody: {
        ...sharedRequest,
        input: buildUserPrompt(state, batch, options)
      }
    },
    {
      mode: "compatibility",
      allowJsonSchema: false,
      requestBody: {
        ...sharedRequest,
        input: buildCompatibilityUserPrompt(batch)
      }
    }
  ];
}

function isSingleContextBatch(batch, context) {
  return Array.isArray(batch) && batch.length > 0 && batch.every((segment) => (segment.context || "content") === context);
}

function buildTranslationAttempts(baseRequestBody, batch, allowJsonSchema = true) {
  return allowJsonSchema ? [baseRequestBody, withJsonSchemaFormat(baseRequestBody, batch)] : [baseRequestBody];
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
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            segmentId: {
              type: "string"
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
    termMemory: new Map(),
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
  const ordered = [...segments].sort(sortSegmentsForBatching);
  const chunks = [];

  const plans = [
    createBatchPlan("content", batchSize, 2800, (segment) => buildContentBatchKey(segment)),
    createBatchPlan("table", Math.min(batchSize, 6), 1800, (segment) => buildTableBatchKey(segment)),
    createBatchPlan("code-comment", Math.min(batchSize, 4), 1400, (segment) => buildCodeBatchKey(segment)),
    createBatchPlan("nav", Math.min(batchSize, 4), 260, (segment) => buildNavBatchKey(segment))
  ];

  for (const plan of plans) {
    const scopedSegments = ordered.filter((segment) => (segment.context || "content") === plan.context);
    chunks.push(...chunkScopedSegments(scopedSegments, plan));
  }

  return chunks;
}

function createBatchPlan(context, countLimit, charLimit, keyBuilder) {
  return {
    context,
    countLimit: Math.max(1, countLimit),
    charLimit: Math.max(300, charLimit),
    keyBuilder
  };
}

function chunkScopedSegments(segments, plan) {
  const chunks = [];
  let current = [];
  let currentKey = "";
  let currentChars = 0;

  for (const segment of segments) {
    const nextKey = plan.keyBuilder(segment);
    const nextChars = estimateSegmentPayloadSize(segment);
    const shouldFlush =
      current.length > 0 &&
      (nextKey !== currentKey || current.length >= plan.countLimit || currentChars + nextChars > plan.charLimit);

    if (shouldFlush) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(segment);
    currentKey = nextKey;
    currentChars += nextChars;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function sortSegmentsForBatching(left, right) {
  const positionDelta = numericValue(left.positionIndex) - numericValue(right.positionIndex);
  if (positionDelta !== 0) {
    return positionDelta;
  }

  return String(left.segmentId || "").localeCompare(String(right.segmentId || ""));
}

function numericValue(value) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function estimateSegmentPayloadSize(segment) {
  return [
    segment.text,
    segment.pageTitle,
    segment.mainHeading,
    segment.sectionHeading,
    segment.tableCaption,
    segment.columnHeader,
    segment.rowHeader,
    segment.navGroupHeading
  ]
    .filter(Boolean)
    .join(" ")
    .length;
}

function buildContentBatchKey(segment) {
  return [
    "content",
    segment.sectionHeading || "",
    segment.mainHeading || "",
    segment.pageTitle || ""
  ].join("|");
}

function buildTableBatchKey(segment) {
  return [
    "table",
    segment.tableId || "",
    segment.tableCaption || "",
    segment.sectionHeading || ""
  ].join("|");
}

function buildCodeBatchKey(segment) {
  return ["code-comment", segment.sectionHeading || "", segment.mainHeading || ""].join("|");
}

function buildNavBatchKey(segment) {
  return [
    "nav",
    segment.navGroupHeading || "",
    segment.sectionHeading || "",
    segment.mainHeading || ""
  ].join("|");
}

function ensureTabId(tabId) {
  if (typeof tabId !== "number") {
    throw new Error("No active browser tab was found.");
  }
}

function buildEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/responses$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/responses`;
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

function buildUserPrompt(state, batch, options = {}) {
  const batchSummary = summarizeBatch(batch);
  const termMemory = getRelevantTermMemory(state, batch);
  const validationNote = options.validationNote ? String(options.validationNote).trim() : "";
  const items = batch.map((segment) => buildPromptItem(segment, batchSummary));

  return [
    "Translate each item into Simplified Chinese and return JSON only.",
    options.isRetryPass
      ? "This is a retry pass. Fix the previous output instead of repeating the same mistakes."
      : "Keep the output stable, precise, and terminology-consistent.",
    "Batch summary:",
    JSON.stringify(batchSummary, null, 2),
    "",
    "Context handling rules:",
    "- content: accurate technical prose, controlled tone, do not over-interpret.",
    "- table: keep labels concise and preserve all numbers, currencies, percentages, units, and model/version strings exactly.",
    "- nav: short UI/documentation labels, no unnecessary expansion.",
    "- code-comment: translate comments only; keep them comment-like and do not generate code.",
    "- If a source segment is already Chinese or mostly non-translatable identifiers, keep it minimal and preserve the original technical tokens.",
    "",
    termMemory.length
      ? `Preferred terminology memory:\n${JSON.stringify(termMemory, null, 2)}`
      : "Preferred terminology memory:\n[]",
    "",
    validationNote ? `Previous output issue to fix:\n${validationNote}\n` : "",
    JSON.stringify({ items }, null, 2)
  ].join("\n");
}

function buildCompatibilityUserPrompt(batch) {
  return [
    "Translate each item into Simplified Chinese.",
    "Return valid JSON only.",
    "Output shape: {\"translations\":[{\"segmentId\":\"...\",\"translatedText\":\"...\"}]}",
    "Rules:",
    "- Keep the same segment order and segment IDs as the input.",
    "- Do not merge or split segments.",
    "- Preserve model names, URLs, file paths, commands, code identifiers, numbers, currencies, units, and table values when appropriate.",
    "- nav: concise UI label",
    "- table: concise header/cell label",
    "- content: natural and accurate technical prose",
    "- code-comment: translate comments only, no code",
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

function buildNavUserPrompt(batch) {
  return [
    "Translate each navigation label into concise Simplified Chinese.",
    "Return valid JSON only.",
    "Output shape: {\"translations\":[{\"segmentId\":\"...\",\"translatedText\":\"...\"}]}",
    "Rules:",
    "- Keep each label short and natural.",
    "- Do not add explanations or bilingual expansions.",
    "- Preserve product names, API, SSL, HAR, URLs, and similar technical acronyms when appropriate.",
    "- Use navGroupHeading only as disambiguation context, not as extra output.",
    "",
    JSON.stringify(
      {
        items: batch.map((segment) => ({
          segmentId: segment.segmentId,
          navGroupHeading: segment.navGroupHeading || "",
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

  let fallbackResponse;
  let fallbackFetchError = null;

  try {
    fallbackResponse = await fetch(endpoint, {
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
  } catch (error) {
    fallbackFetchError = error;
  }

  if (!fallbackResponse) {
    const reason = fallbackFetchError instanceof Error ? fallbackFetchError.message : String(fallbackFetchError || "");
    throw new Error(
      `Failed to fetch provider endpoint. Check Base URL / CORS / provider availability. ${reason}`.trim()
    );
  }

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

function summarizeBatch(batch) {
  const first = batch[0] || {};
  const contexts = Array.from(new Set(batch.map((segment) => segment.context || "content")));
  const sectionHeadings = Array.from(
    new Set(batch.map((segment) => segment.sectionHeading || "").filter(Boolean))
  ).slice(0, 4);

  return {
    batchType: contexts.length === 1 ? contexts[0] : "mixed",
    itemCount: batch.length,
    pageTitle: first.pageTitle || "",
    mainHeading: first.mainHeading || "",
    sectionHeadings,
    tableCaption:
      first.context === "table" ? Array.from(new Set(batch.map((segment) => segment.tableCaption || "").filter(Boolean))).join(" | ") : "",
    navGroupHeading:
      first.context === "nav" ? Array.from(new Set(batch.map((segment) => segment.navGroupHeading || "").filter(Boolean))).join(" | ") : ""
  };
}

function buildPromptItem(segment, batchSummary) {
  const item = {
    segmentId: segment.segmentId,
    context: segment.context || "content",
    sourceText: segment.text
  };

  if (segment.sectionHeading && segment.sectionHeading !== batchSummary.sectionHeadings?.[0]) {
    item.sectionHeading = segment.sectionHeading;
  }

  if (segment.context === "table") {
    if (segment.columnHeader) {
      item.columnHeader = segment.columnHeader;
    }
    if (segment.rowHeader) {
      item.rowHeader = segment.rowHeader;
    }
  }

  if (segment.context === "nav" && segment.navGroupHeading && segment.navGroupHeading !== batchSummary.navGroupHeading) {
    item.navGroupHeading = segment.navGroupHeading;
  }

  if (segment.context === "code-comment" && segment.sectionHeading) {
    item.locationHint = segment.sectionHeading;
  }

  return item;
}

function getRelevantTermMemory(state, batch) {
  if (isSingleContextBatch(batch, "nav")) {
    return [];
  }

  const sectionKeywords = new Set();
  for (const segment of batch) {
    for (const value of [segment.pageTitle, segment.mainHeading, segment.sectionHeading, segment.tableCaption]) {
      const normalized = normalizeComparableText(value);
      if (normalized) {
        sectionKeywords.add(normalized);
      }
    }
  }

  const scored = [];
  for (const [sourceTerm, translatedTerm] of state.termMemory.entries()) {
    const normalizedSource = normalizeComparableText(sourceTerm);
    const score = Array.from(sectionKeywords).some((keyword) => keyword.includes(normalizedSource) || normalizedSource.includes(keyword))
      ? 2
      : batch.some((segment) => normalizeComparableText(segment.text).includes(normalizedSource))
        ? 1
        : 0;

    if (score > 0) {
      scored.push({ sourceTerm, translatedTerm, score });
    }
  }

  scored.sort((left, right) => right.score - left.score || left.sourceTerm.localeCompare(right.sourceTerm));
  return scored.slice(0, 8).map(({ sourceTerm, translatedTerm }) => ({ sourceTerm, translatedTerm }));
}

function updateTermMemory(state, batch, translations) {
  if (!(state.termMemory instanceof Map)) {
    return;
  }

  const translationMap = new Map(translations.map((item) => [item.segmentId, item.translatedText]));
  for (const segment of batch) {
    const translatedText = translationMap.get(segment.segmentId);
    if (!translatedText) {
      continue;
    }

    for (const pair of extractTermPairs(segment.text, translatedText)) {
      if (!state.termMemory.has(pair.sourceTerm)) {
        state.termMemory.set(pair.sourceTerm, pair.translatedTerm);
      }
    }
  }

  while (state.termMemory.size > 40) {
    const oldestKey = state.termMemory.keys().next().value;
    if (!oldestKey) {
      break;
    }
    state.termMemory.delete(oldestKey);
  }
}

function extractTermPairs(sourceText, translatedText) {
  const pairs = [];
  const seen = new Set();
  const patterns = [
    /([\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9+/_.:# -]{1,30})[（(]([A-Za-z][A-Za-z0-9+/_.:# -]{1,60})[）)]/g,
    /([A-Za-z][A-Za-z0-9+/_.:# -]{1,60})\s*[（(]([\u4e00-\u9fff][^()（）]{1,24})[）)]/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(translatedText)) !== null) {
      const left = match[1]?.trim() || "";
      const right = match[2]?.trim() || "";
      const sourceTerm = /[A-Za-z]/.test(left) ? left : right;
      const translatedTerm = /[\u4e00-\u9fff]/.test(left) ? left : right;
      if (!isUsefulTermMemoryPair(sourceText, sourceTerm, translatedTerm)) {
        continue;
      }

      const signature = `${sourceTerm}=>${translatedTerm}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      pairs.push({ sourceTerm, translatedTerm });
    }
  }

  return pairs;
}

function isUsefulTermMemoryPair(sourceText, sourceTerm, translatedTerm) {
  if (!sourceTerm || !translatedTerm) {
    return false;
  }

  if (!sourceText.includes(sourceTerm)) {
    return false;
  }

  if (sourceTerm.length < 2 || translatedTerm.length < 2) {
    return false;
  }

  if (looksLikeProtectedToken(sourceTerm) || looksLikeNumericBundle(sourceTerm)) {
    return false;
  }

  return true;
}

function normalizeTranslations(rawContent, batch) {
  const jsonText = extractJsonText(rawContent);
  const parsed = JSON.parse(jsonText);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.translations) ? parsed.translations : null;

  if (!Array.isArray(list)) {
    throw new Error("The provider response did not contain a translations array.");
  }

  const expectedIds = new Set(batch.map((segment) => segment.segmentId));
  const normalized = [];
  const seenIds = new Set();

  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const segmentId = typeof item.segmentId === "string" ? item.segmentId.trim() : "";
    const translatedText = typeof item.translatedText === "string" ? item.translatedText.trim() : "";
    if (!segmentId || !expectedIds.has(segmentId) || seenIds.has(segmentId)) {
      continue;
    }

    normalized.push({ segmentId, translatedText });
    seenIds.add(segmentId);
  }

  return normalized;
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

function validateTranslations(batch, translations) {
  const translationMap = new Map(translations.map((item) => [item.segmentId, item.translatedText]));
  const issues = [];

  for (const segment of batch) {
    const translatedText = translationMap.get(segment.segmentId);
    if (!translatedText) {
      issues.push(`Missing translatedText for ${segment.segmentId}.`);
      continue;
    }

    if (looksLikeStructuredLeak(translatedText)) {
      issues.push(`Structured output leaked into ${segment.segmentId}.`);
    }

    if (isSuspiciousCopy(segment, translatedText)) {
      issues.push(`Suspicious source copy for ${segment.segmentId}.`);
    }

    if (segment.context === "table" && !hasMatchingNumericTokens(segment.text, translatedText)) {
      issues.push(`Numeric mismatch for table segment ${segment.segmentId}.`);
    }

    if (looksMergedAcrossSegments(segment, translatedText, batch)) {
      issues.push(`Merged or over-expanded output for ${segment.segmentId}.`);
    }
  }

  if (issues.length) {
    throw new Error(issues.slice(0, 4).join(" "));
  }
}

function looksLikeStructuredLeak(text) {
  const trimmed = String(text || "").trim();
  return /^(\{|\[)/.test(trimmed) || /"segmentId"\s*:|"translations"\s*:/.test(trimmed);
}

function isSuspiciousCopy(segment, translatedText) {
  const sourceText = String(segment.text || "").trim();
  const targetText = String(translatedText || "").trim();
  if (!sourceText || !targetText) {
    return false;
  }

  if (normalizeComparableText(sourceText) !== normalizeComparableText(targetText)) {
    return false;
  }

  if (!isEnglishHeavySource(sourceText)) {
    return false;
  }

  if (looksLikeProtectedToken(sourceText) || sourceText.length < 12) {
    return false;
  }

  const wordCount = sourceText.split(/\s+/).filter(Boolean).length;
  return wordCount >= 3 || sourceText.length >= 18;
}

function hasMatchingNumericTokens(sourceText, translatedText) {
  const sourceTokens = extractNumericTokens(sourceText);
  if (!sourceTokens.length) {
    return true;
  }

  const translatedTokens = new Set(extractNumericTokens(translatedText));
  return sourceTokens.every((token) => translatedTokens.has(token));
}

function extractNumericTokens(text) {
  return Array.from(
    new Set(
      String(text || "")
        .match(/[$€¥£]?\d[\d,]*(?:\.\d+)?%?/g) || []
    )
  ).map((token) => token.replace(/,/g, ""));
}

function looksMergedAcrossSegments(segment, translatedText, batch) {
  const cleaned = String(translatedText || "").trim();
  if (!cleaned) {
    return false;
  }

  const ownSource = normalizeComparableText(segment.text);
  const otherSourceMatches = batch
    .filter((candidate) => candidate.segmentId !== segment.segmentId)
    .map((candidate) => candidate.text)
    .filter(Boolean)
    .filter((candidateText) => normalizeComparableText(cleaned).includes(normalizeComparableText(candidateText)))
    .length;

  if (otherSourceMatches >= 1 && cleaned.length > Math.max(segment.text.length * 1.8, 80)) {
    return true;
  }

  if (cleaned.length > Math.max(segment.text.length * 3.2, 220) && !cleaned.includes("（")) {
    return true;
  }

  return ownSource && normalizeComparableText(cleaned).includes(ownSource.repeat(2));
}

function isEnglishHeavySource(text) {
  const latinMatches = String(text || "").match(/[A-Za-z]/g) || [];
  const chineseMatches = String(text || "").match(/[\u3400-\u9fff]/g) || [];
  return latinMatches.length >= 8 && latinMatches.length >= chineseMatches.length * 2;
}

function looksLikeProtectedToken(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return false;
  }

  if (/^(https?:\/\/|www\.)/i.test(trimmed)) {
    return true;
  }

  if (/[./:_-]/.test(trimmed) || /\d/.test(trimmed)) {
    return /^[A-Za-z0-9_./:-]+$/.test(trimmed) && !/\s/.test(trimmed);
  }

  if (/^[A-Z][A-Z0-9+_-]{1,20}$/.test(trimmed)) {
    return true;
  }

  return false;
}

function looksLikeNumericBundle(text) {
  return /^[\d\s.,:%$€¥£/-]+$/.test(String(text || "").trim());
}

function normalizeComparableText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")")
    .trim()
    .toLowerCase();
}

function isCompatibilityFallbackCandidate(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /failed to fetch|networkerror|load failed|fetch failed/i.test(message);
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
    cleaned.push({
      segmentId,
      text,
      context,
      positionIndex: Number.isFinite(segment.positionIndex) ? segment.positionIndex : Number.MAX_SAFE_INTEGER,
      pageTitle: typeof segment.pageTitle === "string" ? segment.pageTitle.trim() : "",
      mainHeading: typeof segment.mainHeading === "string" ? segment.mainHeading.trim() : "",
      sectionHeading: typeof segment.sectionHeading === "string" ? segment.sectionHeading.trim() : "",
      tableId: typeof segment.tableId === "string" ? segment.tableId.trim() : "",
      tableCaption: typeof segment.tableCaption === "string" ? segment.tableCaption.trim() : "",
      columnHeader: typeof segment.columnHeader === "string" ? segment.columnHeader.trim() : "",
      rowHeader: typeof segment.rowHeader === "string" ? segment.rowHeader.trim() : "",
      navGroupHeading: typeof segment.navGroupHeading === "string" ? segment.navGroupHeading.trim() : ""
    });
  }

  return cleaned;
}

async function runAdhocRetryTranslation(tabId, config, segments, stateToUpdate) {
  const tempState = {
    tabId,
    config,
    abortController: new AbortController(),
    termMemory: stateToUpdate?.termMemory instanceof Map ? stateToUpdate.termMemory : new Map(),
    segmentMap: new Map(segments.map((segment) => [segment.segmentId, segment])),
    completedSegmentIds: new Set(),
    failedSegmentIds: new Set()
  };

  await startServiceWorkerKeepAlive();

  try {
    const batchResult = await translateBatchWithAutoRetry(tempState, segments);
    const translations = batchResult.translations;
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

    const failedIds = Array.isArray(batchResult.failedIds) && batchResult.failedIds.length
      ? batchResult.failedIds
      : segments.map((segment) => segment.segmentId).filter((segmentId) => !successfulIds.has(segmentId));

    if (failedIds.length) {
      await sendTabMessage(tabId, {
        type: "TRANSLATION_BATCH_ERROR",
        segmentIds: failedIds,
        error: batchResult.error || "Translation failed after automatic retry."
      });
    }

    if (translations.length) {
      await sendTabMessage(tabId, {
        type: "TRANSLATION_BATCH_RESULT",
        translations,
        batchIndex: 0,
        totalBatches: 1,
        isRetry: true
      });
    }
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
  } finally {
    stopServiceWorkerKeepAlive();
  }
}

// Chrome MV3 service workers can be suspended on inactivity. While translation
// is running, ping a trivial extension API so long jobs continue in background.
async function startServiceWorkerKeepAlive() {
  serviceWorkerKeepAliveRefs += 1;
  if (serviceWorkerKeepAliveRefs > 1) {
    return;
  }

  await pingServiceWorkerKeepAlive();
  serviceWorkerKeepAliveTimer = setInterval(() => {
    void pingServiceWorkerKeepAlive();
  }, SERVICE_WORKER_KEEPALIVE_INTERVAL_MS);
}

function stopServiceWorkerKeepAlive() {
  serviceWorkerKeepAliveRefs = Math.max(0, serviceWorkerKeepAliveRefs - 1);
  if (serviceWorkerKeepAliveRefs > 0) {
    return;
  }

  if (serviceWorkerKeepAliveTimer !== null) {
    clearInterval(serviceWorkerKeepAliveTimer);
    serviceWorkerKeepAliveTimer = null;
  }
}

async function pingServiceWorkerKeepAlive() {
  try {
    await chrome.runtime.getPlatformInfo();
  } catch (_) {
    // Ignore keepalive ping failures and let the main translation path surface errors.
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
