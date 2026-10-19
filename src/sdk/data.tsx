import { useEffect, useRef, type ReactNode } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useBound, useHub } from "./hub-context.tsx";
import { Empty } from "./layout.tsx";
import type { HubEvent } from "../store/store.ts";

export type Tone = "ok" | "warn" | "bad" | "info";

const TONE_TEXT: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info" };

export type Stat = { label: string; value: ReactNode; unit?: string; tone?: Tone; hint?: string };

type StatValue = ReactNode | Omit<Stat, "label">;

function isStatObject(value: StatValue): value is Omit<Stat, "label"> {
  return typeof value === "object" && value !== null && "value" in value;
}

function normalizeStats(stats: Stat[] | Record<string, StatValue>): Stat[] {
  if (Array.isArray(stats)) return stats;
  return Object.entries(stats).map(([label, value]) => (isStatObject(value) ? { label, ...value } : { label, value }));
}

export type StatsProps = { bind?: string; items?: Stat[] | Record<string, StatValue> };

export function Stats({ bind, items = [] }: StatsProps) {
  const stats = normalizeStats(useBound(bind, items));
  if (stats.length === 0) return <Empty>No stats yet.</Empty>;
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] overflow-hidden rounded-sm border-t border-l border-line">
      {stats.map((stat) => (
        <div key={stat.label} className="border-r border-b border-line px-3 py-2.5">
          <dt className="font-mono text-xs uppercase tracking-wider text-muted">{stat.label}</dt>
          <dd className={`mt-1 font-display text-xl font-semibold tabular-nums tracking-tight ${stat.tone ? TONE_TEXT[stat.tone] : "text-ink"}`}>
            {stat.value}
            {stat.unit && <span className="ml-1 font-mono text-xs font-normal text-muted">{stat.unit}</span>}
          </dd>
          {stat.hint && <p className="mt-0.5 text-xs text-muted">{stat.hint}</p>}
        </div>
      ))}
    </dl>
  );
}

export type Column = string | { key: string; label?: string; kind?: "text" | "status" | "number"; align?: "left" | "right" };

type NormalizedColumn = { key: string; label: string; kind: "text" | "status" | "number"; align: "left" | "right" };

const STATUS_TONES: Record<string, Tone> = {
  done: "ok", ok: "ok", passed: "ok", success: "ok",
  running: "info", pending: "info",
  waiting: "warn", warn: "warn", warning: "warn",
  failed: "bad", error: "bad", bad: "bad",
};

function normalizeColumn(column: Column): NormalizedColumn {
  if (typeof column === "string") return { key: column, label: column, kind: "text", align: "left" };
  const kind = column.kind ?? "text";
  return { key: column.key, label: column.label ?? column.key, kind, align: column.align ?? (kind === "number" ? "right" : "left") };
}

function renderCell(value: unknown, column: NormalizedColumn): ReactNode {
  if (value === undefined || value === null) return <span className="text-faint">—</span>;
  if (column.kind === "number" && typeof value === "number") return value.toLocaleString();
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (column.kind !== "status") return text;
  const tone = STATUS_TONES[text.toLowerCase()];
  return <span className={`font-mono text-xs uppercase tracking-wider ${tone ? TONE_TEXT[tone] : "text-muted"}`}>{text}</span>;
}

export type TableProps = { bind?: string; rows?: Record<string, unknown>[]; columns?: Column[]; maxHeight?: string };

