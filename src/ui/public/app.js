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

function renderSuggestions(containerId, items, titleField = "text") {
  const container = byId(containerId);
  container.innerHTML = "";

  if (!items || items.length === 0) {
    setEmptyState(container, "No suggestions yet.");
    return;
  }

  container.classList.remove("text-body-secondary");
  items.forEach((item) => {
    const div = createPanelRow(`
      <div class="fw-semibold">${item[titleField]}</div>
      <div>${item.rationale}</div>
      <div class="text-body-secondary">Confidence: ${(item.confidence * 100).toFixed(0)}%</div>
    `);
    container.appendChild(div);
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

function renderTranscriptTail(events) {
  const container = byId("transcript-tail");
  container.innerHTML = "";
  if (!events || events.length === 0) {
    setEmptyState(container, "No transcript captured yet.");
    return;
  }

  container.classList.remove("text-body-secondary");
  events.slice().reverse().forEach((event) => {
    const div = createPanelRow(`
      <div class="fw-semibold">${new Date(event.timestamp).toLocaleTimeString()}</div>
      <div>${event.text}</div>
    `);
    container.appendChild(div);
  });
}

function renderSubtitleChunks(session) {
  const container = byId("transcript-tail");
  container.innerHTML = "";

  if (!session?.chunks?.length) {
    renderTranscriptTail(session?.latestTranscriptTail || []);
    return;
  }

  container.classList.remove("text-body-secondary");
  const sessionStart = new Date(session.startedAt).getTime();
  const fmt = (isoTime) => {
    const relative = Math.max(0, new Date(isoTime).getTime() - sessionStart);
    const hours = Math.floor(relative / 3600000);
    const minutes = Math.floor((relative % 3600000) / 60000);
    const seconds = Math.floor((relative % 60000) / 1000);
    const milliseconds = relative % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
  };

  session.chunks.slice(-8).reverse().forEach((chunk, reverseIndex) => {
    const ordinal = session.chunks.length - reverseIndex;
    const div = createPanelRow(`
      <div class="fw-semibold">${ordinal}</div>
      <div class="text-body-secondary">${fmt(chunk.startedAt)} --> ${fmt(chunk.endedAt)}</div>
      <div>${chunk.text}</div>
    `);
    container.appendChild(div);
  });
}

function renderTopicState(session) {
  const container = byId("topic-state-list");
  container.innerHTML = "";
  if (!session) {
    setEmptyState(container, "No active session.");
    return;
  }

  container.classList.remove("text-body-secondary");
  Object.values(session.topics)
    .sort((a, b) => a.originalOrder - b.originalOrder)
    .forEach((topic) => {
      const row = createPanelRow(`
        <div class="fw-semibold">${topic.text}</div>
        <div class="text-body-secondary">${topic.currentState} · ${topic.section}</div>
      `);

      const actions = document.createElement("div");
      actions.className = "d-flex flex-wrap gap-2 mt-2";
      ["partial", "covered", "snoozed", "dismissed"].forEach((nextState) => {
        const button = document.createElement("button");
        button.textContent = nextState;
        button.className = "btn btn-sm btn-outline-secondary";
        button.type = "button";
        button.addEventListener("click", async () => {
          try {
            await requestJson("/api/session/topic-state", {
              method: "POST",
              body: JSON.stringify({ topicId: topic.id, nextState })
            });
            await loadState();
          } catch (error) {
            showError(error.message);
          }
        });
        actions.appendChild(button);
      });
      row.appendChild(actions);
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
  const monitor = data.microphoneMonitor;
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
    renderSuggestions("active-topics", []);
    renderSuggestions("elaboration-starters", []);
    renderSuggestions("adjacent-topics", []);
    renderSuggestions("recovery-prompts", []);
    renderSuggestions("off-topic", [], "label");
    renderTranscriptTail([]);
    renderTopicState(null);
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

  renderSuggestions("active-topics", session.suggestions.activeTopics);
  renderSuggestions("elaboration-starters", session.suggestions.elaborationStarters);
  renderSuggestions("adjacent-topics", session.suggestions.adjacentNextTopics);
  renderSuggestions("recovery-prompts", session.suggestions.recoveryPrompts);
  renderSuggestions("off-topic", session.offTopicObservations, "label");
  renderSubtitleChunks(session);
  renderTopicState(session);
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
