import { ChatInputCommandInteraction } from "discord.js";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";
import { createScheduledCommandResponder } from "../createScheduledCommandResponder";

describe("createScheduledCommandResponder", () => {
  it("routes editReply and followUp calls through the shared scheduler", async () => {
    const scheduler = new DiscordWorkScheduler(1, 0);
    const interaction = {
      editReply: jest.fn(async () => undefined),
      followUp: jest.fn(async () => undefined),
      id: "interaction-1",
    } as unknown as ChatInputCommandInteraction;

    const responder = createScheduledCommandResponder(interaction, scheduler, "test-response");

    await responder.edit("hello");
    await responder.followUp({ content: "world" });
    await scheduler.drain();

    expect(interaction.editReply).toHaveBeenCalledWith("hello");
    expect(interaction.followUp).toHaveBeenCalledWith({ content: "world" });
  });
});
