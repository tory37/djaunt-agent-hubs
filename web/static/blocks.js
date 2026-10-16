import { chartSeries, clockTime, compactJSON, escapeHTML, formatDuration, getPath, renderMarkdown, statTiles, toMillis } from "./lib.js";
import { frameCSS, frameSDK } from "./frame.js";
import { icon, statusIcons } from "./icons.js";

// Each block type names the prop that holds its data when it has no "bind",
// and a create(body, panel) that returns { update(view), onEvent?, onState?, destroy? }.
// view = { block, props, data, ctx }; ctx carries hubId, state, events,
// archived, emit(type, payload), patch(path, value).

const closedStatuses = new Set(["done", "failed", "skipped"]);
const palette = ["#ffb224", "#6cb6ff", "#3fb950", "#f85149", "#c297ff", "#e8e6e3"];

function lastEventFor(events, types, matches) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!types.includes(event.type)) continue;
    const payload = event.payload ?? {};
    if (Object.entries(matches).every(([key, value]) => payload[key] === value)) return event;
  }
  return null;
}

function itemKey(item, index) {
  return item?.id !== undefined ? String(item.id) : String(index);
}

function setHeight(element, height) {
  if (height) element.style.setProperty("--h", typeof height === "number" ? `${height}px` : height);
}

function emptyNote(text) {
  return `<div class="chart-empty">${escapeHTML(text)}</div>`;
}

function stepTime(item) {
  const started = toMillis(item.started_at);
  const ended = toMillis(item.ended_at);
  if (started && ended) return escapeHTML(formatDuration(ended - started));
  if (started && item.status === "running") return `<span data-since="${started}">${formatDuration(Date.now() - started)}</span>`;
  return escapeHTML(item.time ?? "");
}

function createSteps(body, panel) {
  body.classList.add("is-flush");
  const sentGates = new Map();
  let view = null;

  body.addEventListener("click", async (clickEvent) => {
    const button = clickEvent.target.closest("[data-gate]");
    if (!button || view.ctx.archived) return;
    const stepKey = button.dataset.step;
    const decision = button.dataset.gate;
    const item = (view.data ?? []).find((candidate, index) => itemKey(candidate, index) === stepKey);
    const note = body.querySelector(`[data-note="${CSS.escape(stepKey)}"]`)?.value.trim();
    sentGates.set(stepKey, { decision, status: item?.status, at: Date.now() });
    render();
    const payload = { block: view.block.id, step: stepKey };
    if (note) payload.note = note;
    try {
      await view.ctx.emit(`gate.${decision}`, payload);
    } catch (error) {
      sentGates.delete(stepKey);
      render();
      panel.showError(error);
    }
  });

  function gateMarkup(item, stepKey) {
    const gate = typeof item.gate === "object" ? item.gate : {};
    const prompt = typeof item.gate === "string" ? item.gate : gate.prompt ?? "Approval required";
    const sent = sentGates.get(stepKey);
    if (sent && sent.status === item.status) {
      const verb = sent.decision === "approve" ? "Approved" : "Rejected";
      return `<div class="gate"><span class="gate-sent">${verb} ${clockTime(sent.at)} · waiting for agent</span></div>`;
    }
    sentGates.delete(stepKey);
    const last = lastEventFor(view.ctx.events, ["gate.approve", "gate.reject"], { block: view.block.id, step: stepKey });
    const lastNote = last ? `<span class="gate-sent">last: ${last.type.slice(5)}d ${clockTime(last.ts)}</span>` : "";
    const disabled = view.ctx.archived ? "disabled" : "";
    return `<div class="gate">
      <span class="gate-prompt">${escapeHTML(prompt)}</span>
      <input class="input" data-note="${escapeHTML(stepKey)}" placeholder="Note for the agent (optional)" ${disabled}>
      <button class="btn is-primary" data-gate="approve" data-step="${escapeHTML(stepKey)}" ${disabled}>${icon("check")}${escapeHTML(gate.approve ?? "Approve")}</button>
      <button class="btn is-danger" data-gate="reject" data-step="${escapeHTML(stepKey)}" ${disabled}>${icon("x")}${escapeHTML(gate.reject ?? "Reject")}</button>
      ${lastNote}
    </div>`;
  }

  function render() {
    const items = Array.isArray(view.data) ? view.data : [];
    const notes = new Map([...body.querySelectorAll("[data-note]")].map((input) => [input.dataset.note, input.value]));
    const focusedNote = document.activeElement?.dataset?.note;
    const doneCount = items.filter((item) => item?.status === "done").length;
    panel.setMeta(items.length ? `${doneCount}/${items.length}` : "");
    body.innerHTML = items.length ? `<ol class="steps">${items.map((item, index) => {
      const status = statusIcons[item?.status] ? item.status : "pending";
      const stepKey = itemKey(item, index);
      const showGate = item?.gate && status === "waiting";
      const gateTag = item?.gate && !showGate && !closedStatuses.has(status) ? '<span class="step-gate-tag">gate</span>' : "";
      return `<li class="step" data-status="${status}">
        <div class="step-row">
          ${icon(statusIcons[status], "step-icon")}
          <span class="step-num">${String(index + 1).padStart(2, "0")}</span>
          <div>
            <div class="step-label">${escapeHTML(item?.label ?? item?.id ?? "")}${gateTag}</div>
            ${item?.detail ? `<div class="step-detail">${escapeHTML(item.detail)}</div>` : ""}
          </div>
          <span class="step-time">${stepTime(item ?? {})}</span>
        </div>
        ${showGate ? gateMarkup(item, stepKey) : ""}
      </li>`;
    }).join("")}</ol>` : emptyNote("No steps yet");
    for (const input of body.querySelectorAll("[data-note]")) {
      if (notes.has(input.dataset.note)) input.value = notes.get(input.dataset.note);
      if (input.dataset.note === focusedNote) input.focus();
    }
  }

  return {
    update(nextView) { view = nextView; render(); },
    onEvent(event) { if (event.type.startsWith("gate.")) render(); },
  };
}

