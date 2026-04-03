import QueueRepository from "../../repositories/QueueRepository";
import { kickPlayerFromQueue } from "../AdminService";
import * as faker from "faker";
import { InvalidCommand } from "../../utils/InvalidCommand";
import { leaveQueue } from "../QueueService";
import { BallChaserQueueBuilder } from "../../../.jest/Builder";

jest.mock("../QueueService");
jest.mock("../../repositories/QueueRepository");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("AdminService tests", () => {
  describe("Kick command tests", () => {
    it("throws when queue is empty", async () => {
      const leaveQueueMock = jest.mocked(leaveQueue);
      jest.mocked(QueueRepository.getAllBallChasersInQueue).mockResolvedValue([]);

      await expect(kickPlayerFromQueue(faker.datatype.uuid())).rejects.toThrow(InvalidCommand);
      await expect(leaveQueueMock).not.toHaveBeenCalled();
    });

    it("throws when captains are already set", async () => {
      const leaveQueueMock = jest.mocked(leaveQueue);
      const captains = BallChaserQueueBuilder.many(2, { isCap: true });
      const otherPlayers = BallChaserQueueBuilder.many(4, { isCap: false });
      jest.mocked(QueueRepository.getAllBallChasersInQueue).mockResolvedValue([...otherPlayers, ...captains]);

      await expect(kickPlayerFromQueue(faker.datatype.uuid())).rejects.toThrow(InvalidCommand);
      expect(leaveQueueMock).not.toHaveBeenCalled();
    });

    it("calls leave queue with correct id", async () => {
      const mockBallChaser = BallChaserQueueBuilder.single({ isCap: false });
      jest.mocked(QueueRepository.getAllBallChasersInQueue).mockResolvedValue([mockBallChaser]);
      const leaveQueueMock = jest.mocked(leaveQueue);

      await kickPlayerFromQueue(mockBallChaser.id);

      expect(leaveQueueMock).toHaveBeenCalledWith(mockBallChaser.id);
    });
  });
});
