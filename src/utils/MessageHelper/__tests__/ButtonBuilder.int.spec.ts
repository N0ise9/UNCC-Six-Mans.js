import ButtonBuilder from "../ButtonBuilder";

jest.mock("../../utils");

describe("Building Buttons", () => {
  it("return queue buttons", () => {
    const result = ButtonBuilder.queueButtons();
    expect(result.toJSON()).toEqual({
      components: [
        expect.objectContaining({ custom_id: "joinQueue", label: "Join", style: 3, type: 2 }),
        expect.objectContaining({ custom_id: "leaveQueue", label: "Leave", style: 4, type: 2 }),
      ],
      type: 1,
    });
  });
  it("return full queue buttons", () => {
    const result = ButtonBuilder.fullQueueButtons();
    expect(result.toJSON()).toEqual({
      components: [
        expect.objectContaining({ custom_id: "chooseTeam", label: "Captains", style: 1, type: 2 }),
        expect.objectContaining({ custom_id: "randomizeTeams", label: "Random", style: 1, type: 2 }),
        expect.objectContaining({ custom_id: "leaveQueue", label: "Leave", style: 4, type: 2 }),
      ],
      type: 1,
    });
  });
  it("return break match buttons", () => {
    const result = ButtonBuilder.breakMatchButtons();
    expect(result.toJSON()).toEqual({
      components: [expect.objectContaining({ custom_id: "breakMatch", label: "DEV: Break Match", style: 4, type: 2 })],
      type: 1,
    });
  });
  it("return active match buttons", () => {
    const result = ButtonBuilder.activeMatchButtons();
    expect(result.toJSON()).toEqual({
      components: [
        expect.objectContaining({ custom_id: "brokenQueue", label: "Broken Queue", style: 4, type: 2 }),
        expect.objectContaining({ custom_id: "reportBlue", style: 2, type: 2 }),
        expect.objectContaining({ custom_id: "reportOrange", style: 2, type: 2 }),
      ],
      type: 1,
    });
  });
});
