import { blockData, blockTypes } from "./blocks.js";
import { agentStatus, clockTime, compactJSON, daemonAgents, escapeHTML, formatDuration, relativeTime } from "./lib.js";
import { icon } from "./icons.js";

const app = document.getElementById("app");
const feedLimit = 300;
const eventMemory = 1000;
const indexRefreshMs = 5000;
const agentRefreshMs = 5000;
const agentRefreshDebounceMs = 300;
const maxRetryMs = 15000;

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Hub-Source": "user" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) {
    const error = new Error(parsed?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

function topbar(titleMarkup = "", metaMarkup = "") {
  return `<header class="topbar">
    <a class="brand" href="/"><span class="brand-mark"><i></i><i></i><i></i></span><span class="brand-text">djt-hub</span></a>
    ${titleMarkup}
    <div class="topbar-meta">${metaMarkup}</div>
  </header>`;
}

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

function renderIndex() {
  document.title = "djt-hub";
  app.innerHTML = `${topbar("", `<span>${escapeHTML(location.host)}</span>`)}
    <main class="index">
      <div class="index-head">
        <h1>Hubs</h1>
        <label class="toggle"><input type="checkbox" data-archived> show archived</label>
      </div>
      <div data-list></div>
    </main>`;
  const list = app.querySelector("[data-list]");
  const archivedToggle = app.querySelector("[data-archived]");
  archivedToggle.checked = readPreference("djt-hub.showArchived") === "1";

  async function refresh() {
    try {
      const hubs = await request("GET", `/api/hubs${archivedToggle.checked ? "?all=1" : ""}`);
      list.innerHTML = hubs?.length ? `<div class="hub-list">${hubs.map((hub) => `
        <a class="hub-row" href="/h/${encodeURIComponent(hub.id)}">
          <span><span class="pill is-${escapeHTML(hub.status)}">${escapeHTML(hub.status)}</span></span>
          <span class="hub-row-title">${escapeHTML(hub.title || hub.id)}</span>
          <span class="hub-row-id">${escapeHTML(hub.id)}</span>
          <span class="hub-row-time" title="${escapeHTML(hub.updated_at)}">${relativeTime(hub.updated_at)}</span>
        </a>`).join("")}</div>`
        : `<div class="empty"><h2>No hubs yet</h2>Agents create hubs from the CLI.
            <pre>djt-hub create release-42 --title "Release 42"\ndjt-hub open release-42</pre></div>`;
    } catch (error) {
      list.innerHTML = `<div class="banner is-error">${icon("circleX")}Daemon unreachable: ${escapeHTML(error.message)}</div>`;
    }
  }

  archivedToggle.addEventListener("change", () => {
    writePreference("djt-hub.showArchived", archivedToggle.checked ? "1" : "0");
    refresh();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, indexRefreshMs);
  refresh();
}

function feedItemMarkup(event) {
  const sourceClass = event.source === "user" ? "is-user" : event.source.startsWith("svc:") ? "is-svc" : "";
  const payload = compactJSON(event.payload);
  return `<li class="feed-item" data-seq="${event.seq}">
    <div class="feed-line">
      <span class="source ${sourceClass}">${escapeHTML(event.source)}</span>
      <span class="feed-type${event.type.endsWith(".failed") ? " is-failed" : ""}">${escapeHTML(event.type)}</span>
      <span class="feed-time" title="#${event.seq}">${clockTime(event.ts)}</span>
    </div>
    ${payload ? `<div class="feed-payload">${escapeHTML(payload)}</div>` : ""}
  </li>`;
}

function agentChipMarkup(agents, attached, isOpen) {
  const statuses = agents.map((agent) => agentStatus(agent, attached));
  const tone = statuses.includes("running") ? "running" : statuses.includes("armed") ? "armed" : "standby";
  const agentLabel = agents.length === 1 ? escapeHTML(agents[0].name) : `${agents.length} agents`;
  return `<button class="agent-chip" type="button" aria-haspopup="true" aria-expanded="${isOpen}" title="Who answers this hub's events">
    <span class="agent-seg${attached ? " is-attached" : ""}"><i class="agent-dot"></i><span class="agent-label">${attached ? "attached" : "detached"}</span></span>
    ${agents.length ? `<span class="agent-seg is-${tone}">${icon("bot")}<span class="agent-label">${agentLabel}</span></span>` : ""}
  </button>`;
}

function agentLastRunMarkup(last) {
  if (!last) return `<span class="agent-last">no runs yet</span>`;
  const when = relativeTime(last.ts);
  if (last.type === "agent.failed") {
    const reason = escapeHTML(last.payload?.error ?? "failed");
    return `<span class="agent-last is-failed" title="${reason}">failed · ${reason} · ${when}</span>`;
  }
  const cost = Number(last.payload?.cost_usd ?? 0).toFixed(2);
  return `<span class="agent-last" title="event #${last.payload?.seq}">$${cost} · ${last.payload?.turns ?? 0} turns · ${when}</span>`;
}

function agentPanelMarkup(agents, attached) {
  const summary = attached
    ? "A CLI session is listening. Daemon agents stand by."
    : agents.length ? "No CLI session. Daemon agents answer matching events." : "No CLI session and no daemon agents. Clicks wait for the next session.";
  const rows = agents.map((agent) => {
    const status = agentStatus(agent, attached);
    const trigger = [agent.on, ...agent.match].join(" ");
    return `<div class="agent-row">
      <div class="agent-line"><span class="agent-name">${icon("bot")}${escapeHTML(agent.name)}</span>${agentLastRunMarkup(agent.last)}</div>
      <div class="agent-line"><span class="agent-trigger" title="${escapeHTML(trigger)}">on ${escapeHTML(trigger)}</span><span class="agent-status is-${status}">${status}</span></div>
    </div>`;
  }).join("");
  return `<div class="agent-pop-head">${summary}</div>${rows || `<div class="agent-pop-hint"><code>djt-hub agent add</code> puts Claude on call.</div>`}`;
}

function renderHub(hubId) {
  const view = { hub: null, blocks: [], state: {}, events: [], lastSeq: 0, panels: new Map() };
  const hubPath = `/api/hubs/${encodeURIComponent(hubId)}`;

  app.innerHTML = `${topbar(
    `<span class="topbar-sep"></span>
     <div class="topbar-title"><h1 data-title>${escapeHTML(hubId)}</h1><span class="topbar-id">${escapeHTML(hubId)}</span></div>`,
    `<div class="agents" data-agents></div><span data-status></span><span class="conn" data-conn>connecting</span><span data-seq>#0</span>`,
  )}
  <div class="hub-layout">
    <main class="hub-main"><div data-banner></div><div class="grid" data-grid></div></main>
    <aside class="rail">
      <div class="rail-head">${icon("activity")}Activity<span class="panel-meta" data-count></span></div>
      <ol class="feed" data-feed></ol>
    </aside>
  </div>`;
  const grid = app.querySelector("[data-grid]");
  const feed = app.querySelector("[data-feed]");
  const banner = app.querySelector("[data-banner]");
  const connection = app.querySelector("[data-conn]");
  const seqLabel = app.querySelector("[data-seq]");
  const agentsElement = app.querySelector("[data-agents]");
  const agentView = { attached: false, services: [], isOpen: false, refreshTimer: null, markup: "" };

  const isArchived = () => view.hub?.status === "archived";
  const context = () => ({
    hubId,
    state: view.state,
    events: view.events,
    archived: isArchived(),
    emit: (type, payload) => request("POST", `${hubPath}/events`, { type, payload }),
    patch: (path, value) => request("PATCH", `${hubPath}/state`, [{ path, value }]),
  });

  function setConnection(status) {
    connection.className = `conn is-${status}`;
    connection.textContent = status;
  }

  function renderHubMeta() {
    const title = view.hub?.title || hubId;
    document.title = `${title} · djt-hub`;
    app.querySelector("[data-title]").textContent = title;
    app.querySelector("[data-status]").innerHTML = view.hub
      ? `<span class="pill is-${escapeHTML(view.hub.status)}">${escapeHTML(view.hub.status)}</span>` : "";
    banner.innerHTML = isArchived()
      ? `<div class="banner">${icon("archive")}Archived. Read-only, services stopped.</div>` : "";
  }

  function createPanel(block) {
    const element = document.createElement("section");
    element.className = "panel";
    element.innerHTML = `<header class="panel-head"><h2 class="panel-title"></h2><span class="panel-meta"></span></header><div class="panel-body"></div>`;
    const body = element.querySelector(".panel-body");
    const meta = element.querySelector(".panel-meta");
    const panel = {
      element,
      type: block.type,
      renderedKey: null,
      instance: null,
      setMeta(text) {
        meta.textContent = text;
        meta.classList.remove("tone-bad");
      },
      showError(error) {
        meta.textContent = `error: ${error.message}`;
        meta.classList.add("tone-bad");
      },
    };
    const blockType = blockTypes[block.type];
    if (blockType) panel.instance = blockType.create(body, panel);
    else body.innerHTML = `<div class="panel-error">unknown block type "${escapeHTML(block.type)}"</div>`;
    return panel;
  }

  function flash(element) {
    element.classList.add("is-flash");
    requestAnimationFrame(() => requestAnimationFrame(() => element.classList.remove("is-flash")));
  }

  function updatePanel(panel, block) {
    const props = block.props ?? {};
    const blockType = blockTypes[block.type];
    const data = blockType ? blockData(blockType, props, view.state) : undefined;
    const renderKey = JSON.stringify([props, data, isArchived()]);
    if (renderKey === panel.renderedKey) return;
    const isFirstRender = panel.renderedKey === null;
    panel.renderedKey = renderKey;
    panel.element.dataset.width = props.width ?? "full";
    panel.element.querySelector(".panel-title").textContent = props.title ?? block.id;
    panel.instance?.update({ block, props, data, ctx: context() });
    if (!isFirstRender) flash(panel.element);
  }

  function updatePanels() {
    for (const block of view.blocks) updatePanel(view.panels.get(block.id), block);
  }

  function syncBlocks(blocks) {
    view.blocks = [...blocks].sort((left, right) => left.position - right.position);
    const liveIds = new Set();
    for (const block of view.blocks) {
      let panel = view.panels.get(block.id);
      if (panel && panel.type !== block.type) {
        panel.instance?.destroy?.();
        panel.element.remove();
        panel = null;
      }
      if (!panel) {
        panel = createPanel(block);
        view.panels.set(block.id, panel);
      }
      grid.append(panel.element);
      liveIds.add(block.id);
    }
    for (const [blockId, panel] of view.panels) {
      if (liveIds.has(blockId)) continue;
      panel.instance?.destroy?.();
      panel.element.remove();
      view.panels.delete(blockId);
    }
    grid.querySelector("[data-empty]")?.remove();
    if (!view.blocks.length) {
      grid.insertAdjacentHTML("beforeend", `<div class="panel empty" data-empty><h2>Empty hub</h2>Add blocks from the CLI.
        <pre>djt-hub block add ${escapeHTML(hubId)} '{"id":"intro","type":"markdown","text":"# Release"}'</pre></div>`);
    }
    updatePanels();
  }

  function onState(state) {
    view.state = state ?? {};
    updatePanels();
    for (const panel of view.panels.values()) panel.instance?.onState?.(view.state);
  }

  function renderFeedCount() {
    app.querySelector("[data-count]").textContent = view.events.length ? `${view.events.length}` : "";
    seqLabel.textContent = `#${view.lastSeq}`;
    if (!view.events.length && !feed.childElementCount) {
      feed.innerHTML = `<li class="empty">No events yet. User clicks, agent emits, and service events land here.</li>`;
    }
  }

  function recordEvent(event) {
    if (event.seq <= view.lastSeq) return false;
    view.lastSeq = event.seq;
    view.events.push(event);
    if (view.events.length > eventMemory) view.events.splice(0, view.events.length - eventMemory);
    feed.querySelector(".empty")?.remove();
    feed.insertAdjacentHTML("afterbegin", feedItemMarkup(event));
    while (feed.childElementCount > feedLimit) feed.lastElementChild.remove();
    return true;
  }

  function renderAgents() {
    const agents = daemonAgents(agentView.services, view.events);
    const markup = `${agentChipMarkup(agents, agentView.attached, agentView.isOpen)}
      <div class="agent-pop"${agentView.isOpen ? "" : " hidden"}>${agentPanelMarkup(agents, agentView.attached)}</div>`;
    // Polling rerenders often; skip unchanged markup so the chip keeps focus.
    if (markup === agentView.markup) return;
    agentView.markup = markup;
    agentsElement.innerHTML = markup;
  }

  async function refreshAgents() {
    try {
      const [snapshot, services] = await Promise.all([request("GET", hubPath), request("GET", `${hubPath}/services`)]);
      agentView.attached = Boolean(snapshot.attached);
      agentView.services = services ?? [];
      renderAgents();
    } catch { /* the connection badge already shows daemon trouble */ }
  }

  function scheduleAgentRefresh() {
    clearTimeout(agentView.refreshTimer);
    agentView.refreshTimer = setTimeout(refreshAgents, agentRefreshDebounceMs);
  }

  agentsElement.addEventListener("click", (clickEvent) => {
    if (!clickEvent.target.closest(".agent-chip")) return;
    agentView.isOpen = !agentView.isOpen;
    renderAgents();
  });
  document.addEventListener("click", (clickEvent) => {
    // composedPath, not contains: the chip's own click rerenders and detaches the target.
    if (!agentView.isOpen || clickEvent.composedPath().includes(agentsElement)) return;
    agentView.isOpen = false;
    renderAgents();
  });
  document.addEventListener("keydown", (keyEvent) => {
    if (keyEvent.key !== "Escape" || !agentView.isOpen) return;
    agentView.isOpen = false;
    renderAgents();
    agentsElement.querySelector(".agent-chip")?.focus();
  });

  function onEvent(event) {
    if (!recordEvent(event)) return;
    renderFeedCount();
    if (event.type.startsWith("svc.") || event.type.startsWith("agent.")) {
      renderAgents();
      scheduleAgentRefresh();
    }
    for (const panel of view.panels.values()) panel.instance?.onEvent?.(event);
  }

  feed.addEventListener("click", (clickEvent) => {
    const item = clickEvent.target.closest(".feed-item");
    const payloadElement = item?.querySelector(".feed-payload");
    if (!payloadElement) return;
    const event = view.events.find((candidate) => String(candidate.seq) === item.dataset.seq);
    const isOpen = item.classList.toggle("is-open");
    payloadElement.textContent = isOpen ? JSON.stringify(event?.payload, null, 2) : compactJSON(event?.payload);
  });

  async function loadSnapshot() {
    const snapshot = await request("GET", hubPath);
    view.hub = snapshot.hub;
    view.state = snapshot.state ?? {};
    renderHubMeta();
    syncBlocks(snapshot.blocks ?? []);
    return snapshot.last_seq ?? 0;
  }

  let retryMs = 1000;
  function connect() {
    const stream = new EventSource(`${hubPath}/stream?since=${view.lastSeq}`);
    stream.onopen = () => {
      retryMs = 1000;
      setConnection("live");
      loadSnapshot().catch(() => {});
    };
    stream.addEventListener("event", (message) => onEvent(JSON.parse(message.data)));
    stream.addEventListener("blocks", (message) => syncBlocks(JSON.parse(message.data) ?? []));
    stream.addEventListener("state", (message) => onState(JSON.parse(message.data)));
    stream.addEventListener("hub", (message) => {
      view.hub = JSON.parse(message.data);
      renderHubMeta();
      updatePanels();
    });
    stream.onerror = () => {
      stream.close();
      setConnection("reconnecting");
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    };
  }

  async function start() {
    try {
      const snapshot = await request("GET", hubPath);
      const backlog = await request("GET", `${hubPath}/events?since=${Math.max(0, snapshot.last_seq - feedLimit)}&limit=${feedLimit}`);
      for (const event of backlog ?? []) recordEvent(event);
      view.lastSeq = Math.max(view.lastSeq, snapshot.last_seq ?? 0);
      view.hub = snapshot.hub;
      view.state = snapshot.state ?? {};
      renderHubMeta();
      syncBlocks(snapshot.blocks ?? []);
      renderFeedCount();
      agentView.attached = Boolean(snapshot.attached);
      refreshAgents();
      connect();
    } catch (error) {
      setConnection("offline");
      grid.innerHTML = error.status === 404
        ? `<div class="panel empty"><h2>No hub "${escapeHTML(hubId)}"</h2><a href="/">Back to all hubs</a></div>`
        : `<div class="panel banner is-error">${icon("circleX")}Daemon unreachable: ${escapeHTML(error.message)}</div>`;
    }
  }

  setInterval(() => { if (!document.hidden && !isArchived()) refreshAgents(); }, agentRefreshMs);

  setInterval(() => {
    if (document.hidden) return;
    for (const element of document.querySelectorAll("[data-since]")) {
      element.textContent = formatDuration(Date.now() - Number(element.dataset.since));
    }
  }, 1000);

  start();
}

const hubRoute = location.pathname.match(/^\/h\/([^/]+)/);
if (hubRoute) renderHub(decodeURIComponent(hubRoute[1]));
else renderIndex();
