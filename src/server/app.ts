import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { AGENT_HEADER, ATTACH_GRACE_MS, SOURCE_HEADER } from "../config.ts";
import { PathNotFoundError } from "../state/path.ts";
import {
  HubExistsError,
  HubNotFoundError,
  type HubStore,
  type PatchOperation,
} from "../store/store.ts";
import { DEFAULT_VIEW_SOURCE } from "../view-template.ts";
import { AttachTracker } from "./attach.ts";
import { Broker, type StreamMessage } from "./broker.ts";

const KEEPALIVE_INTERVAL_MS = 15_000;
const USER_SOURCE = "user";
const AGENT_SOURCE = "agent";

type AppOptions = { store: HubStore; attachGraceMs?: number; version?: string };

class ConflictError extends Error {}

function errorStatus(error: unknown): 400 | 404 | 409 {
  if (error instanceof HubNotFoundError || error instanceof PathNotFoundError) return 404;
  if (error instanceof HubExistsError || error instanceof ConflictError) return 409;
  return 400;
}

function requestSource(context: Context, bodySource?: unknown): string {
  const source = context.req.header(SOURCE_HEADER) ?? bodySource;
  return typeof source === "string" && source !== "" ? source : AGENT_SOURCE;
}

export function createApp({ store, attachGraceMs = ATTACH_GRACE_MS, version = "dev" }: AppOptions) {
  const broker = new Broker();
  const attach = new AttachTracker(attachGraceMs, (hubId, attached) => {
    broker.publish(hubId, { kind: "attach", attached });
  });
  const app = new Hono().basePath("/api");

  app.onError((error, context) => context.json({ error: error.message }, errorStatus(error)));

  function describeHub(hubId: string) {
    return {
      ...store.getHub(hubId),
      attached: attach.isAttached(hubId),
      last_seq: store.lastSeq(hubId),
      view_path: store.viewPath(hubId),
    };
  }

  // The page may act only while an agent listens; agents may always write.
  function assertWritable(hubId: string, source: string): void {
    if (store.getHub(hubId).closed_at !== null) throw new ConflictError(`hub ${hubId} is closed`);
    if (source === USER_SOURCE && !attach.isAttached(hubId)) {
      throw new ConflictError(`no agent is attached to hub ${hubId}`);
    }
  }

  app.get("/status", (context) =>
    context.json({ ok: true, version, hubs_dir: store.hubsDir, hubs: store.listHubs(false).length }),
  );

  app.get("/hubs", (context) => {
    const includeClosed = context.req.query("all") !== undefined;
    return context.json(store.listHubs(includeClosed).map((hub) => describeHub(hub.id)));
  });

  app.post("/hubs", async (context) => {
    const body = await context.req.json<{ id: string; title?: string; view?: string }>();
    store.createHub(body.id, body.title ?? "", body.view ?? DEFAULT_VIEW_SOURCE);
    return context.json(describeHub(body.id), 201);
  });

  app.get("/hubs/:hub", (context) => {
    const hubId = context.req.param("hub");
    return context.json({ ...describeHub(hubId), state: store.getState(hubId) });
  });

  app.delete("/hubs/:hub", (context) => {
    store.deleteHub(context.req.param("hub"));
    return context.json({ ok: true });
  });

  app.post("/hubs/:hub/close", (context) => {
    const hubId = context.req.param("hub");
    const hub = store.closeHub(hubId);
    broker.publish(hubId, { kind: "hub", hub });
    return context.json(describeHub(hubId));
  });

  app.get("/hubs/:hub/state", (context) =>
    context.json(store.getState(context.req.param("hub"))),
  );

  app.patch("/hubs/:hub/state", async (context) => {
    const hubId = context.req.param("hub");
    assertWritable(hubId, requestSource(context));
    const operations = await context.req.json<PatchOperation[]>();
    if (!Array.isArray(operations)) throw new Error("body must be a list of {path, value}");
    const state = store.patchState(hubId, operations);
    broker.publish(hubId, { kind: "state", state });
    return context.json(state);
  });

  app.get("/hubs/:hub/events", (context) => {
    const sinceSeq = Number(context.req.query("since") ?? 0);
    const eventType = context.req.query("type");
    const events = store.listEvents(context.req.param("hub"), sinceSeq);
    return context.json(eventType ? events.filter((event) => event.type === eventType) : events);
  });

  app.post("/hubs/:hub/events", async (context) => {
    const hubId = context.req.param("hub");
    const body = await context.req.json<{ source?: string; type: string; payload?: unknown }>();
    if (!body.type) throw new Error("event needs a type");
    const source = requestSource(context, body.source);
    assertWritable(hubId, source);
    const event = store.appendEvent(hubId, source, body.type, body.payload);
    broker.publish(hubId, { kind: "event", event });
    return context.json(event, 201);
  });

  app.get("/hubs/:hub/stream", (context) => {
    const hubId = context.req.param("hub");
    const sinceSeq = Number(context.req.query("since") ?? store.lastSeq(hubId));
    const isAgent = context.req.header(AGENT_HEADER) === "1";

    return streamSSE(context, async (stream) => {
      const releaseAttach = isAgent ? attach.connect(hubId) : () => {};
      // Live messages wait until the snapshot and replay are written, so a
      // client never sees an update before the state it applies to.
      const messagesDuringReplay: StreamMessage[] = [];
      let isReplayDone = false;
      const writeMessage = (message: StreamMessage) =>
        stream.writeSSE({ event: message.kind, data: JSON.stringify(message) });
      const unsubscribe = broker.subscribe(hubId, (message) => {
        if (isReplayDone) void writeMessage(message);
        else messagesDuringReplay.push(message);
      });
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));

      await stream.writeSSE({
        event: "init",
        data: JSON.stringify({ kind: "init", ...describeHub(hubId), state: store.getState(hubId) }),
      });
      const replayedEvents = store.listEvents(hubId, sinceSeq);
      for (const event of replayedEvents) await writeMessage({ kind: "event", event });
      const lastReplayedSeq = replayedEvents.at(-1)?.seq ?? sinceSeq;
      for (const message of messagesDuringReplay) {
        const isAlreadyReplayed = message.kind === "event" && message.event.seq <= lastReplayedSeq;
        if (!isAlreadyReplayed) await writeMessage(message);
      }
      isReplayDone = true;

      const keepalive = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), KEEPALIVE_INTERVAL_MS);
      await closed;
      clearInterval(keepalive);
      unsubscribe();
      releaseAttach();
    });
  });

  return { app, attach, broker };
}
