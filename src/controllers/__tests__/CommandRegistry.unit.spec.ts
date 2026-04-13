import { REST, Routes } from "discord.js";
import { registerAllSlashCommands, registerGuildSlashCommands } from "../CommandRegistry";

describe("registerAllSlashCommands", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env["ENABLE_SORA"];
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

  it("omits /sora from registration when ENABLE_SORA is not true", async () => {
    const put = jest.spyOn(REST.prototype, "put").mockResolvedValue(undefined as never);

    await registerGuildSlashCommands("client-1", "token-1", "guild-c");

    expect(put).toHaveBeenCalledWith(
      Routes.applicationGuildCommands("client-1", "guild-c"),
      expect.objectContaining({
        body: expect.not.arrayContaining([expect.objectContaining({ name: "sora" })]),
      })
    );
  });

  it("registers /sora when ENABLE_SORA is true and exposes sora_enabled on /setup set", async () => {
    process.env["ENABLE_SORA"] = "true";
    const put = jest.spyOn(REST.prototype, "put").mockResolvedValue(undefined as never);

    await registerGuildSlashCommands("client-1", "token-1", "guild-c");

    const [, payload] = put.mock.calls[0] ?? [];
    const commands = ((payload as { body?: Array<Record<string, unknown>> }).body ?? []) as Array<Record<string, unknown>>;
    const setup = commands.find((command) => command.name === "setup");
    const setSubcommand = (setup?.options as Array<Record<string, unknown>> | undefined)?.find(
      (option) => option.name === "set"
    );
    const setOptions = (setSubcommand?.options as Array<Record<string, unknown>> | undefined) ?? [];

    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sora" })]));
    expect(setOptions).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sora_enabled" })]));
    expect(setOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "enable_1v1" }),
        expect.objectContaining({ name: "enable_12v12" }),
      ])
    );
  });
});
