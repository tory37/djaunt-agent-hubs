import type { ReactNode } from "react";

export type IconName = "check" | "x" | "lock" | "copy" | "alert" | "play" | "pause" | "skip" | "dot" | "plug" | "unplug";

const ICON_PATHS: Record<IconName, ReactNode> = {
  check: <path d="M4 12.5 9.5 18 20 6.5" />,
  x: <path d="M6 6 18 18M18 6 6 18" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" />
      <path d="M5 15H3V3h12v2" />
    </>
  ),
  alert: <path d="M12 3 22 20H2L12 3ZM12 10v4M12 17v.5" />,
  play: <path d="M7 4v16l13-8L7 4Z" />,
  pause: <path d="M7 5v14M17 5v14" />,
  skip: <path d="M5 5l9 7-9 7V5ZM19 5v14" />,
  dot: <rect x="9" y="9" width="6" height="6" />,
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4" />,
  unplug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4M3 3l18 18" />,
};

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
