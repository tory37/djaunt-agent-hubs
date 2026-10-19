type AttachChangeListener = (hubId: string, attached: boolean) => void;

// A hub stays attached for a grace period after its last agent stream closes,
// so a click that lands between two `wait` calls still belongs to that agent.
export class AttachTracker {
  private listenerCountByHub = new Map<string, number>();
  private graceTimerByHub = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly graceMs: number,
    private readonly onChange: AttachChangeListener,
  ) {}

  isAttached(hubId: string): boolean {
    return (this.listenerCountByHub.get(hubId) ?? 0) > 0 || this.graceTimerByHub.has(hubId);
  }

  connect(hubId: string): () => void {
    const wasAttached = this.isAttached(hubId);
    this.cancelGrace(hubId);
    this.listenerCountByHub.set(hubId, (this.listenerCountByHub.get(hubId) ?? 0) + 1);
    if (!wasAttached) this.onChange(hubId, true);

    let isReleased = false;
    return () => {
      if (isReleased) return;
      isReleased = true;
      this.disconnect(hubId);
    };
  }

  private disconnect(hubId: string): void {
    const remainingListeners = (this.listenerCountByHub.get(hubId) ?? 1) - 1;
    if (remainingListeners > 0) {
      this.listenerCountByHub.set(hubId, remainingListeners);
      return;
    }
    this.listenerCountByHub.delete(hubId);
    const graceTimer = setTimeout(() => {
      this.graceTimerByHub.delete(hubId);
      this.onChange(hubId, false);
    }, this.graceMs);
    this.graceTimerByHub.set(hubId, graceTimer);
  }

  private cancelGrace(hubId: string): void {
    const graceTimer = this.graceTimerByHub.get(hubId);
    if (graceTimer === undefined) return;
    clearTimeout(graceTimer);
    this.graceTimerByHub.delete(hubId);
  }
}
