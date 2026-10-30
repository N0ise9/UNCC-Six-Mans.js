import { REST, Routes } from "discord.js";
import { registerAllSlashCommands, registerGuildSlashCommands } from "../CommandRegistry";

describe("registerAllSlashCommands", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("clears global commands and registers the slash commands per guild", async () => {
    const put = jest
      .spyOn(REST.prototype, "put")
      .mockResolvedValue(undefined as never);

    await registerAllSlashCommands("client-1", "token-1", ["guild-a", "guild-b", "guild-a"]);

    expect(put).toHaveBeenNthCalledWith(
      1,
      Routes.applicationCommands("client-1"),
      expect.objectContaining({
        body: [],
      })
    );
    expect(put).toHaveBeenNthCalledWith(
      2,
      Routes.applicationGuildCommands("client-1", "guild-a"),
      expect.objectContaining({
        body: expect.arrayContaining([
          expect.objectContaining({ name: "setup" }),
          expect.objectContaining({ name: "prisma" }),
        ]),
      })
    );
    expect(put).toHaveBeenNthCalledWith(
      3,
      Routes.applicationGuildCommands("client-1", "guild-b"),
      expect.objectContaining({
        body: expect.arrayContaining([expect.objectContaining({ name: "prisma" })]),
      })
    );
    expect(put).toHaveBeenCalledTimes(3);
  });

  it("registers commands for a newly joined guild", async () => {
    const put = jest.spyOn(REST.prototype, "put").mockResolvedValue(undefined as never);

    await registerGuildSlashCommands("client-1", "token-1", "guild-c");

    expect(put).toHaveBeenCalledWith(
      Routes.applicationGuildCommands("client-1", "guild-c"),
      expect.objectContaining({
        body: expect.arrayContaining([
          expect.objectContaining({ name: "setup" }),
          expect.objectContaining({ name: "prisma" }),
        ]),
      })
    );
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("registers the complete supported command set", async () => {
    const put = jest.spyOn(REST.prototype, "put").mockResolvedValue(undefined as never);

    await registerGuildSlashCommands("client-1", "token-1", "guild-c");

    const [, payload] = put.mock.calls[0] ?? [];
    const commands = (payload as { body: Array<{ name: string }> }).body;

    expect(commands.map((command) => command.name)).toEqual(["setup", "kick", "clear", "prisma", "norm"]);
  });

  it("registers /norm with file attachment options", async () => {
    const put = jest.spyOn(REST.prototype, "put").mockResolvedValue(undefined as never);

    await registerGuildSlashCommands("client-1", "token-1", "guild-c");

    const [, payload] = put.mock.calls[0] ?? [];
    const commands = ((payload as { body?: Array<Record<string, unknown>> }).body ?? []) as Array<Record<string, unknown>>;
    const norm = commands.find((command) => command.name === "norm");
    const options = (norm?.options as Array<Record<string, unknown>> | undefined) ?? [];

    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "file1" }),
        expect.objectContaining({ name: "file2" }),
        expect.objectContaining({ name: "file3" }),
      ])
    );
    expect(options).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: "image1" })]));
  });

  it("registers the guild configuration and all match tier options on /setup set", async () => {
    const put = jest.spyOn(REST.prototype, "put").mockResolvedValue(undefined as never);

    await registerGuildSlashCommands("client-1", "token-1", "guild-c");

    const [, payload] = put.mock.calls[0] ?? [];
    const commands = ((payload as { body?: Array<Record<string, unknown>> }).body ?? []) as Array<Record<string, unknown>>;
    const setup = commands.find((command) => command.name === "setup");
    const setSubcommand = (setup?.options as Array<Record<string, unknown>> | undefined)?.find(
      (option) => option.name === "set"
    );
    const setOptions = (setSubcommand?.options as Array<Record<string, unknown>> | undefined) ?? [];

    expect(setOptions.map((option) => option.name)).toEqual([
      "queue_channel",
      "leaderboard_channel",
      "chat_channel",
      "database_url",
      "api_status_channel",
      "conversation_id",
      ...Array.from({ length: 12 }, (_, index) => `enable_${index + 1}v${index + 1}`),
    ]);
  });
});