export function Table({ bind, rows = [], columns }: TableProps) {
  const tableRows = useBound(bind, rows);
  if (tableRows.length === 0) return <Empty>No rows yet.</Empty>;
  const tableColumns = (columns ?? Object.keys(tableRows[0]!)).map(normalizeColumn);
  return (
    <div className="max-h-96 overflow-auto rounded-sm border border-line">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-raised">
          <tr>
            {tableColumns.map((column) => (
              <th key={column.key} className={`border-b border-line px-3 py-2 font-mono text-xs font-medium uppercase tracking-wider text-muted ${column.align === "right" ? "text-right" : "text-left"}`}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tableRows.map((row, rowPosition) => (
            <tr key={String(row.id ?? rowPosition)} className="border-b border-line last:border-b-0 hover:bg-raised/60">
              {tableColumns.map((column) => (
                <td key={column.key} className={`px-3 py-1.5 text-ink ${column.align === "right" ? "text-right font-mono tabular-nums" : ""}`}>
                  {renderCell(row[column.key], column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type ChartSeries = { label: string; values: (number | null)[]; color?: string };
export type ChartData = { x: (number | string)[]; series: ChartSeries[] } | Record<string, number | string>[];

export type ChartProps = {
  bind?: string;
  data?: ChartData;
  kind?: "line" | "area" | "bar";
  time?: boolean;
  height?: number;
  xLabel?: string;
  yLabel?: string;
};

const SERIES_COLOR_TOKENS = ["--dj-accent", "--dj-info", "--dj-success", "--dj-danger", "--dj-warning", "--dj-bone-300"];
const DEFAULT_CHART_HEIGHT = 220;
const Y_AXIS_WITH_LABEL_SIZE = 72;

function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function normalizeChartData(data: ChartData): { x: (number | string)[]; series: ChartSeries[] } {
  if (!Array.isArray(data)) return data;
  const seriesKeys = Object.keys(data[0] ?? {}).filter((key) => key !== "x");
  return {
    x: data.map((row) => row.x ?? 0),
    series: seriesKeys.map((key) => ({ label: key, values: data.map((row) => (typeof row[key] === "number" ? (row[key] as number) : null)) })),
  };
}

export function Chart({ bind, data = { x: [], series: [] }, kind = "line", time = false, height = DEFAULT_CHART_HEIGHT, xLabel, yLabel }: ChartProps) {
  const chartData = normalizeChartData(useBound(bind, data));
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const isCategorical = chartData.x.some((value) => typeof value === "string");
  const xValues = isCategorical ? chartData.x.map((_, position) => position) : (chartData.x as number[]);
  const seriesShape = `${kind}|${time}|${height}|${chartData.series.map((series) => series.label).join(",")}|${isCategorical}`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const gridColor = cssToken("--dj-border");
    const axisColor = cssToken("--dj-text-muted");
    const fontFamily = cssToken("--dj-font-mono");
    const axis = { stroke: axisColor, grid: { stroke: gridColor, width: 1 }, ticks: { stroke: gridColor, width: 1 }, font: `11px ${fontFamily}` };
    const options: uPlot.Options = {
      width: container.clientWidth,
      height,
      scales: { x: { time: time && !isCategorical } },
      legend: { show: chartData.series.length > 1 },
      cursor: { points: { size: 6 } },
      axes: [
        { ...axis, label: xLabel, values: isCategorical ? (_, ticks) => ticks.map((tick) => String(chartData.x[tick] ?? "")) : undefined },
        { ...axis, label: yLabel, size: yLabel ? Y_AXIS_WITH_LABEL_SIZE : undefined },
      ],
      series: [
        {},
        ...chartData.series.map((series, position) => {
          const color = series.color ?? cssToken(SERIES_COLOR_TOKENS[position % SERIES_COLOR_TOKENS.length]!);
          const isFilled = kind === "area" || kind === "bar";
          return {
            label: series.label,
            stroke: color,
            width: kind === "bar" ? 0 : 1.5,
            fill: isFilled ? `${color}33` : undefined,
            paths: kind === "bar" ? uPlot.paths.bars!({ size: [0.6, 48] }) : undefined,
            points: { show: false },
          };
        }),
      ],
    };
    const plot = new uPlot(options, [xValues, ...chartData.series.map((series) => series.values)] as uPlot.AlignedData, container);
    plotRef.current = plot;
    const resizeObserver = new ResizeObserver(() => plot.setSize({ width: container.clientWidth, height }));
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Rebuild only when the chart's shape changes; data updates go through setData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesShape]);

  useEffect(() => {
    plotRef.current?.setData([xValues, ...chartData.series.map((series) => series.values)] as uPlot.AlignedData);
  });

  if (chartData.series.length === 0) return <Empty>No data yet.</Empty>;
  return <div ref={containerRef} className="dj-chart w-full min-w-0" />;
}

export type LogLine = string | { ts?: number; level?: string; text: string };

export type LogProps = { bind?: string; lines?: LogLine[] | string; events?: string; max?: number; height?: string };

const DEFAULT_LOG_MAX = 500;
const LEVEL_TEXT: Record<string, string> = { error: "text-bad", warn: "text-warn", info: "text-info", ok: "text-ok" };

function formatClock(timestamp: number): string {
  return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toLocaleTimeString([], { hour12: false });
}

function collectLogLines(eventPrefix: string | undefined, events: HubEvent[], boundLines: LogLine[] | string): LogLine[] {
  if (eventPrefix) {
    return events
      .filter((event) => eventPrefix === "*" || event.type.startsWith(eventPrefix))
      .map((event) => ({ ts: event.ts, level: event.source, text: `${event.type} ${JSON.stringify(event.payload)}` }));
  }
  if (typeof boundLines === "string") return boundLines.split("\n");
  return boundLines;
}

// `events` shows live hub events whose type starts with the prefix ("*" for all).
export function Log({ bind, lines = [], events: eventPrefix, max = DEFAULT_LOG_MAX }: LogProps) {
  const { events } = useHub();
  const boundLines = useBound<LogLine[] | string>(bind, lines);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visibleLines = collectLogLines(eventPrefix, events, boundLines).slice(-max);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [visibleLines.length]);

  if (visibleLines.length === 0) return <Empty>No log lines yet.</Empty>;
  return (
    <div ref={scrollRef} className="max-h-80 overflow-auto rounded-sm border border-line bg-bg p-3 font-mono text-xs leading-relaxed">
      {visibleLines.map((line, position) => {
        const entry = typeof line === "string" ? { text: line } : line;
        return (
          <div key={position} className="flex gap-3 whitespace-pre-wrap break-words">
            {entry.ts !== undefined && <span className="shrink-0 text-faint tabular-nums">{formatClock(entry.ts)}</span>}
            {entry.level && <span className={`w-12 shrink-0 uppercase ${LEVEL_TEXT[entry.level] ?? "text-muted"}`}>{entry.level}</span>}
            <span className="min-w-0 text-ink">{entry.text}</span>
          </div>
        );
      })}
    </div>
  );
}
