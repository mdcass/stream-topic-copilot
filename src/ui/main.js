import "bootstrap/dist/css/bootstrap.min.css";
import "highlight.js/styles/atom-one-light.css";

import "bootstrap";
import hljs from "highlight.js/lib/core";
import markdown from "highlight.js/lib/languages/markdown";

hljs.registerLanguage("markdown", markdown);

const state = {
  pollingHandle: null,
  pollingIntervalMs: 2000,
  data: null,
  configDraft: null,
  configDirty: false,
  expandedTopics: new Set(),
  currentError: null,
  transcriptRender: {
    keys: new Set(),
    textByKey: new Map()
  }
};

const topicStates = ["pending", "partial", "covered", "snoozed", "dismissed"];

const byId = (id) => document.getElementById(id);

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function showError(message) {
  state.currentError = message;
  const pill = byId("error-pill");
  pill.textContent = message;
  pill.title = message;
  pill.classList.remove("d-none");
}

function clearError() {
  state.currentError = null;
  const pill = byId("error-pill");
  pill.classList.add("d-none");
  pill.textContent = "";
  pill.title = "";
}

function collectConfigFormValues() {
  return {
    markdownFilePath: byId("markdown-path").value,
    microphoneId: byId("microphone-id").value || null,
    sttProvider: byId("stt-provider").value,
    analysisProvider: byId("analysis-provider").value,
    chunkSensitivity: byId("chunk-sensitivity").value,
    analysisAutoApplyThreshold: Number(byId("analysis-threshold").value)
  };
}

function markConfigDirty() {
  state.configDraft = collectConfigFormValues();
  state.configDirty = true;
}

function setTab(tabId) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("d-none", panel.id !== `tab-${tabId}`);
  });
  byId("live-tab-status").classList.toggle("d-none", tabId !== "live");
}

function setEmptyState(container, message) {
  container.innerHTML = "";
  container.textContent = message;
  container.classList.add("text-body-secondary");
}

function createPanelRow(contentHtml) {
  const div = document.createElement("div");
  div.className = "border rounded p-2 bg-body-tertiary";
  div.innerHTML = contentHtml;
  return div;
}

function highlightMarkdownLine(text) {
  if (!text) {
    return "&nbsp;";
  }

  return hljs.highlight(text, { language: "markdown" }).value;
}