function createChecklist(body, panel) {
  body.classList.add("is-flush");
  const overrides = new Map();
  let view = null;

  body.addEventListener("click", async (clickEvent) => {
    const button = clickEvent.target.closest("[data-item]");
    if (!button || view.ctx.archived) return;
    const key = button.dataset.item;
    const done = button.dataset.done !== "true";
    overrides.set(key, done);
    render();
    try {
      await view.ctx.emit("checklist.toggle", { block: view.block.id, item: key, done });
      if (view.props.bind) await view.ctx.patch(`${view.props.bind}.${key}.done`, done);
    } catch (error) {
      overrides.delete(key);
      render();
      panel.showError(error);
    }
  });

  function render() {
    const items = Array.isArray(view.data) ? view.data : [];
    const rows = items.map((item, index) => {
      const key = itemKey(item, index);
      if (overrides.get(key) === Boolean(item?.done)) overrides.delete(key);
      return { item, key, done: overrides.has(key) ? overrides.get(key) : Boolean(item?.done) };
    });
    panel.setMeta(rows.length ? `${rows.filter((row) => row.done).length}/${rows.length}` : "");
    const disabled = view.ctx.archived ? "disabled" : "";
    body.innerHTML = rows.length ? `<ul class="checklist">${rows.map(({ item, key, done }) => `<li>
      <button class="check ${done ? "is-done" : ""}" data-item="${escapeHTML(key)}" data-done="${done}" ${disabled}>
        ${icon(done ? "squareCheck" : "square")}
        <span><span class="check-label">${escapeHTML(item?.label ?? key)}</span>
        ${item?.note ? `<span class="check-note">${escapeHTML(item.note)}</span>` : ""}</span>
      </button></li>`).join("")}</ul>` : emptyNote("No items yet");
  }

  return { update(nextView) { view = nextView; render(); } };
}

