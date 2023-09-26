import { Team } from "../../types/common";

jest.mock("../../repositories/ActiveMatchRepository");
jest.mock("../../repositories/QueueRepository");
jest.mock("../../utils");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Match Report Service tests", () => {
  describe.each([Team.Blue, Team.Orange])("Report team button was pressed", (team) => {
    it("Does not report if they player is not in an active match", async () => {});
    it("Reports the blue team won if the player is in an active match", async () => {});
    it("Only reports the match if if the same person reports the same team twice", async () => {});
    it("Does not change the report if another player on the same team reports the same team", async () => {});
    it("Confirms the blue team won if this is the second report by opposite team", async () => {});
  });
});
