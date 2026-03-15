const state = {
  pollingHandle: null,
  pollingIntervalMs: 2000,
  data: null
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
  banner.classList.remove("hidden");
}

function clearError() {
  byId("error-banner").classList.add("hidden");
}

function setTab(tabId) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.id === `tab-${tabId}`);
  });
}

function renderSuggestions(containerId, items, titleField = "text") {
  const container = byId(containerId);
  container.innerHTML = "";

  if (!items || items.length === 0) {
    container.textContent = "No suggestions yet.";
    container.classList.add("muted");
    return;
  }

  container.classList.remove("muted");
  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "suggestion";
    div.innerHTML = `
      <strong>${item[titleField]}</strong>
      <p>${item.rationale}</p>
      <p class="muted">Confidence: ${(item.confidence * 100).toFixed(0)}%</p>
    `;
    container.appendChild(div);
  });
}

function renderTranscriptTail(events) {
  const container = byId("transcript-tail");
  container.innerHTML = "";
  if (!events || events.length === 0) {
    container.textContent = "No transcript captured yet.";
    container.classList.add("muted");
    return;
  }

  container.classList.remove("muted");
  events.slice().reverse().forEach((event) => {
    const div = document.createElement("div");
    div.className = "suggestion";
    div.innerHTML = `<strong>${new Date(event.timestamp).toLocaleTimeString()}</strong><p>${event.text}</p>`;
    container.appendChild(div);
  });
}

function renderTopicState(session) {
  const container = byId("topic-state-list");
  container.innerHTML = "";
  if (!session) {
    container.textContent = "No active session.";
    container.classList.add("muted");
    return;
  }

  container.classList.remove("muted");
  Object.values(session.topics)
    .sort((a, b) => a.originalOrder - b.originalOrder)
    .forEach((topic) => {
      const row = document.createElement("div");
      row.className = "topic-row";
      row.innerHTML = `
        <strong>${topic.text}</strong>
        <p class="muted">${topic.currentState} · ${topic.section}</p>
      `;

      const actions = document.createElement("div");
      actions.className = "topic-actions";
      ["partial", "covered", "snoozed", "dismissed"].forEach((nextState) => {
        const button = document.createElement("button");
        button.textContent = nextState;
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
    container.textContent = resumable ? "No resumable sessions." : "No sessions yet.";
    container.classList.add("muted");
    return;
  }

  container.classList.remove("muted");
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = resumable ? "resume-row" : "history-row";
    row.innerHTML = `
      <strong>${entry.id}</strong>
      <p>${entry.status} · ${(entry.durationSeconds / 60).toFixed(1)} min</p>
      <p class="muted">covered ${entry.countsByState.covered} · partial ${entry.countsByState.partial} · pending ${entry.countsByState.pending}</p>
      <a class="artifact-link" href="${entry.proposedMarkdownPath.replace(/^.*\/sessions\//, "/artifacts/")}" target="_blank" rel="noreferrer">Proposed markdown</a>
    `;
    if (resumable) {
      const button = document.createElement("button");
      button.textContent = "Resume";
      button.className = "accent";
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
  const { config, runtime, microphones, microphonePermission } = data;
  byId("markdown-path").value = config.markdownFilePath || "";
  fillSelect(byId("microphone-id"), microphones, config.microphoneId);
  fillSelect(byId("stt-provider"), runtime.availableProviders.stt, config.sttProvider);
  fillSelect(byId("analysis-provider"), runtime.availableProviders.analysis, config.analysisProvider);
  byId("chunk-sensitivity").value = config.chunkSensitivity;
  byId("analysis-threshold").value = String(config.analysisAutoApplyThreshold);
  byId("analysis-threshold-label").textContent = `${Math.round(config.analysisAutoApplyThreshold * 100)}%`;
  byId("permission-pill").textContent = `Mic: ${microphonePermission}`;
}

function renderLive(data) {
  const session = data.activeSession;
  byId("session-pill").textContent = session ? `Active: ${session.id}` : "No active session";
  byId("mic-level-bar").style.width = `${Math.round((session?.microphoneLevel ?? 0) * 100)}%`;

  if (!session) {
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
  renderTranscriptTail(session.latestTranscriptTail);
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

async function saveConfig() {
  await requestJson("/api/config", {
    method: "POST",
    body: JSON.stringify({
      markdownFilePath: byId("markdown-path").value,
      microphoneId: byId("microphone-id").value || null,
      sttProvider: byId("stt-provider").value,
      analysisProvider: byId("analysis-provider").value,
      chunkSensitivity: byId("chunk-sensitivity").value,
      analysisAutoApplyThreshold: Number(byId("analysis-threshold").value)
    })
  });
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setTab(tab.dataset.tab));
  });

  byId("analysis-threshold").addEventListener("input", (event) => {
    byId("analysis-threshold-label").textContent = `${Math.round(Number(event.target.value) * 100)}%`;
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
