// A newly parked eve session can be waiting before its first accepted turn.
// That event is not completion of the application run being observed.
export class RunStreamBoundary {
  private started = false;
  settled(event: { type: string }) {
    if (event.type === "turn.started") this.started = true;
    return ["session.failed", "session.completed", "turn.failed", "turn.cancelled", "turn.completed"].includes(event.type) ||
      (this.started && event.type === "session.waiting");
  }
}
