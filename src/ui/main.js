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
  },
  captureSourceRender: {
    optionsSignature: "",
    selectedSignature: ""
  },
  dismissedPermissionSignature: null
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

function getSelectedCaptureSources() {
  const select = byId("capture-sources");
  const selectedIds = Array.from(select.selectedOptions).map((option) => option.value);
  const catalog = state.data?.captureSourceCatalog || [];
  return selectedIds
    .map((id) => catalog.find((source) => source.id === id))
    .filter(Boolean)
    .map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name
    }));
}

function collectConfigFormValues() {
  return {
    markdownFilePath: byId("markdown-path").value,
    captureSources: getSelectedCaptureSources(),
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
      appendMarkdownRow(childContainer, `    - ${prompt.text} (${Math.round(prompt.confidence * 100)}%)`);
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
  const focusText = activePrompt ? `  ${Math.round(activePrompt.confidence * 100)}%` : "";
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
        appendMarkdownRow(container, `  - ${prompt.text} (${Math.round(prompt.confidence * 100)}%)`);
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

function buildTranscriptDisplayRows(session) {
  const displayTranscript = session.displayTranscript;
  if (!displayTranscript) {
    return [];
  }

  return [
    ...displayTranscript.committedLines,
    ...(displayTranscript.activeLine ? [displayTranscript.activeLine] : [])
  ];
}

function animateTranscriptRow(row, mode = "insert") {
  if (!row.animate) {
    return;
  }

  const keyframes = mode === "rewrite"
    ? [
      { opacity: 0.35, filter: "blur(3px)", clipPath: "inset(0 100% 0 0)" },
      { opacity: 1, filter: "blur(0)", clipPath: "inset(0 0 0 0)" }
    ]
    : [
      { opacity: 0, filter: "blur(3px)", clipPath: "inset(0 100% 0 0)", transform: "translateY(4px)" },
      { opacity: 1, filter: "blur(0)", clipPath: "inset(0 0 0 0)", transform: "translateY(0)" }
    ];

  row.animate(keyframes, {
    duration: mode === "rewrite" ? 240 : 220,
    easing: "ease-out"
  });
}

function badgeClassForSource(kind) {
  switch (kind) {
    case "system-mix":
      return "text-bg-warning";
    case "loopback-input":
      return "text-bg-warning";
    case "native-display-audio":
      return "text-bg-info";
    case "native-app-audio":
      return "text-bg-primary";
    default:
      return "text-bg-success";
  }
}

function createTranscriptRow(line, session) {
  const row = document.createElement("div");
  row.className = "d-flex gap-2 align-items-start py-1";

  const time = document.createElement("div");
  time.className = "text-body-secondary flex-shrink-0";
  time.style.minWidth = "4.5rem";
  time.textContent = formatSessionOffset(session.startedAt, line.timestamp);

  const body = document.createElement("div");
  body.className = "d-flex gap-2 align-items-start flex-wrap";

  const badge = document.createElement("span");
  badge.className = `badge ${badgeClassForSource(line.sourceKind)}`;
  badge.textContent = line.sourceName;

  const text = document.createElement("div");
  text.className = line.muted ? "text-body-secondary fst-italic" : "text-body-emphasis";
  text.style.whiteSpace = "pre-wrap";
  text.textContent = line.text;

  body.append(badge, text);
  row.append(time, body);
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
    return;
  }

  const transcriptLines = buildTranscriptDisplayRows(session);

  if (!transcriptLines.length) {
    const empty = document.createElement("div");
    empty.className = "text-body-secondary";
    empty.textContent = "No transcript captured yet.";
    container.appendChild(empty);
    state.transcriptRender = {
      keys: new Set(),
      textByKey: new Map()
    };
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

function renderGroupedCaptureSelect(catalog, selectedSources) {
  const select = byId("capture-sources");
  const selectedIds = new Set((selectedSources || []).map((source) => source.id));
  const optionsSignature = (catalog || [])
    .map((source) => `${source.groupLabel}::${source.id}::${source.kind}::${source.name}::${source.available !== false}::${source.availabilityReason || ""}`)
    .join("|");
  const selectedSignature = Array.from(selectedIds).sort().join("|");
  const groups = new Map();
  const wasFocused = document.activeElement === select;
  const previousScrollTop = select.scrollTop;

  catalog.forEach((source) => {
    const items = groups.get(source.groupLabel) || [];
    items.push(source);
    groups.set(source.groupLabel, items);
  });

  if (state.captureSourceRender.optionsSignature !== optionsSignature) {
    select.innerHTML = "";
    Array.from(groups.entries()).forEach(([label, sources]) => {
      const group = document.createElement("optgroup");
      group.label = label;
      sources.forEach((source) => {
        const option = document.createElement("option");
        option.value = source.id;
        option.selected = selectedIds.has(source.id);
        option.disabled = source.available === false && !selectedIds.has(source.id);
        option.textContent = source.available === false && source.availabilityReason
          ? `${source.name} (Unavailable)`
          : source.name;
        option.title = source.available === false && source.availabilityReason
          ? source.availabilityReason
          : source.details || "";
        group.appendChild(option);
      });
      select.appendChild(group);
    });
  } else if (state.captureSourceRender.selectedSignature !== selectedSignature) {
    Array.from(select.options).forEach((option) => {
      option.selected = selectedIds.has(option.value);
    });
  }

  state.captureSourceRender.optionsSignature = optionsSignature;
  state.captureSourceRender.selectedSignature = selectedSignature;

  if (wasFocused) {
    select.scrollTop = previousScrollTop;
  }
}

function renderSelectedSourcesSummary(selectedSources) {
  const container = byId("selected-sources-summary");
  container.innerHTML = "";

  if (!selectedSources || selectedSources.length === 0) {
    setEmptyState(container, "No sources selected.");
    return;
  }

  container.classList.remove("text-body-secondary");
  selectedSources.forEach((source) => {
    const pill = document.createElement("span");
    pill.className = `badge ${badgeClassForSource(source.kind)}`;
    pill.textContent = source.name;
    container.appendChild(pill);
  });
}

function renderCaptureDiagnostics(monitors) {
  const container = byId("capture-diagnostics");
  container.innerHTML = "";
  const items = Object.values(monitors || {});
  if (!items.length) {
    setEmptyState(container, "No capture diagnostics yet.");
    return;
  }

  container.classList.remove("text-body-secondary");
  items.forEach((monitor) => {
    const row = createPanelRow(`
      <div class="fw-semibold">${monitor.sourceName}</div>
      <div>${monitor.sourceKind} · ${monitor.status}</div>
      ${monitor.error ? `<div class="text-danger">${monitor.error}</div>` : ""}
      ${monitor.lastUpdatedAt ? `<div class="text-body-secondary">Updated ${new Date(monitor.lastUpdatedAt).toLocaleTimeString()}</div>` : ""}
      ${(monitor.deviceDiagnostics || []).length ? `<div class="text-body-secondary">${monitor.deviceDiagnostics.join(" · ")}</div>` : ""}
    `);
    container.appendChild(row);
  });
}

function renderSourceMonitors(monitors) {
  const container = byId("live-source-monitors");
  container.innerHTML = "";
  const items = Object.values(monitors || {});
  if (!items.length) {
    setEmptyState(container, "No active source monitors.");
    return;
  }

  container.classList.remove("text-body-secondary");
  items.forEach((monitor) => {
    const wrapper = document.createElement("div");
    wrapper.className = "border rounded p-2 bg-body-tertiary";
    const header = document.createElement("div");
    header.className = "d-flex justify-content-between align-items-center gap-2";
    header.innerHTML = `
      <div>
        <span class="fw-semibold">${monitor.sourceName}</span>
        <span class="text-body-secondary"> · ${monitor.sourceKind}</span>
      </div>
      <span class="badge ${monitor.status === "running" ? "text-bg-success" : monitor.status === "error" ? "text-bg-danger" : "text-bg-secondary"}">${monitor.status}</span>
    `;

    const progress = document.createElement("div");
    progress.className = "progress mt-2";
    progress.innerHTML = `<div class="progress-bar" style="width: ${Math.round((monitor.level || 0) * 100)}%"></div>`;

    wrapper.append(header, progress);
    if (monitor.error) {
      const error = document.createElement("div");
      error.className = "small text-danger mt-2";
      error.textContent = monitor.error;
      wrapper.appendChild(error);
    }
    container.appendChild(wrapper);
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

function fillSimpleSelect(select, options, selectedValue) {
  select.innerHTML = "";
  options.forEach((option) => {
    const el = document.createElement("option");
    el.value = option;
    el.textContent = option;
    el.selected = option === (selectedValue ?? "");
    select.appendChild(el);
  });
}

function fillMockSourceSelect(session) {
  const select = byId("mock-source-id");
  select.innerHTML = "";
  const sources = session?.captureSources || [];
  sources.forEach((source) => {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.name;
    select.appendChild(option);
  });
}

function permissionStateLabel(value) {
  switch (value) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "not-determined":
      return "not requested yet";
    case "unavailable":
      return "unavailable";
    default:
      return "unknown";
  }
}

function getPermissionRequirements(config, permissions) {
  const selectedSources = config?.captureSources || [];
  const needsMicrophone = selectedSources.some((source) => source.kind === "microphone" || source.kind === "loopback-input" || source.kind === "system-mix");
  const needsSystemAudio = selectedSources.some((source) => source.kind === "native-display-audio" || source.kind === "native-app-audio");
  const issues = [];

  if (needsMicrophone && permissions.microphone !== "granted") {
    issues.push(`Input access is ${permissionStateLabel(permissions.microphone)} for the selected microphone or desktop-audio sources.`);
  }
  if (needsSystemAudio && permissions.systemAudio !== "granted") {
    issues.push(`Screen/system-audio access is ${permissionStateLabel(permissions.systemAudio)} for the selected advanced display/app sources.`);
  }

  return {
    issues,
    requiresAction: issues.length > 0,
    isDenied: (needsMicrophone && permissions.microphone === "denied") || (needsSystemAudio && permissions.systemAudio === "denied")
  };
}

function permissionSignature(config, permissions) {
  return `${permissions.microphone}|${permissions.systemAudio}|${(config?.captureSources || []).map((source) => source.id).sort().join("|")}`;
}

function renderPermissionGuidance(config, permissions) {
  const banner = byId("permission-guidance");
  const text = byId("permission-guidance-text");
  const button = byId("request-permissions");
  const openSettingsButton = byId("open-privacy-settings");
  const requirement = getPermissionRequirements(config, permissions);
  const signature = permissionSignature(config, permissions);

  if (!requirement.requiresAction || state.dismissedPermissionSignature === signature) {
    banner.classList.add("d-none");
    button.disabled = false;
    openSettingsButton.disabled = false;
    return;
  }

  const lines = [
    ...requirement.issues,
    requirement.isDenied
      ? "If a request does not reopen the macOS prompt, enable access in System Settings > Privacy & Security and then start a fresh session."
      : "Use the button below to request the missing permissions."
  ];

  text.innerHTML = lines.map((line) => `<div>${line}</div>`).join("");
  button.disabled = false;
  openSettingsButton.disabled = false;
  banner.classList.remove("d-none");
}

function pickPrimaryMonitor(monitors) {
  const items = Object.values(monitors || {});
  if (!items.length) {
    return null;
  }

  const running = items.filter((monitor) => monitor.status === "running");
  const candidates = running.length ? running : items;
  return candidates
    .slice()
    .sort((left, right) => {
      const levelDelta = (right.level || 0) - (left.level || 0);
      if (levelDelta !== 0) {
        return levelDelta;
      }

      return (right.lastUpdatedAt || "").localeCompare(left.lastUpdatedAt || "");
    })[0] || null;
}

function effectiveConfig(data) {
  if (!state.configDirty || !state.configDraft) {
    return data.config;
  }

  return {
    ...data.config,
    ...state.configDraft,
    captureSources: state.configDraft.captureSources ?? data.config.captureSources
  };
}

function renderConfig(data) {
  const config = effectiveConfig(data);

  byId("markdown-path").value = config.markdownFilePath || "";
  renderGroupedCaptureSelect(data.captureSourceCatalog || [], config.captureSources || []);
  renderSelectedSourcesSummary(config.captureSources || []);
  fillSimpleSelect(byId("stt-provider"), data.runtime.availableProviders.stt, config.sttProvider);
  fillSimpleSelect(byId("analysis-provider"), data.runtime.availableProviders.analysis, config.analysisProvider);
  byId("chunk-sensitivity").value = config.chunkSensitivity;
  byId("analysis-threshold").value = String(config.analysisAutoApplyThreshold);
  byId("analysis-threshold-label").textContent = `${Math.round(config.analysisAutoApplyThreshold * 100)}%`;

  const permissions = data.capturePermissions;
  const primaryMonitor = pickPrimaryMonitor(data.sourceMonitors);
  byId("permission-pill").textContent = `Input: ${permissions.microphone} · Screen: ${permissions.systemAudio}`;
  byId("permission-pill").className = `badge ${(permissions.microphone === "granted" || permissions.systemAudio === "granted") ? "text-bg-light border text-success" : "text-bg-light border text-secondary"}`;
  byId("permission-pill").title = (config.captureSources || []).map((source) => source.name).join(", ") || "No sources selected";
  byId("mic-level-bar").style.width = `${Math.round((primaryMonitor?.level ?? 0) * 100)}%`;
  byId("mic-level-bar").setAttribute("aria-valuenow", String(Math.round((primaryMonitor?.level ?? 0) * 100)));
  byId("mic-level-meta").textContent = primaryMonitor
    ? `${primaryMonitor.sourceName} · ${primaryMonitor.status}${primaryMonitor.lastUpdatedAt ? ` · updated ${new Date(primaryMonitor.lastUpdatedAt).toLocaleTimeString()}` : ""}`
    : "No source monitor data yet.";
  renderCaptureDiagnostics(data.sourceMonitors);
  renderPermissionGuidance(config, permissions);
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

  permissionPill.textContent = `Input: ${data.capturePermissions.microphone} · Screen: ${data.capturePermissions.systemAudio}`;
  permissionPill.className = `badge ${(data.capturePermissions.microphone === "granted" || data.capturePermissions.systemAudio === "granted") ? "text-bg-light border text-success" : "text-bg-light border text-secondary"}`;
  sessionPill.textContent = session ? `Session: ${session.status} ●` : "No active session";
  sessionPill.className = `badge ${session ? "text-bg-light border text-primary" : "text-bg-light border text-secondary"}`;
  sessionPill.title = session ? session.id : "No active session";
  renderPermissionGuidance(effectiveConfig(data), data.capturePermissions);

  if (!session) {
    analyzeButton.disabled = true;
    endButton.disabled = true;
    undoButton.disabled = true;
    mockTranscriptButton.disabled = true;
    mockTranscriptCard.classList.add("d-none");
    byId("session-meta").textContent = "No active session.";
    renderSourceMonitors(data.sourceMonitors);
    renderLiveMarkdown(data);
    return;
  }

  analyzeButton.disabled = false;
  endButton.disabled = false;
  undoButton.disabled = false;
  mockTranscriptButton.disabled = false;
  mockTranscriptCard.classList.toggle("d-none", session.sttProvider !== "mock");
  byId("session-meta").textContent = [
    `Started ${formatRelativeFromNow(session.startedAt)}`,
    `Status ${session.status}`,
    `${session.captureSources.length} source${session.captureSources.length === 1 ? "" : "s"}`,
    session.latestAnalysisAt ? `Last analysis ${formatRelativeFromNow(session.latestAnalysisAt)}` : null,
    session.lastError ? "Error present" : null
  ].filter(Boolean).join(" · ");
  fillMockSourceSelect(session);
  renderSourceMonitors(session.sourceMonitors);
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
  byId("capture-sources").addEventListener("change", async () => {
    markConfigDirty();
    renderSelectedSourcesSummary(state.configDraft.captureSources);
    try {
      await saveConfig({ captureSources: getSelectedCaptureSources() });
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
      state.dismissedPermissionSignature = null;
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
      byId("end-session").disabled = true;
      await requestJson("/api/session/end", { method: "POST", body: JSON.stringify({ status: "finished" }) });
      setTab("history");
      await loadState();
    } catch (error) {
      showError(error.message);
    } finally {
      byId("end-session").disabled = false;
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
        body: JSON.stringify({
          text: byId("mock-transcript").value,
          sourceId: byId("mock-source-id").value || null
        })
      });
      byId("mock-transcript").value = "";
      await loadState();
    } catch (error) {
      showError(error.message);
    }
  });

  byId("request-permissions").addEventListener("click", async () => {
    try {
      byId("request-permissions").disabled = true;
      state.dismissedPermissionSignature = null;
      const data = await requestJson("/api/permissions/request", { method: "POST" });
      state.data = data;
      renderConfig(data);
      renderLive(data);
      renderHistory(data.history, "history-list");
      renderHistory(data.resumableSessions, "resume-list", true);
      clearError();
    } catch (error) {
      showError(error.message);
    } finally {
      byId("request-permissions").disabled = false;
    }
  });

  byId("open-privacy-settings").addEventListener("click", async () => {
    try {
      byId("open-privacy-settings").disabled = true;
      await requestJson("/api/permissions/open-settings", { method: "POST" });
    } catch (error) {
      showError(error.message);
    } finally {
      byId("open-privacy-settings").disabled = false;
    }
  });

  byId("dismiss-permission-guidance").addEventListener("click", () => {
    const data = state.data;
    if (!data) {
      byId("permission-guidance").classList.add("d-none");
      return;
    }

    state.dismissedPermissionSignature = permissionSignature(effectiveConfig(data), data.capturePermissions);
    byId("permission-guidance").classList.add("d-none");
  });
}

bindEvents();
loadState().catch((error) => showError(error.message));
state.pollingHandle = setInterval(() => {
  loadState().catch((error) => showError(error.message));
}, state.pollingIntervalMs);
