import { Component, useEffect, useState, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import type { ErrorPayload } from "vite";
import { HubProvider, useHub } from "../../sdk/hub-context.tsx";
import { AttachChip, CopyCommand, Notice, TopBar, type AttachStatus } from "./chrome.tsx";

const BROKEN_VIEW_RETRY_MS = 1_500;

let lastReportedViewError: string | null = null;

function reportViewError(hubId: string, error: string | null): void {
  if (error === lastReportedViewError) return;
  lastReportedViewError = error;
  void fetch(`/api/hubs/${hubId}/view-error`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error }),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error);
}

// A failed dynamic import only says "Failed to fetch"; the server sends the
// compiler's message as the response body.
async function compileErrorText(viewUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(viewUrl);
    return response.ok ? undefined : await response.text();
  } catch {
    return undefined;
  }
}

// Loads the agent's view.tsx through Vite. While it fails to compile, retry on
// a timer: a module that never loaded gets no hot update when it is fixed.
function useHubView(hubId: string, viewPath: string | undefined) {
  const [View, setView] = useState<ComponentType>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!viewPath) return;
    const cacheBust = attempt === 0 ? "" : `?t=${Date.now()}`;
    const viewUrl = `/@fs${viewPath}${cacheBust}`;
    import(/* @vite-ignore */ viewUrl)
      .then((module: { default?: ComponentType }) => {
        if (typeof module.default !== "function") throw new Error("view.tsx must `export default` a component");
        setView(() => module.default);
        setLoadError(undefined);
        reportViewError(hubId, null);
      })
      .catch(async (error: unknown) => {
        const message = (await compileErrorText(viewUrl)) ?? errorText(error);
        setLoadError(message);
        reportViewError(hubId, message);
      });
  }, [hubId, viewPath, attempt]);

  useEffect(() => {
    if (loadError === undefined) return;
    const timer = setTimeout(() => setAttempt((current) => current + 1), BROKEN_VIEW_RETRY_MS);
    return () => clearTimeout(timer);
  }, [loadError, attempt]);

  return { View, loadError };
}

function ViewErrorPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-bad/50 bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-bad/30 px-4 py-2.5">
        <p className="font-mono text-xs uppercase tracking-label text-bad">{title}</p>
        <p className="font-mono text-xs text-muted">Fix view.tsx and the page reloads it.</p>
      </div>
      <pre className="max-h-96 overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">{detail}</pre>
    </div>
  );
}

type BoundaryProps = { hubId: string; children: ReactNode };

class ViewErrorBoundary extends Component<BoundaryProps, { error?: string }> {
  state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: errorText(error) };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    reportViewError(this.props.hubId, errorText(error));
  }

  componentDidMount() {
    import.meta.hot?.on("vite:afterUpdate", this.resetAfterUpdate);
  }

  componentWillUnmount() {
    import.meta.hot?.off("vite:afterUpdate", this.resetAfterUpdate);
  }

  resetAfterUpdate = () => {
    if (this.state.error !== undefined) this.setState({ error: undefined });
  };

  render() {
    if (this.state.error !== undefined) return <ViewErrorPanel title="View crashed" detail={this.state.error} />;
    return this.props.children;
  }
}

// React Refresh can remount a crashed view on its own, so a clean commit is
// the one reliable signal that the view works again.
function ReportsCleanRender({ hubId, hasCompileError, children }: { hubId: string; hasCompileError: boolean; children: ReactNode }) {
  useEffect(() => {
    if (!hasCompileError) reportViewError(hubId, null);
  });
  return children;
}

// Compile errors in a view that already loaded arrive over the HMR socket,
// not through import().
function useHotCompileError(hubId: string): string | undefined {
  const [compileError, setCompileError] = useState<string>();
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    // Vite's typings drop this event's payload, so it is declared optional.
    const onError = (payload?: ErrorPayload) => {
      if (!payload) return;
      const { err } = payload;
      const message = [err.message, err.id, err.frame].filter(Boolean).join("\n\n");
      setCompileError(message);
      reportViewError(hubId, message);
    };
    const onUpdate = () => setCompileError(undefined);
    hot.on("vite:error", onError);
    hot.on("vite:afterUpdate", onUpdate);
    return () => {
      hot.off("vite:error", onError);
      hot.off("vite:afterUpdate", onUpdate);
    };
  }, [hubId]);
  return compileError;
}

function attachStatus(hub: ReturnType<typeof useHub>): AttachStatus {
  if (hub.closed) return "closed";
  if (!hub.connected && hub.hub !== undefined) return "offline";
  return hub.attached ? "attached" : "unattached";
}

function HubFrame() {
  const hub = useHub();
  const { View, loadError } = useHubView(hub.hubId, hub.hub?.view_path);
  const compileError = useHotCompileError(hub.hubId);
  const status = attachStatus(hub);

  useEffect(() => {
    document.title = hub.hub ? `${hub.hub.title} · djt-hub` : "djt-hub";
  }, [hub.hub?.title]);

  return (
    <div className="min-h-dvh">
      <TopBar aside={<AttachChip status={status} />}>
        <span className="text-line">/</span>
        <h1 className="truncate font-display text-base font-semibold tracking-tight text-ink">{hub.hub?.title ?? hub.hubId}</h1>
        <span className="hidden font-mono text-xs text-faint sm:inline">{hub.hubId}</span>
      </TopBar>

      {status === "unattached" && (
        <Notice tone="warn" icon="lock">
          <p className="text-sm text-ink">
            <span className="font-medium">Read-only.</span> <span className="text-muted">No agent is attached. Controls unlock when one listens:</span>
          </p>
          <CopyCommand command={`djt-hub listen ${hub.hubId}`} />
        </Notice>
      )}
      {status === "closed" && (
        <Notice tone="muted" icon="lock">
          <p className="text-sm">This hub is closed. It stays readable here.</p>
        </Notice>
      )}
      {status === "offline" && (
        <Notice tone="bad" icon="unplug">
          <p className="text-sm">Lost the connection to the djt-hub daemon. Reconnecting.</p>
        </Notice>
      )}

      <main className="px-4 py-4 md:px-6 md:py-6">
        {loadError !== undefined && <ViewErrorPanel title="View failed to load" detail={loadError} />}
        {compileError !== undefined && (
          <div className="mb-4">
            <ViewErrorPanel title="View failed to compile" detail={compileError} />
          </div>
        )}
        {loadError === undefined && View !== undefined && (
          <ViewErrorBoundary hubId={hub.hubId}>
            <ReportsCleanRender hubId={hub.hubId} hasCompileError={compileError !== undefined}>
              <View />
            </ReportsCleanRender>
          </ViewErrorBoundary>
        )}
      </main>
    </div>
  );
}

export function HubPage({ hubId }: { hubId: string }) {
  return (
    <HubProvider hubId={hubId}>
      <HubFrame />
    </HubProvider>
  );
}
