import { useState, type ReactNode } from "react";
import { Icon } from "../../sdk/icons.tsx";

const COPIED_RESET_MS = 1_400;

export function Wordmark() {
  return (
    <a href="/" className="flex items-center gap-2 text-ink transition-colors duration-200 ease-dj hover:text-accent">
      <img src="/brand/logo/djaunt-icon-gold.svg" alt="" className="size-5" />
      <span className="hidden font-mono text-xs whitespace-nowrap uppercase tracking-label sm:inline">djt-hub</span>
    </a>
  );
}

export function TopBar({ children, aside }: { children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg">
      <div className="flex h-12 items-center justify-between gap-4 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Wordmark />
          {children}
        </div>
        {aside}
      </div>
    </header>
  );
}

export type AttachStatus = "attached" | "unattached" | "closed" | "offline";

const CHIP_STYLES: Record<AttachStatus, { label: string; classes: string; dot: string }> = {
  attached: { label: "Agent attached", classes: "border-ok/40 text-ok", dot: "bg-ok animate-beat" },
  unattached: { label: "No agent", classes: "border-line text-muted", dot: "border border-muted" },
  closed: { label: "Closed", classes: "border-line text-faint", dot: "bg-faint" },
  offline: { label: "Daemon offline", classes: "border-bad/50 text-bad", dot: "bg-bad" },
};

export function AttachChip({ status }: { status: AttachStatus }) {
  const style = CHIP_STYLES[status];
  return (
    <span role="status" className={`inline-flex h-7 shrink-0 items-center gap-2 rounded-sm border px-2.5 font-mono text-xs uppercase tracking-wider ${style.classes}`}>
      <span className={`size-1.5 ${style.dot}`} />
      {style.label}
    </span>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [isCopied, setIsCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(command);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), COPIED_RESET_MS);
  }
  return (
    <span className="inline-flex max-w-full items-stretch overflow-hidden rounded-sm border border-line bg-bg font-mono text-xs">
      <code className="truncate px-2.5 py-1.5 text-ink">
        <span className="text-faint select-none">$ </span>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${command}`}
        className="flex items-center border-l border-line px-2 text-muted transition-colors duration-200 ease-dj hover:bg-raised hover:text-accent"
      >
        <Icon name={isCopied ? "check" : "copy"} className="size-3.5" />
      </button>
    </span>
  );
}

export function Notice({ tone, icon, children }: { tone: "warn" | "muted" | "bad"; icon: "lock" | "alert" | "unplug"; children: ReactNode }) {
  const toneClasses = { warn: "border-warn/30 text-warn", muted: "border-line text-muted", bad: "border-bad/40 text-bad" }[tone];
  return (
    <div className={`border-b bg-raised ${toneClasses}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 md:px-6">
        <Icon name={icon} className="size-4" />
        {children}
      </div>
    </div>
  );
}
