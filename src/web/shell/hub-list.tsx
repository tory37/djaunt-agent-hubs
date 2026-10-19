import { useEffect, useState } from "react";
import type { HubSnapshot } from "../../sdk/hub-context.tsx";
import { AttachChip, CopyCommand, TopBar } from "./chrome.tsx";

const LIST_REFRESH_MS = 3_000;

function formatAge(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function hubStatus(hub: HubSnapshot) {
  if (hub.closed_at !== null) return "closed" as const;
  return hub.attached ? ("attached" as const) : ("unattached" as const);
}

export function HubList() {
  const [hubs, setHubs] = useState<HubSnapshot[]>();
  const [isShowingClosed, setIsShowingClosed] = useState(false);

  useEffect(() => {
    let isCancelled = false;
    async function load() {
      const response = await fetch(isShowingClosed ? "/api/hubs?all" : "/api/hubs");
      if (!isCancelled && response.ok) setHubs(await response.json());
    }
    void load();
    const timer = setInterval(load, LIST_REFRESH_MS);
    return () => {
      isCancelled = true;
      clearInterval(timer);
    };
  }, [isShowingClosed]);

  return (
    <div className="min-h-dvh">
      <TopBar
        aside={
          <label className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted">
            <input type="checkbox" checked={isShowingClosed} onChange={(event) => setIsShowingClosed(event.target.checked)} className="size-3.5 accent-[var(--dj-accent)]" />
            Show closed
          </label>
        }
      />
      <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
        <p className="font-mono text-xs uppercase tracking-label text-accent">Hubs</p>
        <h1 className="mt-1 font-display text-title font-semibold tracking-tight text-ink">Live pages your agents built</h1>

        {hubs !== undefined && hubs.length === 0 && (
          <div className="mt-6 rounded-md border border-line bg-surface p-6">
            <p className="text-sm text-muted">No hubs yet. An agent starts one with:</p>
            <div className="mt-3">
              <CopyCommand command="djt-hub create release-42 --title 'Release 4.2'" />
            </div>
          </div>
        )}

        {hubs !== undefined && hubs.length > 0 && (
          <ul className="mt-6 flex flex-col gap-px overflow-hidden rounded-md border border-line bg-line">
            {hubs.map((hub) => (
              <li key={hub.id}>
                <a
                  href={`/h/${hub.id}`}
                  className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 bg-surface px-4 py-3 transition-colors duration-200 ease-dj hover:bg-raised"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-display text-base font-semibold tracking-tight text-ink group-hover:text-accent-hi">{hub.title}</span>
                    <span className="mt-0.5 flex gap-3 font-mono text-xs text-faint">
                      <span>{hub.id}</span>
                      <span>{formatAge(hub.created_at)}</span>
                      {hub.view_error && <span className="text-bad">view error</span>}
                    </span>
                  </span>
                  <AttachChip status={hubStatus(hub)} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