function createStats(body) {
  body.classList.add("is-flush");
  return {
    update({ data }) {
      const tiles = statTiles(data);
      body.innerHTML = tiles.length ? `<div class="stats">${tiles.map((tile) => {
        const tone = tile.tone ? `tone-${escapeHTML(tile.tone)}` : "";
        const value = tile.value === undefined || tile.value === null ? "—" : tile.value;
        return `<div class="stat">
          <div class="stat-label" title="${escapeHTML(tile.label ?? "")}">${escapeHTML(tile.label ?? "")}</div>
          <div class="stat-value ${tone}">${escapeHTML(value)}${tile.unit ? `<span class="stat-unit">${escapeHTML(tile.unit)}</span>` : ""}</div>
          ${tile.hint ?? tile.delta ? `<div class="stat-hint">${escapeHTML(tile.hint ?? tile.delta)}</div>` : ""}
        </div>`;
      }).join("")}</div>` : emptyNote("No stats yet");
    },
  };
}

function tableCell(value, column) {
  if (column.kind === "status" && typeof value === "string") {
    const status = statusIcons[value] ? value : "pending";
    const tone = { done: "tone-ok", failed: "tone-bad", running: "tone-info", waiting: "tone-warn" }[status] ?? "faint";
    return `<span class="status-tag ${tone}">${icon(statusIcons[status])}${escapeHTML(value)}</span>`;
  }
  if (value === undefined || value === null || value === "") return '<span class="faint">—</span>';
  return escapeHTML(compactJSON(value));
}

