import { ActiveSurfaceState, InteractiveSurfaceRecord } from "./types";

export class InteractiveSurfaceRegistry {
  private readonly surfaces = new Map<string, InteractiveSurfaceRecord>();

  close(messageId: string, kind: "queue" | "match"): number {
    const previous = this.surfaces.get(messageId);
    const revision = previous ? previous.revision + 1 : 1;
    this.surfaces.set(messageId, {
      allowedActions: new Set<string>(),
      kind,
      messageId,
      revision,
      state: "closed",
    });
    return revision;
  }

  get(messageId: string): InteractiveSurfaceRecord | null {
    return this.surfaces.get(messageId) ?? null;
  }

  hasRevision(messageId: string, revision: number): boolean {
    return this.surfaces.get(messageId)?.revision === revision;
  }

  isInteractionAllowed(messageId: string, action: string, values: string[] = []): boolean {
    const record = this.surfaces.get(messageId);
    if (!record || record.state === "closed") return false;
    if (!record.allowedActions.has(action)) return false;
    if (!record.allowedValues || values.length === 0) return true;
    return values.every((value) => record.allowedValues?.has(value));
  }

  upsert(messageId: string, kind: "queue" | "match", state: ActiveSurfaceState): number {
    const previous = this.surfaces.get(messageId);
    const revision = previous ? previous.revision + 1 : 1;
    this.surfaces.set(messageId, {
      allowedActions: state.allowedActions,
      allowedValues: state.allowedValues,
      kind,
      messageId,
      revision,
      state: state.state,
    });
    return revision;
  }
}
