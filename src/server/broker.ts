import type { JsonObject } from "../state/path.ts";
import type { Hub, HubEvent } from "../store/store.ts";

export type StreamMessage =
  | { kind: "state"; state: JsonObject }
  | { kind: "event"; event: HubEvent }
  | { kind: "attach"; attached: boolean }
  | { kind: "hub"; hub: Hub };

type Subscriber = (message: StreamMessage) => void;

export class Broker {
  private subscribersByHub = new Map<string, Set<Subscriber>>();

  subscribe(hubId: string, subscriber: Subscriber): () => void {
    const subscribers = this.subscribersByHub.get(hubId) ?? new Set();
    subscribers.add(subscriber);
    this.subscribersByHub.set(hubId, subscribers);
    return () => subscribers.delete(subscriber);
  }

  publish(hubId: string, message: StreamMessage): void {
    for (const subscriber of this.subscribersByHub.get(hubId) ?? []) subscriber(message);
  }
}