function createTable(body) {
  body.classList.add("is-flush");
  return {
    update({ props, data }) {
      const rows = Array.isArray(data) ? data : [];
      const columns = (props.columns ?? Object.keys(rows[0] ?? {})).map((column) =>
        typeof column === "string" ? { key: column, label: column } : { label: column.key, ...column });
      setHeight(body, props.height);
      if (!rows.length) {
        body.innerHTML = emptyNote("No rows yet");
        return;
      }
      const numeric = columns.map((column) => column.align === "right" || rows.every((row) => row?.[column.key] == null || typeof row[column.key] === "number"));
      body.innerHTML = `<div class="table-wrap"><table class="table">
        <thead><tr>${columns.map((column, index) => `<th class="${numeric[index] ? "is-num" : ""}">${escapeHTML(column.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${columns.map((column, index) =>
          `<td class="${numeric[index] ? "is-num" : ""}">${tableCell(row?.[column.key], column)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>`;
    },
  };
}

let uPlotLoading = null;
function loadUPlot() {
  uPlotLoading ??= new Promise((resolve, reject) => {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/vendor/uPlot.min.css";
    document.head.append(stylesheet);
    const script = document.createElement("script");
    script.src = "/vendor/uPlot.iife.min.js";
    script.onload = () => resolve(window.uPlot);
    script.onerror = () => reject(new Error("could not load uPlot"));
    document.head.append(script);
  });
  return uPlotLoading;
}

function createChart(body, panel) {
  const container = document.createElement("div");
  container.className = "chart";
  body.append(container);
  let plot = null;
  let shapeKey = "";
  let latest = null;

  const resize = new ResizeObserver(() => {
    if (plot) plot.setSize({ width: container.clientWidth, height: plot.height });
  });
  resize.observe(container);

  async function draw() {
    const requested = latest;
    const { props, data } = requested;
    const uPlot = await loadUPlot();
    if (latest !== requested) return;
    const { x, series } = chartSeries(data, props.x);
    if (!x.length || !series.length) {
      plot?.destroy();
      plot = null;
      shapeKey = "";
      container.innerHTML = emptyNote("No data yet");
      return;
    }
    const categories = x.some((value) => typeof value !== "number") ? x : null;
    const isTime = props.time === true && !categories;
    const xValues = categories ? x.map((_, index) => index) : isTime ? x.map((value) => (value > 1e11 ? value / 1000 : value)) : x;
    const columns = [xValues, ...series.map((entry) => entry.values)];
    const nextShapeKey = JSON.stringify([props.kind, props.height, isTime, categories, series.map((entry) => [entry.label, entry.color])]);
    if (plot && nextShapeKey === shapeKey) {
      plot.setData(columns);
      return;
    }
    plot?.destroy();
    container.innerHTML = "";
    shapeKey = nextShapeKey;
    const axis = {
      stroke: "#9a9aa3",
      font: '11px "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
      grid: { stroke: "#26262b", width: 1 },
      ticks: { stroke: "#26262b", width: 1 },
    };
    plot = new uPlot({
      width: container.clientWidth || 600,
      height: props.height ?? 220,
      scales: { x: { time: isTime, ...(categories ? { distr: 2 } : {}) } },
      cursor: { points: { size: 6 } },
      axes: [
        { ...axis, ...(categories ? { values: (_, splits) => splits.map((index) => categories[index] ?? "") } : {}) },
        { ...axis, label: props.y_label },
      ],
      series: [
        { label: props.x_label ?? (isTime ? "time" : "x") },
        ...series.map((entry, index) => {
          const color = entry.color ?? palette[index % palette.length];
          return {
            label: entry.label,
            stroke: color,
            width: 1.5,
            fill: props.kind === "area" ? `${color}1f` : props.kind === "bar" ? `${color}cc` : undefined,
            paths: props.kind === "bar" ? uPlot.paths.bars({ size: [0.6, 48] }) : undefined,
            points: { show: false },
          };
        }),
      ],
    }, columns, container);
  }

  return {
    update(view) {
      latest = view;
      draw().catch((error) => panel.showError(error));
    },
    destroy() {
      resize.disconnect();
      plot?.destroy();
    },
  };
}

function logLineMarkup(line) {
  const entry = typeof line === "object" && line !== null ? line : { text: line };
  const level = String(entry.level ?? "").toLowerCase();
  const tone = String(entry.tone ?? level);
  const levelClass = tone.startsWith("warn") ? "is-warn" : tone.startsWith("err") || tone === "fatal" ? "is-error" : "";
  return `<div class="log-line ${levelClass}">
    ${entry.ts ? `<span class="log-ts">${escapeHTML(clockTime(toMillis(entry.ts)))}</span>` : ""}
    ${entry.level ? `<span class="log-level">${escapeHTML(entry.level)}</span>` : ""}
    <span class="log-text">${escapeHTML(compactJSON(entry.text ?? ""))}</span>
  </div>`;
}

function eventAsLogLine(event) {
  const failed = /error|fail/.test(event.type);
  return { ts: event.ts, tone: failed ? "error" : "", text: `${event.source}  ${event.type}  ${compactJSON(event.payload)}` };
}

function createLog(body) {
  body.classList.add("is-flush");
  const scroller = document.createElement("div");
  scroller.className = "log";
  body.append(scroller);
  let view = null;

  const eventFilter = () => {
    const prefix = view.props.events;
    return (event) => prefix === "*" || prefix === true || event.type.startsWith(prefix);
  };
  const maxLines = () => view.props.max ?? 500;
  const isPinnedToBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;

  function render(lines) {
    const pinned = isPinnedToBottom();
    scroller.innerHTML = lines.slice(-maxLines()).map(logLineMarkup).join("") || '<div class="faint">No output yet</div>';
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
  }

  return {
    update(nextView) {
      view = nextView;
      setHeight(scroller, view.props.height);
      if (view.props.events) {
        render(view.ctx.events.filter(eventFilter()).map(eventAsLogLine));
      } else {
        render(Array.isArray(view.data) ? view.data : typeof view.data === "string" ? view.data.split("\n") : []);
      }
    },
    onEvent(event) {
      if (!view?.props.events || !eventFilter()(event)) return;
      const pinned = isPinnedToBottom();
      scroller.querySelector(".faint")?.remove();
      scroller.insertAdjacentHTML("beforeend", logLineMarkup(eventAsLogLine(event)));
      while (scroller.childElementCount > maxLines()) scroller.firstElementChild.remove();
      if (pinned) scroller.scrollTop = scroller.scrollHeight;
    },
  };
}

function createActions(body, panel) {
  let view = null;
  const confirming = new Map();

  body.addEventListener("click", async (clickEvent) => {
    const button = clickEvent.target.closest("[data-action]");
    if (!button || view.ctx.archived) return;
    const actionId = button.dataset.action;
    const action = (view.data ?? []).find((candidate, index) => itemKey(candidate, index) === actionId) ?? {};
    if (action.confirm && !confirming.has(actionId)) {
      confirming.set(actionId, setTimeout(() => { confirming.delete(actionId); render(); }, 4000));
      render();
      return;
    }
    clearTimeout(confirming.get(actionId));
    confirming.delete(actionId);
    button.disabled = true;
    button.textContent = "Sent";
    try {
      await view.ctx.emit("action", { block: view.block.id, action: actionId });
      setTimeout(render, 1500);
    } catch (error) {
      render();
      panel.showError(error);
    }
  });

  function render() {
    const actions = Array.isArray(view.data) ? view.data : [];
    body.innerHTML = `<div class="actions">${actions.map((action, index) => {
      const actionId = itemKey(action, index);
      const isConfirming = confirming.has(actionId);
      const tone = isConfirming ? "is-confirming" : action.tone === "primary" ? "is-primary" : action.tone === "danger" ? "is-danger" : "";
      const label = isConfirming ? (typeof action.confirm === "string" ? action.confirm : `Confirm ${action.label ?? actionId}?`) : action.label ?? actionId;
      const disabled = view.ctx.archived || action.disabled ? "disabled" : "";
      return `<button class="btn ${tone}" data-action="${escapeHTML(actionId)}" ${disabled}>${escapeHTML(label)}</button>`;
    }).join("")}${view.props.hint ? `<div class="action-hint">${escapeHTML(view.props.hint)}</div>` : ""}</div>`;
  }

  return { update(nextView) { view = nextView; render(); } };
}

function fieldMarkup(field) {
  const name = escapeHTML(field.name);
  const label = escapeHTML(field.label ?? field.name);
  const required = field.required ? "required" : "";
  const placeholder = field.placeholder ? `placeholder="${escapeHTML(field.placeholder)}"` : "";
  const value = field.value ?? "";
  switch (field.kind) {
    case "textarea":
      return `<label class="field"><span class="field-label">${label}</span><textarea class="input" name="${name}" ${required} ${placeholder}>${escapeHTML(value)}</textarea></label>`;
    case "select":
      return `<label class="field"><span class="field-label">${label}</span><select class="input" name="${name}" ${required}>${(field.options ?? []).map((option) => {
        const optionValue = typeof option === "object" ? option.value : option;
        const optionLabel = typeof option === "object" ? option.label ?? option.value : option;
        return `<option value="${escapeHTML(optionValue)}" ${optionValue === value ? "selected" : ""}>${escapeHTML(optionLabel)}</option>`;
      }).join("")}</select></label>`;
    case "checkbox":
      return `<label class="field-check"><input type="checkbox" name="${name}" ${value ? "checked" : ""}><span>${label}</span></label>`;
    default: {
      const inputType = field.kind === "number" ? "number" : "text";
      return `<label class="field"><span class="field-label">${label}</span><input class="input" type="${inputType}" name="${name}" value="${escapeHTML(value)}" ${required} ${placeholder}></label>`;
    }
  }
}

function createForm(body, panel) {
  const form = document.createElement("form");
  form.className = "form";
  body.append(form);
  let view = null;
  let fieldsKey = "";
  let sending = false;

  form.addEventListener("submit", async (submitEvent) => {
    submitEvent.preventDefault();
    if (view.ctx.archived || sending) return;
    const values = {};
    for (const field of view.data ?? []) {
      const input = form.elements.namedItem(field.name);
      if (!input) continue;
      if (field.kind === "checkbox") values[field.name] = input.checked;
      else if (field.kind === "number") values[field.name] = input.value === "" ? null : Number(input.value);
      else values[field.name] = input.value;
    }
    sending = true;
    renderStatus();
    try {
      await view.ctx.emit("form.submit", { block: view.block.id, values });
    } catch (error) {
      panel.showError(error);
    } finally {
      sending = false;
      renderStatus();
    }
  });

  function renderStatus() {
    const submitted = lastEventFor(view.ctx.events, ["form.submit"], { block: view.block.id });
    const locked = view.ctx.archived || sending || (submitted && !view.props.repeatable);
    for (const element of form.elements) element.disabled = Boolean(locked);
    const status = form.querySelector(".form-status");
    status.textContent = sending ? "Sending…" : submitted ? `Submitted ${clockTime(submitted.ts)}` : "";
  }

  return {
    update(nextView) {
      view = nextView;
      const fields = Array.isArray(view.data) ? view.data.filter((field) => field?.name) : [];
      const nextFieldsKey = JSON.stringify([fields, view.props.submit]);
      if (nextFieldsKey !== fieldsKey) {
        fieldsKey = nextFieldsKey;
        form.innerHTML = `${fields.map(fieldMarkup).join("")}
          <div class="form-foot"><button class="btn is-primary" type="submit">${icon("send")}${escapeHTML(view.props.submit ?? "Submit")}</button><span class="form-status"></span></div>`;
      }
      renderStatus();
    },
    onEvent(event) { if (event.type === "form.submit") renderStatus(); },
  };
}

function createFrame(body, panel) {
  body.classList.add("is-flush");
  const frame = document.createElement("iframe");
  frame.className = "frame";
  frame.sandbox = "allow-scripts allow-forms";
  body.append(frame);
  let view = null;
  let html = null;

  const post = (message) => frame.contentWindow?.postMessage({ djtHub: true, ...message }, "*");
  const onMessage = (message) => {
    if (message.source !== frame.contentWindow || !message.data?.djtHub) return;
    const data = message.data;
    if (data.kind === "ready") post({ kind: "init", hubId: view.ctx.hubId, archived: view.ctx.archived, state: view.ctx.state });
    if (data.kind === "height" && !view.props.height) setHeight(frame, Math.min(Math.max(Number(data.height) || 0, 40), 2000));
    if (view.ctx.archived) return;
    if (data.kind === "emit" && typeof data.type === "string") view.ctx.emit(data.type, data.payload).catch((error) => panel.showError(error));
    if (data.kind === "patch" && typeof data.path === "string") view.ctx.patch(data.path, data.value).catch((error) => panel.showError(error));
  };
  window.addEventListener("message", onMessage);

  return {
    update(nextView) {
      view = nextView;
      setHeight(frame, view.props.height);
      const nextHTML = typeof view.data === "string" ? view.data : "";
      if (nextHTML !== html) {
        html = nextHTML;
        frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${frameCSS}</style><script>${frameSDK}<\/script></head><body>${html}</body></html>`;
      }
    },
    onState(state) { post({ kind: "state", state }); },
    onEvent(event) { post({ kind: "event", event }); },
    destroy() { window.removeEventListener("message", onMessage); },
  };
}

function createMarkdown(body) {
  return {
    update({ data }) {
      body.innerHTML = `<div class="md">${renderMarkdown(typeof data === "string" ? data : compactJSON(data))}</div>`;
    },
  };
}

export const blockTypes = {
  markdown: { dataProp: "text", create: createMarkdown },
  steps: { dataProp: "items", create: createSteps },
  checklist: { dataProp: "items", create: createChecklist },
  stats: { dataProp: "items", create: createStats },
  table: { dataProp: "rows", create: createTable },
  chart: { dataProp: "data", create: createChart },
  log: { dataProp: "lines", create: createLog },
  actions: { dataProp: "items", create: createActions },
  form: { dataProp: "fields", create: createForm },
  html: { dataProp: "html", create: createFrame },
};

export function blockData(blockType, props, state) {
  return props.bind ? getPath(state, props.bind) : props[blockType.dataProp];
}
