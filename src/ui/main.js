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
  configDirty: false
};

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
  const banner = byId("error-banner");
  banner.textContent = message;
  banner.classList.remove("d-none");
}

function clearError() {
  byId("error-banner").classList.add("d-none");
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

function formatRelativeSrtTime(sessionStartedAt, isoTime) {
  const relative = Math.max(0, new Date(isoTime).getTime() - new Date(sessionStartedAt).getTime());
  const hours = Math.floor(relative / 3600000);
  const minutes = Math.floor((relative % 3600000) / 60000);
  const seconds = Math.floor((relative % 60000) / 1000);
  const milliseconds = relative % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
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
    toggle.setAttribute("title", `Current state: ${options.topic.currentState}`);
    toggle.textContent = topicMarker(options.topic);

    const menu = document.createElement("ul");
    menu.className = "dropdown-menu dropdown-menu-sm";
    ["pending", "partial", "covered", "snoozed", "dismissed"].forEach((nextState) => {
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

    dropdownWrap.appendChild(toggle);
    dropdownWrap.appendChild(menu);
    row.appendChild(dropdownWrap);
  }

  const line = document.createElement("div");
  line.className = options.topic ? "ps-5" : "";
  line.innerHTML = highlightMarkdownLine(text);
  row.appendChild(line);
  container.appendChild(row);
}

function sectionLines(title, lines) {
  return [
    `## ${title}`,
    ...(lines.length ? lines : ["- None"]),
    ""
  ];
}

function buildLiveMarkdownRows(data) {
  const session = data.activeSession;
  if (!session) {
    return [
      { text: "## Session" },
      { text: "- No active session" }
    ];
  }

  const sessionLines = [
    `- Started: ${new Date(session.startedAt).toLocaleString()}`,
    `- Status: ${session.status}`,
    `- Session ID: ${session.id}`,
    session.lastError ? `- Error: ${session.lastError}` : null,
    session.resumeWarning ? `- Resume warning: ${session.resumeWarning}` : null
  ].filter(Boolean);

  const suggestionLines = (items, titleField = "text") => items.map((item) => `- ${item[titleField]} (${Math.round(item.confidence * 100)}%)`);
  const transcriptLines = session.chunks
    .slice(-5)
    .reverse()
    .flatMap((chunk, index) => [
      `${index + 1}`,
      `${formatRelativeSrtTime(session.startedAt, chunk.startedAt)} --> ${formatRelativeSrtTime(session.startedAt, chunk.endedAt)}`,
      chunk.text,
      ""
    ]);

  const rows = [
    ...sectionLines("Session", sessionLines),
    ...sectionLines("Active Topics", suggestionLines(session.suggestions.activeTopics)),
    ...sectionLines("Elaboration Starters", suggestionLines(session.suggestions.elaborationStarters)),
    ...sectionLines("Adjacent Next Topics", suggestionLines(session.suggestions.adjacentNextTopics)),
    ...sectionLines("Recovery Prompts", suggestionLines(session.suggestions.recoveryPrompts)),
    ...sectionLines("Off-topic Observations", suggestionLines(session.offTopicObservations, "label")),
    ...sectionLines("Transcript", transcriptLines.length ? transcriptLines : ["- No transcript captured yet."]),
    "## Topic State"
  ].map((text) => ({ text }));

  Object.values(session.topics)
    .sort((left, right) => left.originalOrder - right.originalOrder)
    .forEach((topic) => {
      rows.push({
        text: `${topic.section}: ${topic.text}`,
        topic
      });
    });

  return rows;
}

function renderLiveMarkdown(data) {
  const container = byId("live-markdown-pane");
  container.innerHTML = "";

  buildLiveMarkdownRows(data).forEach((row) => {
    appendMarkdownRow(container, row.text, { topic: row.topic });
  });
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
  byId("permission-pill").textContent = `Mic: ${microphonePermission}`;
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
  const permissionPill = byId("permission-pill");
  const sessionPill = byId("session-pill");
  permissionPill.textContent = `Mic: ${data.microphonePermission}`;
  permissionPill.className = `badge ${data.microphonePermission === "granted" ? "text-bg-success" : "text-bg-secondary"}`;
  sessionPill.textContent = session ? `Active: ${session.id}` : "No active session";
  sessionPill.className = `badge ${session ? "text-bg-primary" : "text-bg-secondary"}`;

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
  byId("session-meta").textContent = [
    `Started ${new Date(session.startedAt).toLocaleString()}`,
    `Status ${session.status}`,
    session.lastError ? `Error: ${session.lastError}` : null,
    session.resumeWarning
  ].filter(Boolean).join(" · ");
  renderLiveMarkdown(data);
}

async function loadState() {
  clearError();
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
