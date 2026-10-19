import { useEffect, useState } from "react";
import { useBound, useHub } from "./hub-context.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { Button, Empty } from "./layout.tsx";

export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

export type GateSpec = string | { prompt: string; approve?: string; reject?: string };

export type Step = {
  id: string;
  label: string;
  status?: StepStatus;
  detail?: string;
  started_at?: number;
  ended_at?: number;
  time?: string;
  gate?: GateSpec;
};

type StatusStyle = { icon: IconName; marker: string; label: string };

const STATUS_STYLES: Record<StepStatus, StatusStyle> = {
  pending: { icon: "dot", marker: "border-line text-faint", label: "text-muted" },
  running: { icon: "play", marker: "border-accent text-accent", label: "text-ink" },
  waiting: { icon: "pause", marker: "border-warn text-warn", label: "text-ink" },
  done: { icon: "check", marker: "border-ok/50 text-ok", label: "text-ink" },
  failed: { icon: "x", marker: "border-bad text-bad", label: "text-ink" },
  skipped: { icon: "skip", marker: "border-line text-faint", label: "text-faint line-through" },
};

const SECOND_MS = 1_000;
// Times above this are unix ms; below it, unix seconds.
const UNIX_MS_THRESHOLD = 1e12;

function toMilliseconds(timestamp: number): number {
  return timestamp < UNIX_MS_THRESHOLD ? timestamp * SECOND_MS : timestamp;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / SECOND_MS));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function useNow(isTicking: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isTicking) return;
    const timer = setInterval(() => setNow(Date.now()), SECOND_MS);
    return () => clearInterval(timer);
  }, [isTicking]);
  return now;
}

function stepTime(step: Step, now: number): string | undefined {
  if (step.time) return step.time;
  if (step.started_at === undefined) return undefined;
  const endedAt = step.ended_at === undefined ? now : toMilliseconds(step.ended_at);
  return formatElapsed(endedAt - toMilliseconds(step.started_at));
}

export type GateProps = {
  id: string;
  prompt: string;
  step?: string;
  approveLabel?: string;
  rejectLabel?: string;
};

// Emits gate.approve or gate.reject with {block, step, note}. The agent acts,
// then moves the step out of waiting; the click alone changes nothing.
export function Gate({ id, prompt, step, approveLabel = "Approve", rejectLabel = "Reject" }: GateProps) {
  const { emit, canAct } = useHub();
  const [note, setNote] = useState("");
  const [sentDecision, setSentDecision] = useState<string>();

  async function decide(type: "gate.approve" | "gate.reject") {
    const payload = { block: id, ...(step ? { step } : {}), ...(note ? { note } : {}) };
    if (await emit(type, payload)) setSentDecision(type === "gate.approve" ? approveLabel : rejectLabel);
  }

  return (
    <div className="mt-3 rounded-sm border border-warn/40 bg-warn/5 p-3">
      <p className="text-sm text-ink">{prompt}</p>
      {sentDecision ? (
        <p className="mt-2 font-mono text-xs text-muted">Sent: {sentDecision}. Waiting for the agent.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={!canAct}
            placeholder="Note (optional)"
            className="h-8 min-w-0 flex-1 basis-40 rounded-sm border border-line bg-bg px-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-40"
          />
          <Button tone="primary" glow onClick={() => decide("gate.approve")}>
            <Icon name="check" className="size-3.5" />
            {approveLabel}
          </Button>
          <Button tone="danger" onClick={() => decide("gate.reject")}>
            <Icon name="x" className="size-3.5" />
            {rejectLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function gateSpec(gate: GateSpec): { prompt: string; approve?: string; reject?: string } {
  return typeof gate === "string" ? { prompt: gate } : gate;
}

export type StepsProps = { id: string; bind?: string; items?: Step[] };

export function Steps({ id, bind, items = [] }: StepsProps) {
  const steps = useBound<Step[]>(bind, items);
  const hasRunningStep = steps.some((step) => step.status === "running" && step.ended_at === undefined);
  const now = useNow(hasRunningStep);
  if (steps.length === 0) return <Empty>No steps yet.</Empty>;

  return (
    <ol className="flex flex-col">
      {steps.map((step, position) => {
        const status = step.status ?? "pending";
        const style = STATUS_STYLES[status];
        const isLast = position === steps.length - 1;
        const time = stepTime(step, now);
        const gate = status === "waiting" && step.gate ? gateSpec(step.gate) : undefined;
        return (
          <li key={step.id} className="relative flex gap-3">
            <div className="flex flex-col items-center">
              <span className={`relative flex size-6 items-center justify-center overflow-hidden rounded-sm border bg-bg ${style.marker}`}>
                <Icon name={style.icon} className="size-3" />
                {status === "running" && <span className="animate-sweep absolute inset-y-0 left-0 w-1/3 bg-accent/20" />}
              </span>
              {!isLast && <span className="w-px flex-1 bg-line" />}
            </div>
            <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-4"}`}>
              <div className="flex min-h-6 items-baseline justify-between gap-3">
                <span className={`text-sm font-medium ${style.label}`}>{step.label}</span>
                <span className="flex shrink-0 items-baseline gap-3 font-mono text-xs text-muted">
                  {time && <span className="tabular-nums">{time}</span>}
                  <span className="uppercase tracking-wider">{status}</span>
                </span>
              </div>
              {step.detail && <p className="mt-0.5 text-sm text-muted">{step.detail}</p>}
              {gate && (
                <Gate id={id} step={step.id} prompt={gate.prompt} approveLabel={gate.approve} rejectLabel={gate.reject} />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
