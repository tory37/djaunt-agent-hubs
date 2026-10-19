export class UsageError extends Error {}

export type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string[]>;
};

// Flags may appear anywhere among positionals, so agents can write
// `wait release-42 --type gate.approve` as naturally as the reverse.
export function parseArgs(args: string[], booleanFlags: string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const addFlag = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);

  for (let position = 0; position < args.length; position++) {
    const arg = args[position]!;
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }
    const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (inlineValue !== undefined) addFlag(name, inlineValue);
    else if (booleanFlags.includes(name)) addFlag(name, "true");
    else {
      const value = args[++position];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      addFlag(name, value);
    }
  }
  return { positionals, flags };
}

export function flag(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

export function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name);
}

export function flagList(parsed: ParsedArgs, name: string): string[] {
  return parsed.flags.get(name) ?? [];
}

// The hub comes from --hub, then $DJT_HUB_ID, then the first positional.
export function resolveHub(parsed: ParsedArgs, usage: string): { hubId: string; rest: string[] } {
  const explicitHub = flag(parsed, "hub") || process.env.DJT_HUB_ID;
  if (explicitHub) return { hubId: explicitHub, rest: parsed.positionals };
  const [hubId, ...rest] = parsed.positionals;
  if (!hubId) throw new UsageError(usage);
  return { hubId, rest };
}

const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export function parseDuration(text: string): number {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  const consumed = parts.map((part) => part[0]).join("");
  if (parts.length === 0 || consumed !== text) throw new UsageError(`bad duration "${text}" (try 30s, 10m, 1h)`);
  return parts.reduce((total, part) => total + Number(part[1]) * DURATION_UNIT_MS[part[2]!]!, 0);
}

// A value parses as JSON when it can, else it is a plain string.
export function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
