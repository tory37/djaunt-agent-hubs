import { useState, type FormEvent } from "react";
import { useBound, useHub } from "./hub-context.tsx";
import { Icon } from "./icons.tsx";
import { Button, Empty, type ButtonTone } from "./layout.tsx";

export type ActionItem = { id: string; label: string; tone?: ButtonTone; confirm?: boolean | string; disabled?: boolean };

export type ActionsProps = { id: string; bind?: string; items?: ActionItem[]; hint?: string };

// Emits `action` with {block, action}. A confirm asks for a second click.
export function Actions({ id, bind, items = [], hint }: ActionsProps) {
  const { emit } = useHub();
  const actions = useBound<ActionItem[]>(bind, items);
  const [armedActionId, setArmedActionId] = useState<string>();

  async function press(action: ActionItem) {
    const needsConfirm = Boolean(action.confirm) && armedActionId !== action.id;
    if (needsConfirm) {
      setArmedActionId(action.id);
      return;
    }
    setArmedActionId(undefined);
    await emit("action", { block: id, action: action.id });
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const isArmed = armedActionId === action.id;
          const confirmLabel = typeof action.confirm === "string" ? action.confirm : `Confirm ${action.label}`;
          return (
            <Button key={action.id} tone={isArmed ? "danger" : action.tone} disabled={action.disabled} onClick={() => press(action)}>
              {isArmed ? confirmLabel : action.label}
            </Button>
          );
        })}
      </div>
      {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export type FormField = {
  name: string;
  label?: string;
  kind?: "text" | "textarea" | "number" | "select" | "checkbox";
  options?: string[];
  value?: string | number | boolean;
  placeholder?: string;
  required?: boolean;
};

export type FormProps = { id: string; fields: FormField[]; submit?: string; repeatable?: boolean };

const FIELD_CLASSES =
  "w-full rounded-sm border border-line bg-bg px-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-40";

function initialValues(fields: FormField[]): Record<string, string | number | boolean> {
  return Object.fromEntries(fields.map((field) => [field.name, field.value ?? (field.kind === "checkbox" ? false : "")]));
}

type FieldControlProps = {
  fieldId: string;
  field: FormField;
  value: string | number | boolean | undefined;
  isLocked: boolean;
  onChange: (value: string | number) => void;
};

function FieldControl({ fieldId, field, value, isLocked, onChange }: FieldControlProps) {
  const shared = { id: fieldId, required: field.required, disabled: isLocked, value: String(value ?? "") };
  if (field.kind === "textarea") {
    return <textarea {...shared} rows={3} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} className={`${FIELD_CLASSES} py-1.5`} />;
  }
  if (field.kind === "select") {
    return (
      <select {...shared} onChange={(event) => onChange(event.target.value)} className={`${FIELD_CLASSES} h-8`}>
        {!field.required && <option value="">—</option>}
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  const isNumber = field.kind === "number";
  return (
    <input
      {...shared}
      type={isNumber ? "number" : "text"}
      placeholder={field.placeholder}
      onChange={(event) => onChange(isNumber ? Number(event.target.value) : event.target.value)}
      className={`${FIELD_CLASSES} h-8`}
    />
  );
}

// Emits `form.submit` with {block, values}. Locks after one submit unless repeatable.
export function Form({ id, fields, submit = "Submit", repeatable = false }: FormProps) {
  const { emit, canAct } = useHub();
  const [values, setValues] = useState(() => initialValues(fields));
  const [isSubmitted, setIsSubmitted] = useState(false);
  const isLocked = !canAct || (isSubmitted && !repeatable);

  function setValue(name: string, value: string | number | boolean) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (await emit("form.submit", { block: id, values })) setIsSubmitted(true);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {fields.map((field) => {
        const fieldId = `${id}-${field.name}`;
        const label = field.label ?? field.name;
        const value = values[field.name];
        if (field.kind === "checkbox") {
          return (
            <label key={field.name} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={Boolean(value)} disabled={isLocked} onChange={(event) => setValue(field.name, event.target.checked)} className="size-4 accent-[var(--dj-accent)]" />
              {label}
            </label>
          );
        }
        return (
          <label key={field.name} htmlFor={fieldId} className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase tracking-wider text-muted">{label}</span>
            <FieldControl fieldId={fieldId} field={field} value={value} isLocked={isLocked} onChange={(next) => setValue(field.name, next)} />

          </label>
        );
      })}
      <div className="flex items-center gap-3">
        <Button type="submit" tone="primary" disabled={isLocked}>{submit}</Button>
        {isSubmitted && <span className="font-mono text-xs text-muted">Sent. Waiting for the agent.</span>}
      </div>
    </form>
  );
}

export type ChecklistItem = { id: string; label: string; done?: boolean; note?: string };

export type ChecklistProps = { id: string; bind?: string; items?: ChecklistItem[] };

// Emits `checklist.toggle` with {block, item, done}; with `bind`, also patches `done`.
export function Checklist({ id, bind, items = [] }: ChecklistProps) {
  const { emit, patch, canAct } = useHub();
  const checklistItems = useBound<ChecklistItem[]>(bind, items);
  if (checklistItems.length === 0) return <Empty>Nothing to check.</Empty>;

  async function toggle(item: ChecklistItem) {
    const done = !item.done;
    const isSent = await emit("checklist.toggle", { block: id, item: item.id, done });
    if (isSent && bind) await patch(`${bind}.${item.id}.done`, done);
  }

  return (
    <ul className="flex flex-col gap-px overflow-hidden rounded-sm border border-line bg-line">
      {checklistItems.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            disabled={!canAct}
            onClick={() => toggle(item)}
            className="flex w-full items-start gap-3 bg-surface px-3 py-2 text-left transition-colors duration-200 ease-dj hover:bg-raised disabled:cursor-not-allowed disabled:hover:bg-surface"
          >
            <span className={`mt-0.5 flex size-4 items-center justify-center rounded-sm border ${item.done ? "border-ok bg-ok/15 text-ok" : "border-muted text-transparent"}`}>
              <Icon name="check" className="size-3" />
            </span>
            <span className="min-w-0">
              <span className={`block text-sm ${item.done ? "text-muted line-through" : "text-ink"}`}>{item.label}</span>
              {item.note && <span className="block text-xs text-muted">{item.note}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
