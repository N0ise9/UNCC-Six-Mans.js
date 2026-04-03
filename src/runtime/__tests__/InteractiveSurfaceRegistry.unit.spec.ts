import { ButtonCustomID } from "../../utils/MessageHelper/CustomButtons";
import { MenuCustomID } from "../../utils/MessageHelper/MessageBuilder";
import { InteractiveSurfaceRegistry } from "../InteractiveSurfaceRegistry";

describe("InteractiveSurfaceRegistry", () => {
  it("rejects stale join interactions after the queue becomes full while still allowing leave", () => {
    const registry = new InteractiveSurfaceRegistry();
    const messageId = "queue-message";

    const openRevision = registry.upsert(messageId, "queue", {
      allowedActions: new Set<string>([
        ButtonCustomID.JoinQueue,
        ButtonCustomID.LeaveQueue,
        ButtonCustomID.Twos,
      ]),
      state: "queue_open",
    });

    expect(registry.hasRevision(messageId, openRevision)).toBe(true);
    expect(registry.isInteractionAllowed(messageId, ButtonCustomID.JoinQueue)).toBe(true);

    const fullRevision = registry.upsert(messageId, "queue", {
      allowedActions: new Set<string>([
        ButtonCustomID.LeaveQueue,
        ButtonCustomID.ChooseTeam,
        ButtonCustomID.CreateRandomTeam,
      ]),
      state: "queue_full",
    });

    expect(registry.hasRevision(messageId, openRevision)).toBe(false);
    expect(registry.hasRevision(messageId, fullRevision)).toBe(true);
    expect(registry.isInteractionAllowed(messageId, ButtonCustomID.JoinQueue)).toBe(false);
    expect(registry.isInteractionAllowed(messageId, ButtonCustomID.LeaveQueue)).toBe(true);
  });

  it("rejects report interactions after a match surface is closed", () => {
    const registry = new InteractiveSurfaceRegistry();
    const messageId = "match-message";

    registry.upsert(messageId, "match", {
      allowedActions: new Set<string>([
        ButtonCustomID.BrokenQueue,
        ButtonCustomID.ReportBlue,
        ButtonCustomID.ReportOrange,
      ]),
      state: "match_active",
    });

    expect(registry.isInteractionAllowed(messageId, ButtonCustomID.ReportBlue)).toBe(true);
    registry.close(messageId, "match");
    expect(registry.isInteractionAllowed(messageId, ButtonCustomID.ReportBlue)).toBe(false);
    expect(registry.isInteractionAllowed(messageId, ButtonCustomID.ReportOrange)).toBe(false);
  });

  it("revalidates select menu option values when captain choices change", () => {
    const registry = new InteractiveSurfaceRegistry();
    const messageId = "captain-message";

    registry.upsert(messageId, "queue", {
      allowedActions: new Set<string>([MenuCustomID.BlueSelect]),
      allowedValues: new Set<string>(["player-a", "player-b"]),
      state: "captain_blue_pick",
    });

    expect(registry.isInteractionAllowed(messageId, MenuCustomID.BlueSelect, ["player-a"])).toBe(true);
    expect(registry.isInteractionAllowed(messageId, MenuCustomID.BlueSelect, ["player-c"])).toBe(false);

    registry.upsert(messageId, "queue", {
      allowedActions: new Set<string>([MenuCustomID.BlueSelect]),
      allowedValues: new Set<string>(["player-b", "player-d"]),
      state: "captain_blue_pick",
    });

    expect(registry.isInteractionAllowed(messageId, MenuCustomID.BlueSelect, ["player-a"])).toBe(false);
    expect(registry.isInteractionAllowed(messageId, MenuCustomID.BlueSelect, ["player-b"])).toBe(true);
  });
});
