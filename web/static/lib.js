// Pure helpers shared by the UI and the node tests in web/test.

export function escapeHTML(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// getPath mirrors internal/state: a segment indexes an array numerically or
// matches an element's "id".
export function getPath(documentValue, path) {
  if (!path) return documentValue;
  let current = documentValue;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      current = index >= 0 ? current[index] : current.find((element) => element && element.id === segment);
    } else {
      current = current[segment];
    }
  }
  return current;
}

const safeLink = /^(https?:|mailto:|\/|#)/i;

function renderInline(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((segment) => {
      if (segment.startsWith("`") && segment.endsWith("`") && segment.length > 1) {
        return `<code>${escapeHTML(segment.slice(1, -1))}</code>`;
      }
      return escapeHTML(segment)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])[*_]([^*_]+)[*_](?=[^*\w]|$)/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
          const decodedHref = href.replaceAll("&amp;", "&");
          if (!safeLink.test(decodedHref)) return label;
          return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
        });
    })
    .join("");
}

// renderMarkdown covers what agents write in runbooks: headings, paragraphs,
// lists, quotes, fences, inline code, bold, italic, links. Input is escaped
// before any markup is added.
export function renderMarkdown(source) {
  const lines = String(source ?? "").replaceAll("\r\n", "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listTag = null;

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listTag) html.push(`</${listTag}>`);
    listTag = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^```(\S*)/);
    if (fence) {
      flushParagraph();
      closeList();
      const body = [];
      for (index++; index < lines.length && !lines[index].startsWith("```"); index++) body.push(lines[index]);
      html.push(`<pre><code>${escapeHTML(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (listTag !== tag) {
        closeList();
        html.push(`<${tag}>`);
        listTag = tag;
      }
      html.push(`<li>${renderInline((bullet || numbered)[1])}</li>`);
    } else if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
    } else if (line.trim() === "") {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  closeList();
  return html.join("");
}

export function compactJSON(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function clockTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour12: false });
}

export function toMillis(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return value < 1e11 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function relativeTime(timestamp, now = Date.now()) {
  const elapsed = now - new Date(timestamp).getTime();
  if (Number.isNaN(elapsed)) return "";
  if (elapsed < 45_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
  return `${Math.round(elapsed / 86_400_000)}d ago`;
}

const agentMarker = "DJT_AGENT_BUDGET";

// daemonAgents picks the agent services and pairs each with its latest
// agent.done or agent.failed event.
export function daemonAgents(services, events) {
  return (services ?? []).filter((service) => service.env && agentMarker in service.env).map((service) => {
    const source = `svc:${service.name}`;
    const last = events.findLast((event) => event.source === source && event.type.startsWith("agent.")) ?? null;
    return { name: service.name, on: service.on, match: service.match ?? [], state: service.state, last };
  });
}

// agentStatus says what a daemon agent does with the next matching event. An
// attached CLI session takes events, so armed agents stand by.
export function agentStatus(agent, attached) {
  if (agent.state === "running" || agent.state === "starting") return "running";
  if (agent.state === "stopped") return "off";
  return attached ? "standby" : "armed";
}

// chartSeries normalizes the two accepted chart shapes into uPlot columns:
// {x:[...], series:[{label, values}]} or rows [{x, a, b}] keyed by xKey.
export function chartSeries(chartData, xKey = "x") {
  if (Array.isArray(chartData)) {
    const labels = [];
    for (const row of chartData) {
      for (const key of Object.keys(row ?? {})) if (key !== xKey && !labels.includes(key)) labels.push(key);
    }
    return {
      x: chartData.map((row) => row?.[xKey]),
      series: labels.map((label) => ({ label, values: chartData.map((row) => row?.[label] ?? null) })),
    };
  }
  if (chartData && Array.isArray(chartData.x)) {
    return { x: chartData.x, series: (chartData.series ?? []).map((series, index) => ({
      label: series.label ?? `series ${index + 1}`,
      values: series.values ?? [],
      color: series.color,
    })) };
  }
  return { x: [], series: [] };
}

// statTiles accepts an array of tiles or an object of label → value.
export function statTiles(statsData) {
  if (Array.isArray(statsData)) return statsData.filter(Boolean);
  if (statsData && typeof statsData === "object") {
    return Object.entries(statsData).map(([label, value]) =>
      value && typeof value === "object" ? { label, ...value } : { label, value });
  }
  return [];
}
