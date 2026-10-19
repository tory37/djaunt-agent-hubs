import { getPath, type JsonObject } from "./path.ts";

export type Matcher = { key: string; value: string };

export function parseMatchers(rawMatchers: string[]): Matcher[] {
  return rawMatchers.map((raw) => {
    const separator = raw.indexOf("=");
    if (separator <= 0) throw new Error(`match "${raw}" must be key=value`);
    return { key: raw.slice(0, separator), value: raw.slice(separator + 1) };
  });
}

// Keys are dotted state paths, so "values.env=prod" reads a nested field.
// No matchers match any payload.
export function payloadMatches(payload: unknown, matchers: Matcher[]): boolean {
  if (matchers.length === 0) return true;
  if (typeof payload !== "object" || payload === null) return false;
  return matchers.every((matcher) => {
    try {
      return String(getPath(payload as JsonObject, matcher.key)) === matcher.value;
    } catch {
      return false;
    }
  });
}
