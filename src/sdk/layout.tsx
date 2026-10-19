import { createContext, useContext, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useHub } from "./hub-context.tsx";

export type PanelWidth = "full" | "two-thirds" | "half" | "third" | "quarter";

const WIDTH_CLASSES: Record<PanelWidth, string> = {
  full: "md:col-span-12",
  "two-thirds": "md:col-span-8",
  half: "md:col-span-6",
  third: "md:col-span-4",
  quarter: "md:col-span-3",
};

const InsideGridContext = createContext(false);

// A gapless bento: 1px gaps over the border color draw every hairline once.
export function Grid({ children }: { children: ReactNode }) {
  return (
    <InsideGridContext.Provider value={true}>
      <div className="grid grid-flow-row-dense grid-cols-12 gap-px overflow-hidden rounded-md border border-line bg-line">
        {children}
      </div>
    </InsideGridContext.Provider>
  );
}

export type PanelProps = {
  title?: ReactNode;
  eyebrow?: ReactNode;
  aside?: ReactNode;
  width?: PanelWidth;
  flush?: boolean;
  children?: ReactNode;
};

export function Panel({ title, eyebrow, aside, width = "full", flush = false, children }: PanelProps) {
  const isInsideGrid = useContext(InsideGridContext);
  const frameClasses = isInsideGrid ? `col-span-12 ${WIDTH_CLASSES[width]}` : "rounded-md border border-line";
  const hasHeader = title !== undefined || eyebrow !== undefined || aside !== undefined;
  return (
    <section className={`${frameClasses} flex min-w-0 flex-col bg-surface`}>
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0">
            {eyebrow !== undefined && <Eyebrow>{eyebrow}</Eyebrow>}
            {title !== undefined && <h2 className="font-display text-base font-semibold tracking-tight text-ink">{title}</h2>}
          </div>
          {aside}
        </header>
      )}
      <div className={flush ? "mt-3 min-w-0 flex-1" : "min-w-0 flex-1 p-4"}>{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-1 font-mono text-xs uppercase tracking-label text-muted">{children}</p>;
}

export type ButtonTone = "default" | "primary" | "danger";

const TONE_CLASSES: Record<ButtonTone, string> = {
  default: "border-line bg-raised text-ink hover:border-muted",
  primary: "border-accent bg-accent text-on-accent hover:bg-accent-hi hover:border-accent-hi",
  danger: "border-bad/60 bg-transparent text-bad hover:bg-bad/10",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; glow?: boolean };

// Disables itself while the page may not act, so no click is ever dropped.
export function Button({ tone = "default", glow = false, disabled, className = "", title, ...rest }: ButtonProps) {
  const { canAct } = useHub();
  const isDisabled = disabled || !canAct;
  const glowClass = glow && !isDisabled ? "shadow-glow" : "";
  return (
    <button
      type="button"
      {...rest}
      disabled={isDisabled}
      title={canAct ? title : "No agent attached"}
      className={`inline-flex h-8 items-center gap-2 rounded-sm border px-3 font-mono text-xs font-medium uppercase tracking-wider transition-[background-color,border-color,color,transform] duration-200 ease-dj active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0 ${TONE_CLASSES[tone]} ${glowClass} ${className}`}
    />
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs text-faint">{children}</p>;
}
