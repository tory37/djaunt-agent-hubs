// Runs inside sandboxed html blocks (opaque origin). It gives block authors
// window.hub: state, get(path), on("state"|"event", fn), emit(type, payload),
// patch(path, value). The parent page relays emit/patch to the daemon.
export const frameSDK = `(() => {
  const listeners = { state: [], event: [] };
  const post = (message) => parent.postMessage(Object.assign({ djtHub: true }, message), "*");
  const hub = {
    id: null, state: {}, archived: false, ready: false,
    get(path) {
      let current = hub.state;
      for (const segment of String(path || "").split(".").filter(Boolean)) {
        if (current === null || typeof current !== "object") return undefined;
        current = Array.isArray(current)
          ? (/^\\d+$/.test(segment) ? current[Number(segment)] : current.find((element) => element && element.id === segment))
          : current[segment];
      }
      return current;
    },
    on(kind, listener) {
      (listeners[kind] = listeners[kind] || []).push(listener);
      if (kind === "state" && hub.ready) listener(hub.state);
      return () => { listeners[kind] = listeners[kind].filter((existing) => existing !== listener); };
    },
    emit(type, payload) { post({ kind: "emit", type, payload }); },
    patch(path, value) { post({ kind: "patch", path, value }); },
  };
  addEventListener("message", (message) => {
    const data = message.data;
    if (message.source !== parent || !data || !data.djtHub) return;
    if (data.kind === "init") { hub.id = data.hubId; hub.archived = data.archived; hub.ready = true; }
    if (data.kind === "init" || data.kind === "state") {
      hub.state = data.state;
      listeners.state.forEach((listener) => listener(hub.state));
    }
    if (data.kind === "event") listeners.event.forEach((listener) => listener(data.event));
  });
  window.hub = hub;
  const reportHeight = () => post({ kind: "height", height: document.documentElement.scrollHeight });
  addEventListener("DOMContentLoaded", () => {
    new ResizeObserver(reportHeight).observe(document.body);
    post({ kind: "ready" });
  });
})();`;

export const frameCSS = `:root{--bg:#0b0b0c;--surface:#111113;--surface-2:#17171a;--border:#26262b;--text:#e8e6e3;--text-muted:#9a9aa3;--accent:#ffb224;--run:#6cb6ff;--ok:#3fb950;--bad:#f85149;--mono:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color-scheme:dark}
html,body{margin:0;background:var(--surface);color:var(--text);font:13px/1.5 Inter,ui-sans-serif,-apple-system,system-ui,sans-serif}
body{padding:12px}`;
