# djt-hub web UI — design plan

Design read: a local dev tool, watched at a glance during live release runbooks.
Direction: Precision & Density, with Tactile Brutalism. Dark only.

## Constraints

- Vanilla JS ES modules + hand-written CSS, embedded via `go:embed`. No CDN, no build step. The daemon must work offline.
- One vendored lib: uPlot 1.6.32 (2025-03-14, MIT). It loads lazily, only when a chart block exists.
- Icons: hand-drawn 24px stroke SVGs in the Lucide style (`web/static/icons.js`). No emoji anywhere.
- Zero blur, zero shadows. Depth comes from 1px borders and surface steps.

## Typography

- Sans: `Inter, ui-sans-serif, -apple-system, "SF Pro Text", system-ui`.
- Mono: `"JetBrains Mono", "SF Mono", ui-monospace, Menlo`. Mono carries all data: ids, seq, values, times, status.
- Scale ratio 1.2 on a 13px base: 11 / 13 / 16 / 19 / 22.
- Hub title: `clamp(1.125rem, 1rem + 0.6vw, 1.5rem)`. Never wraps past 2 lines.
- Stat values: 22px mono, tabular numbers.

## Color tokens

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0b0b0c` | page |
| `--surface` | `#111113` | panels |
| `--surface-2` | `#17171a` | rows on hover, inputs |
| `--border` | `#26262b` | all 1px borders |
| `--border-strong` | `#3a3a42` | focus, active |
| `--text` | `#e8e6e3` | primary text |
| `--text-muted` | `#9a9aa3` | secondary |
| `--text-faint` | `#7d7d87` | meta labels |
| `--accent` | `#ffb224` | needs the user: gates, primary buttons, user events |
| `--run` | `#6cb6ff` | running |
| `--ok` | `#3fb950` | done |
| `--bad` | `#f85149` | failed, reject |

Contrast, computed (WCAG relative luminance):

- `--text` on `--surface`: ~16:1.
- `--text-muted` on `--surface`: 6.75:1 (AA).
- `--text-faint` on `--surface`: 4.63:1 (AA). `#7a7a84` was 4.45, so it got bumped.
- `--accent` on `--bg`: 10.4:1. Text `--bg` on an `--accent` button: 10.4:1.

## Grid & spacing

- 4px scale: `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s6` 24 · `--s8` 32.
- Hub page: a sticky 48px header, then a 12-column block grid plus a 320px activity rail at ≥1100px. Below that, the rail drops under the grid. Below 720px, every block goes full width.
- Block `width`: `full` 12 · `two-thirds` 8 · `half` 6 · `third` 4 · `quarter` 3.
- Grid gap 8px. Panels: 1px border, 2px radius, 12px body padding, 32px header.
- Stats tiles: a gapless inner grid. Shared 1px borders on every tile, so all corners align.

## Motion

- Hover: border and background shift, 120ms ease-out. No scale on dense rows.
- Change cue: when a block's data changes, its border flashes `--border-strong` → `--border` over 600ms.
- Running status: the icon rotates, 1.2s linear.
- `prefers-reduced-motion` turns all of it off.

## Interaction contract (user → agent)

All user actions POST events with `X-Hub-Source: user`.

| UI | Event type | Payload |
|---|---|---|
| gate approve / reject | `gate.approve` / `gate.reject` | `{block, step, note?}` |
| checklist toggle | `checklist.toggle` | `{block, item, done}` (also patches state if bound) |
| action button | `action` | `{block, action}` |
| form submit | `form.submit` | `{block, values}` |
| html block | anything via `hub.emit` | free |