function formatRelativeFromNow(isoTime) {
  const diffSeconds = Math.round((Date.parse(isoTime) - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absoluteSeconds < 45) {
    return rtf.format(Math.round(diffSeconds), "second");
  }
  if (absoluteSeconds < 3600) {
    return rtf.format(Math.round(diffSeconds / 60), "minute");
  }
  if (absoluteSeconds < 86400) {
    return rtf.format(Math.round(diffSeconds / 3600), "hour");
  }
  return rtf.format(Math.round(diffSeconds / 86400), "day");
}

function formatSessionOffset(sessionStartedAt, isoTime) {
  const relative = Math.max(0, Date.parse(isoTime) - Date.parse(sessionStartedAt));
  const hours = Math.floor(relative / 3600000);
  const minutes = Math.floor((relative % 3600000) / 60000);
  const seconds = Math.floor((relative % 60000) / 1000);

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function topicMarker(topic) {
  switch (topic.currentState) {
    case "covered":
      return "[x]";
    case "partial":
      return "[~]";
    case "snoozed":
      return "[>]";
    case "dismissed":
      return "[-]";
    default:
      return "[ ]";
  }
}

function appendMarkdownRow(container, text, options = {}) {
  const row = document.createElement("div");
  row.className = "position-relative";

  if (options.topic) {
    const dropdownWrap = document.createElement("div");
    dropdownWrap.className = "dropdown position-absolute top-0 start-0";

    const toggle = document.createElement("button");
    toggle.className = "btn btn-link btn-sm p-0 text-decoration-none font-monospace text-reset";
    toggle.type = "button";
    toggle.setAttribute("data-bs-toggle", "dropdown");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("title", [
      `Current state: ${options.topic.currentState}`,
      `Set by: ${options.topic.stateSetBy}`,
      typeof options.topic.confidenceAtLastChange === "number"
        ? `Confidence: ${Math.round(options.topic.confidenceAtLastChange * 100)}%`
        : null
    ].filter(Boolean).join(" | "));
    toggle.textContent = topicMarker(options.topic);

    const menu = document.createElement("ul");
    menu.className = "dropdown-menu dropdown-menu-sm";
    topicStates.forEach((nextState) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.className = "dropdown-item small";
      button.type = "button";
      button.textContent = nextState;
      button.addEventListener("click", async () => {
        try {
          await requestJson("/api/session/topic-state", {
            method: "POST",
            body: JSON.stringify({ topicId: options.topic.id, nextState })
          });
          await loadState();
        } catch (error) {
          showError(error.message);
        }
      });
      item.appendChild(button);
      menu.appendChild(item);
    });

    dropdownWrap.append(toggle, menu);
    row.appendChild(dropdownWrap);
  }

  const line = document.createElement("div");
  line.className = options.topic ? "ps-5" : "";
  line.innerHTML = highlightMarkdownLine(text);
  row.appendChild(line);
  container.appendChild(row);
}

function appendTopicDetails(container, topicId, label, childTopics, session, suggestionIndex) {
  const detailsWrap = document.createElement("div");
  detailsWrap.className = "ps-5 mb-1";

  const details = document.createElement("details");
  details.className = "small";
  details.open = state.expandedTopics.has(topicId);
  details.addEventListener("toggle", () => {
    if (details.open) {
      state.expandedTopics.add(topicId);
      return;
    }

    state.expandedTopics.delete(topicId);
  });

  const summary = document.createElement("summary");
  summary.className = "text-body-secondary";
  summary.textContent = label;
  details.appendChild(summary);

  const childContainer = document.createElement("div");
  childContainer.className = "pt-1";

  childTopics.forEach((childTopic) => {
    appendMarkdownRow(childContainer, buildTopicLine(childTopic, suggestionIndex, true), { topic: childTopic });

    const elaborationPrompts = suggestionIndex.elaborationByTopic.get(childTopic.id) || [];
    elaborationPrompts.forEach((prompt) => {
      appendMarkdownRow(childContainer, `    - 💬 ${prompt.text} (${Math.round(prompt.confidence * 100)}%)`);
    });
  });

  details.appendChild(childContainer);
  detailsWrap.appendChild(details);
  container.appendChild(detailsWrap);
}

function sectionLines(title, lines) {
  return [
    `## ${title}`,
    ...(lines.length ? lines : ["- None"]),
    ""
  ];
}

function buildSuggestionIndex(session) {
  const activeByTopic = new Map();
  const elaborationByTopic = new Map();
  const floatingPrompts = [];

  session.suggestions.activeTopics.forEach((prompt) => {
    if (prompt.topicId && session.topics[prompt.topicId]) {
      activeByTopic.set(prompt.topicId, prompt);
      return;
    }

    floatingPrompts.push({ category: "Active", prompt });
  });

  session.suggestions.elaborationStarters.forEach((prompt) => {
    if (prompt.topicId && session.topics[prompt.topicId]) {
      const items = elaborationByTopic.get(prompt.topicId) || [];
      items.push(prompt);
      elaborationByTopic.set(prompt.topicId, items);
      return;
    }

    floatingPrompts.push({ category: "Prompt", prompt });
  });

  return {
    activeByTopic,
    elaborationByTopic,
    floatingPrompts
  };
}

function buildTopicLine(topic, suggestionIndex, isChild = false) {
  const activePrompt = suggestionIndex.activeByTopic.get(topic.id);
  const prefix = isChild ? "  - " : "- ";
  const focusText = activePrompt ? `  ⭐ ${Math.round(activePrompt.confidence * 100)}%` : "";
  return `${prefix}${topic.text}${focusText}`;
}

function renderNoticeSection(container, session) {
  const noticeLines = [
    session.lastError ? `- Error: ${session.lastError}` : null,
    session.resumeWarning ? `- Resume warning: ${session.resumeWarning}` : null,
    ...session.warnings.map((warning) => {
      const topicText = warning.topicId && session.topics[warning.topicId]
        ? ` (${session.topics[warning.topicId].text})`
        : "";
      return `- ${warning.code}: ${warning.message}${topicText}`;
    })
  ].filter(Boolean);

  sectionLines("Notices", noticeLines.length ? noticeLines : ["- None"]).forEach((text) => appendMarkdownRow(container, text));
}

function renderTalkingPointsSection(container, session, suggestionIndex) {
  appendMarkdownRow(container, "## Talking Points");

  session.document.sections.forEach((section) => {
    appendMarkdownRow(container, `### ${section.heading}`);

    let sectionHasContent = false;

    section.blocks.forEach((block) => {
      if (block.kind === "raw") {
        const rawLine = block.line.trim();
        if (!rawLine) {
          return;
        }
        appendMarkdownRow(container, rawLine);
        sectionHasContent = true;
        return;
      }

      const topic = session.topics[block.topicId];
      if (!topic || topic.parentId) {
        return;
      }

      appendMarkdownRow(container, buildTopicLine(topic, suggestionIndex), { topic });
      sectionHasContent = true;

      const elaborationPrompts = suggestionIndex.elaborationByTopic.get(topic.id) || [];
      elaborationPrompts.forEach((prompt) => {
        appendMarkdownRow(container, `  - 💬 ${prompt.text} (${Math.round(prompt.confidence * 100)}%)`);
      });

      const childTopics = topic.children
        .map((childId) => session.topics[childId])
        .filter(Boolean);

      if (childTopics.length) {
        appendTopicDetails(container, topic.id, `Show beats (${childTopics.length})`, childTopics, session, suggestionIndex);
      }
    });

    if (!sectionHasContent) {
      appendMarkdownRow(container, "- None");
    }

    appendMarkdownRow(container, "");
  });
}

function renderSuggestionSection(container, title, items, emptyMessage) {
  const lines = items.length ? items : [emptyMessage];
  sectionLines(title, lines).forEach((text) => appendMarkdownRow(container, text));
}

function isSuppressedTranscriptEvent(text) {
  const normalized = text.trim().toLowerCase();
  return normalized === "[blank_audio]" || normalized === "[typing]" || normalized === "(typing)" || normalized === "[start speaking]";
}

function buildTranscriptManuscript(session) {
  const transcriptSource = session.visibleTranscriptEvents?.length
    ? session.visibleTranscriptEvents
    : session.latestTranscriptTail;
  const lines = [];

  transcriptSource.forEach((event) => {
    const suppressed = isSuppressedTranscriptEvent(event.text);

    if (event.replaceLast && lines.length > 0) {
      if (suppressed) {
        lines.pop();
        return;
      }

      lines[lines.length - 1] = {
        text: event.text,
        timestamp: event.timestamp
      };
      return;
    }

    if (suppressed) {
      return;
    }

    lines.push({
      text: event.text,
      timestamp: event.timestamp
    });
  });

  return lines.map((line, index) => ({
    key: `line-${index}`,
    ...line
  }));
}

function animateTranscriptRow(row, mode = "insert") {
  if (!row.animate) {
    return;
  }

  const keyframes = mode === "rewrite"
    ? [
      {
        opacity: 0.35,
        filter: "blur(3px)",
        clipPath: "inset(0 100% 0 0)"
      },
      {
        opacity: 1,
        filter: "blur(0)",
        clipPath: "inset(0 0 0 0)"
      }
    ]
    : [
      {
        opacity: 0,
        filter: "blur(3px)",
        clipPath: "inset(0 100% 0 0)",
        transform: "translateY(4px)"
      },
      {
        opacity: 1,
        filter: "blur(0)",
        clipPath: "inset(0 0 0 0)",
        transform: "translateY(0)"
      }
    ];

  row.animate(keyframes, {
    duration: mode === "rewrite" ? 240 : 220,
    easing: "ease-out"
  });
}

function createTranscriptRow(line, session) {
  const row = document.createElement("div");
  row.className = [
    "d-flex",
    "gap-2",
    "align-items-start",
    "py-1"
  ].filter(Boolean).join(" ");

  const time = document.createElement("div");
  time.className = "text-body-secondary flex-shrink-0";
  time.style.minWidth = "4.5rem";
  time.textContent = formatSessionOffset(session.startedAt, line.timestamp);

  const text = document.createElement("div");
  text.className = "text-body-emphasis";
  text.style.whiteSpace = "pre-wrap";
  text.textContent = line.text;

  row.append(time, text);
  return row;
}

function renderTranscriptPane(session) {
  const container = byId("live-transcript-pane");
  container.innerHTML = "";

  const heading = document.createElement("div");
  heading.className = "mb-2";
  heading.innerHTML = highlightMarkdownLine("## Transcript");
  container.appendChild(heading);

  if (!session) {
    const empty = document.createElement("div");
    empty.className = "text-body-secondary";
    empty.textContent = "No active session";
    container.appendChild(empty);
    state.transcriptRender = {
      keys: new Set(),
      textByKey: new Map()
    };
    container.scrollTop = container.scrollHeight;
    return;
  }

  const transcriptLines = buildTranscriptManuscript(session);

  if (!transcriptLines.length) {
    const empty = document.createElement("div");
    empty.className = "text-body-secondary";
    empty.textContent = "No transcript captured yet.";
    container.appendChild(empty);
    state.transcriptRender = {
      keys: new Set(),
      textByKey: new Map()
    };
    container.scrollTop = container.scrollHeight;
    return;
  }

  const previousKeys = state.transcriptRender.keys;

  transcriptLines.forEach((line) => {
    const row = createTranscriptRow(line, session);
    container.appendChild(row);
    if (!previousKeys.has(line.key)) {
      animateTranscriptRow(row);
      return;
    }

    const previousText = state.transcriptRender.textByKey.get(line.key);
    if (previousText !== line.text) {
      animateTranscriptRow(row, "rewrite");
    }
  });

  state.transcriptRender = {
    keys: new Set(transcriptLines.map((line) => line.key)),
    textByKey: new Map(transcriptLines.map((line) => [line.key, line.text]))
  };
  container.scrollTop = container.scrollHeight;
}

function renderLiveMarkdown(data) {
  const container = byId("live-markdown-pane");
  container.innerHTML = "";

  const session = data.activeSession;
  if (!session) {
    appendMarkdownRow(container, "## Live View");
    appendMarkdownRow(container, "- No active session");
    renderTranscriptPane(null);
    return;
  }

  const suggestionIndex = buildSuggestionIndex(session);

  renderNoticeSection(container, session);
  renderTalkingPointsSection(container, session, suggestionIndex);

  renderSuggestionSection(
    container,
    "Live Prompts",
    suggestionIndex.floatingPrompts.map(({ category, prompt }) => `- ${category}: ${prompt.text} (${Math.round(prompt.confidence * 100)}%)`),
    "- None"
  );

  renderSuggestionSection(
    container,
    "Next Up",
    session.suggestions.adjacentNextTopics.map((prompt) => {
      const relatedTopic = prompt.topicId && session.topics[prompt.topicId]
        ? ` -> ${session.topics[prompt.topicId].text}`
        : "";
      return `- ${prompt.text}${relatedTopic} (${Math.round(prompt.confidence * 100)}%)`;
    }),
    "- None"
  );

  renderSuggestionSection(
    container,
    "Off-topic Observations",
    session.offTopicObservations.map((item) => `- ${item.label} (${Math.round(item.confidence * 100)}%)`),
    "- None"
  );

  renderSuggestionSection(
    container,
    "Recovery Prompts",
    session.suggestions.recoveryPrompts.map((prompt) => `- ${prompt.text} (${Math.round(prompt.confidence * 100)}%)`),
    "- None"
  );

  renderTranscriptPane(session);
}

function renderMicrophoneDiagnostics(monitor) {
  const container = byId("microphone-diagnostics");
  container.innerHTML = "";

  const lines = [
    `Provider: ${monitor.provider}`,
    `Selected device: ${monitor.selectedDeviceName || "none"}`,
    monitor.whisperCaptureId ? `Whisper capture id: ${monitor.whisperCaptureId}` : null,
    `Probe status: ${monitor.probeStatus}`,
    monitor.probeLastUpdatedAt ? `Last probe update: ${new Date(monitor.probeLastUpdatedAt).toLocaleTimeString()}` : null,
    monitor.probeError ? `Probe error: ${monitor.probeError}` : null,
    monitor.whisperLastError ? `Whisper error: ${monitor.whisperLastError}` : null,
    ...(monitor.deviceDiagnostics || [])
  ].filter(Boolean);

  if (!lines.length) {
    setEmptyState(container, "No microphone diagnostics yet.");
    return;
  }

  container.classList.remove("text-body-secondary");
  lines.forEach((line) => {
    const row = createPanelRow("");
    row.textContent = line;
    container.appendChild(row);
  });
}

function renderHistory(entries, targetId, resumable = false) {
  const container = byId(targetId);
  container.innerHTML = "";
  if (!entries || entries.length === 0) {
    setEmptyState(container, resumable ? "No resumable sessions." : "No sessions yet.");
    return;
  }

  container.classList.remove("text-body-secondary");
  entries.forEach((entry) => {
    const row = createPanelRow(`
      <div class="fw-semibold">${entry.id}</div>
      <div>${entry.status} · ${(entry.durationSeconds / 60).toFixed(1)} min</div>
      <div class="text-body-secondary">covered ${entry.countsByState.covered} · partial ${entry.countsByState.partial} · pending ${entry.countsByState.pending}</div>
      <a class="small" href="${entry.proposedMarkdownPath.replace(/^.*\/sessions\//, "/artifacts/")}" target="_blank" rel="noreferrer">Proposed markdown</a>
    `);
    if (resumable) {
      const button = document.createElement("button");
      button.textContent = "Resume";
      button.className = "btn btn-sm btn-outline-primary mt-2";
      button.type = "button";
      button.addEventListener("click", async () => {
        try {
          await requestJson(`/api/session/resume/${entry.id}`, { method: "POST" });
          setTab("live");
          await loadState();
        } catch (error) {
          showError(error.message);
        }
      });
      row.appendChild(button);
    }
    container.appendChild(row);
  });
}

function fillSelect(select, options, selectedValue) {
  select.innerHTML = "";
  options.forEach((option) => {
    const el = document.createElement("option");
    if (typeof option === "string") {
      el.value = option;
      el.textContent = option;
    } else {
      el.value = option.id;
      el.textContent = option.name;
    }
    el.selected = el.value === (selectedValue ?? "");
    select.appendChild(el);
  });
  if (!options.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No devices";
    select.appendChild(empty);
  }
}

function selectedMicrophoneName(data) {
  if (data.microphoneMonitor?.selectedDeviceName) {
    return data.microphoneMonitor.selectedDeviceName;
  }

  const selectedId = state.configDirty && state.configDraft
    ? state.configDraft.microphoneId
    : data.config.microphoneId;

  return data.microphones.find((microphone) => microphone.id === selectedId)?.name || "No microphone selected";
}

function renderConfig(data) {
  const { config, runtime, microphones, microphonePermission, microphoneMonitor } = data;
  const effectiveConfig = state.configDirty && state.configDraft
    ? { ...config, ...state.configDraft }
    : config;

  byId("markdown-path").value = effectiveConfig.markdownFilePath || "";
  fillSelect(byId("microphone-id"), microphones, effectiveConfig.microphoneId);
  fillSelect(byId("stt-provider"), runtime.availableProviders.stt, effectiveConfig.sttProvider);
  fillSelect(byId("analysis-provider"), runtime.availableProviders.analysis, effectiveConfig.analysisProvider);
  byId("chunk-sensitivity").value = effectiveConfig.chunkSensitivity;
  byId("analysis-threshold").value = String(effectiveConfig.analysisAutoApplyThreshold);
  byId("analysis-threshold-label").textContent = `${Math.round(effectiveConfig.analysisAutoApplyThreshold * 100)}%`;
  byId("permission-pill").textContent = `Mic: ${microphonePermission} ●`;
  byId("permission-pill").className = `badge ${microphonePermission === "granted" ? "text-bg-light border text-success" : "text-bg-light border text-secondary"}`;
  byId("permission-pill").title = selectedMicrophoneName(data);
  byId("mic-level-bar").style.width = `${Math.round((microphoneMonitor?.level ?? 0) * 100)}%`;
  byId("mic-level-bar").setAttribute("aria-valuenow", String(Math.round((microphoneMonitor?.level ?? 0) * 100)));
  byId("mic-level-meta").textContent = microphoneMonitor?.probeStatus === "running"
    ? `Probe active${microphoneMonitor.probeLastUpdatedAt ? ` · updated ${new Date(microphoneMonitor.probeLastUpdatedAt).toLocaleTimeString()}` : ""}`
    : (microphoneMonitor?.probeError || "No probe data yet.");
  renderMicrophoneDiagnostics(microphoneMonitor);
}

function renderLive(data) {
  const session = data.activeSession;
  const analyzeButton = byId("analyze-now");
  const endButton = byId("end-session");
  const undoButton = byId("undo-action");
  const mockTranscriptButton = byId("send-mock-transcript");
  const mockTranscriptCard = byId("mock-transcript-card");
  const permissionPill = byId("permission-pill");
  const sessionPill = byId("session-pill");

  permissionPill.textContent = `Mic: ${data.microphonePermission} ●`;
  permissionPill.className = `badge ${data.microphonePermission === "granted" ? "text-bg-light border text-success" : "text-bg-light border text-secondary"}`;
  permissionPill.title = selectedMicrophoneName(data);
  sessionPill.textContent = session ? `Session: ${session.status} ●` : "No active session";
  sessionPill.className = `badge ${session ? "text-bg-light border text-primary" : "text-bg-light border text-secondary"}`;
  sessionPill.title = session ? session.id : "No active session";

  if (!session) {
    analyzeButton.classList.add("disabled");
    analyzeButton.setAttribute("aria-disabled", "true");
    analyzeButton.disabled = true;
    endButton.classList.add("disabled");
    endButton.setAttribute("aria-disabled", "true");
    endButton.disabled = true;
    endButton.textContent = "No active session";
    undoButton.classList.add("disabled");
    undoButton.setAttribute("aria-disabled", "true");
    undoButton.disabled = true;
    mockTranscriptButton.disabled = true;
    mockTranscriptCard.classList.add("d-none");
    byId("session-meta").textContent = "No active session.";
    renderLiveMarkdown(data);
    return;
  }

  analyzeButton.classList.remove("disabled");
  analyzeButton.removeAttribute("aria-disabled");
  analyzeButton.disabled = false;
  endButton.classList.remove("disabled");
  endButton.removeAttribute("aria-disabled");
  endButton.disabled = false;
  endButton.textContent = "End session";
  undoButton.classList.remove("disabled");
  undoButton.removeAttribute("aria-disabled");
  undoButton.disabled = false;
  mockTranscriptButton.disabled = false;
  mockTranscriptCard.classList.toggle("d-none", session.sttProvider !== "mock");
  byId("session-meta").textContent = [
    `Started ${formatRelativeFromNow(session.startedAt)}`,
    `Status ${session.status}`,
    session.latestAnalysisAt ? `Last analysis ${formatRelativeFromNow(session.latestAnalysisAt)}` : null,
    session.lastError ? "Error present" : null
  ].filter(Boolean).join(" · ");
  renderLiveMarkdown(data);
}

async function loadState() {
  const data = await requestJson("/api/state");
  state.data = data;
  if (data.runtime?.pollingIntervalMs && data.runtime.pollingIntervalMs !== state.pollingIntervalMs) {
    state.pollingIntervalMs = data.runtime.pollingIntervalMs;
    if (state.pollingHandle) {
      clearInterval(state.pollingHandle);
      state.pollingHandle = setInterval(() => {
        loadState().catch((error) => showError(error.message));
      }, state.pollingIntervalMs);
    }
  }
  renderConfig(data);
  renderLive(data);
  renderHistory(data.history, "history-list");
  renderHistory(data.resumableSessions, "resume-list", true);
  clearError();
}

async function saveConfig(overrides = collectConfigFormValues()) {
  const payload = await requestJson("/api/config", {
    method: "POST",
    body: JSON.stringify(overrides)
  });

  state.configDraft = payload.config;
  state.configDirty = false;
  return payload.config;
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setTab(tab.dataset.tab));
  });

  byId("analysis-threshold").addEventListener("input", (event) => {
    markConfigDirty();
    byId("analysis-threshold-label").textContent = `${Math.round(Number(event.target.value) * 100)}%`;
  });

  byId("markdown-path").addEventListener("input", markConfigDirty);
  byId("stt-provider").addEventListener("change", markConfigDirty);
  byId("analysis-provider").addEventListener("change", markConfigDirty);
  byId("chunk-sensitivity").addEventListener("change", markConfigDirty);

  byId("microphone-id").addEventListener("change", async () => {
    markConfigDirty();

    try {
      await saveConfig({ microphoneId: byId("microphone-id").value || null });
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });

  byId("save-config").addEventListener("click", async () => {
    try {
      await saveConfig();
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });

  byId("refresh-state").addEventListener("click", async () => {
    try {
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });

  byId("start-session").addEventListener("click", async () => {
    try {
      await saveConfig();
      await requestJson("/api/session/start", { method: "POST" });
      setTab("live");
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });

  byId("analyze-now").addEventListener("click", async () => {
    try {
      await requestJson("/api/session/analyze", { method: "POST" });
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });

  byId("end-session").addEventListener("click", async () => {
    try {
      await requestJson("/api/session/end", { method: "POST", body: JSON.stringify({ status: "finished" }) });
      setTab("history");
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });

  byId("undo-action").addEventListener("click", async () => {
    try {
      await requestJson("/api/session/undo", { method: "POST" });
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });

  byId("send-mock-transcript").addEventListener("click", async () => {
    try {
      await requestJson("/api/session/mock-transcript", {
        method: "POST",
        body: JSON.stringify({ text: byId("mock-transcript").value })
      });
      byId("mock-transcript").value = "";
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });
}

bindEvents();
loadState().catch((error) => showError(error.message));
state.pollingHandle = setInterval(() => {
  loadState().catch((error) => showError(error.message));
}, state.pollingIntervalMs);
