import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getPath, type JsonObject } from "../state/path.ts";
import type { Hub, HubEvent } from "../store/store.ts";

const MAX_KEPT_EVENTS = 500;
const USER_SOURCE_HEADERS = { "content-type": "application/json", "x-hub-source": "user" };

export type HubSnapshot = Hub & { attached: boolean; last_seq: number; view_path: string; view_error: string | null };

export type HubValue = {
  hubId: string;
  hub: HubSnapshot | undefined;
  state: JsonObject;
  events: HubEvent[];
  attached: boolean;
  closed: boolean;
  // True while the page may act: an agent is attached and the hub is open.
  canAct: boolean;
  connected: boolean;
  emit: (type: string, payload?: unknown) => Promise<boolean>;
  patch: (path: string, value: unknown) => Promise<boolean>;
  get: (path: string) => unknown;
};

const HubContext = createContext<HubValue | undefined>(undefined);

export function useHub(): HubValue {
  const hubValue = useContext(HubContext);
  if (hubValue === undefined) throw new Error("useHub must be used inside a hub view");
  return hubValue;
}

export function readPath(state: JsonObject, path: string | undefined): unknown {
  if (!path) return undefined;
  try {
    return getPath(state, path);
  } catch {
    return undefined;
  }
}

// Reads `bind` from hub state when given, else falls back to the inline prop.
export function useBound<T>(bind: string | undefined, inlineValue: T): T {
  const { state } = useHub();
  if (!bind) return inlineValue;
  return (readPath(state, bind) as T | undefined) ?? inlineValue;
}

function mergeEvent(events: HubEvent[], event: HubEvent): HubEvent[] {
  if (events.some((existing) => existing.seq === event.seq)) return events;
  return [...events, event].slice(-MAX_KEPT_EVENTS);
}

// Supplies a fixed hub value, for tests and static previews of a view.
export function StaticHubProvider({ value, children }: { value: HubValue; children: ReactNode }) {
  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

export function HubProvider({ hubId, children }: { hubId: string; children: ReactNode }) {
  const [hub, setHub] = useState<HubSnapshot>();
  const [state, setState] = useState<JsonObject>({});
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [attached, setAttached] = useState(false);
  const [connected, setConnected] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const source = new EventSource(`/api/hubs/${hubId}/stream?since=0`);
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("init", (message) => {
      const snapshot = JSON.parse(message.data);
      setHub(snapshot);
      setState(snapshot.state);
      setAttached(snapshot.attached);
    });
    source.addEventListener("state", (message) => setState(JSON.parse(message.data).state));
    source.addEventListener("attach", (message) => setAttached(JSON.parse(message.data).attached));
    source.addEventListener("hub", (message) => {
      const { hub: changedHub } = JSON.parse(message.data);
      setHub((current) => (current ? { ...current, ...changedHub } : current));
    });
    source.addEventListener("event", (message) => {
      const { event } = JSON.parse(message.data);
      setEvents((current) => mergeEvent(current, event));
    });
    return () => source.close();
  }, [hubId]);

  const closed = hub?.closed_at != null;
  const canAct = attached && !closed;

  const hubValue = useMemo<HubValue>(() => {
    async function send(path: string, method: string, body: unknown): Promise<boolean> {
      if (!canAct) return false;
      const response = await fetch(`/api/hubs/${hubId}${path}`, {
        method,
        headers: USER_SOURCE_HEADERS,
        body: JSON.stringify(body),
      });
      return response.ok;
    }
    return {
      hubId,
      hub,
      state,
      events,
      attached,
      closed,
      canAct,
      connected,
      emit: (type, payload = {}) => send("/events", "POST", { type, payload }),
      patch: (path, value) => send("/state", "PATCH", [{ path, value }]),
      get: (path) => readPath(stateRef.current, path),
    };
  }, [hubId, hub, state, events, attached, closed, canAct, connected]);

  return <HubContext.Provider value={hubValue}>{children}</HubContext.Provider>;
}
