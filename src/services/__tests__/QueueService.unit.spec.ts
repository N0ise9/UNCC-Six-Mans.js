import { checkQueueTimes, joinQueue, leaveQueue } from "../QueueService";
import { BallChaserQueueBuilder } from "../../../.jest/Builder";
import { DateTime } from "luxon";
import ActiveMatchRepository from "../../repositories/ActiveMatchRepository";
import QueueRepository from "../../repositories/QueueRepository";

jest.mock("../../repositories/ActiveMatchRepository");
jest.mock("../../repositories/QueueRepository");

//DateTime.now = jest.fn(() => DateTime.fromISO("2022-03-08T20:28:27.885Z"));
const DateTimeSixtyMinutesFromNow = DateTime.fromISO("2022-03-08T16:28:00.000-05:00");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("QueueService tests", () => {
  describe("Joining queue", () => {
    it("joins a player to the queue if they are not already in the queue", async () => {
      const mockBallChaser = BallChaserQueueBuilder.single();

      jest.mocked(ActiveMatchRepository.isPlayerInActiveMatch).mockResolvedValue(false);
      jest.mocked(QueueRepository.getBallChaserInQueue).mockResolvedValue(null);

      const getAllMock = jest.mocked(QueueRepository.getAllBallChasersInQueue);
      const updateMock = jest.mocked(QueueRepository.updateBallChaserInQueue);
      const addMock = jest.mocked(QueueRepository.addBallChaserToQueue);

      const result = await joinQueue(mockBallChaser.id, mockBallChaser.name);

      expect(result).not.toBeNull();
      expect(addMock).toHaveBeenCalledWith({
        id: mockBallChaser.id,
        name: mockBallChaser.name,
        queueTime: DateTimeSixtyMinutesFromNow,
      });
      expect(getAllMock).toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("does not add player to the queue if they're in an active match", async () => {
      const mockBallChaser = BallChaserQueueBuilder.single();

      jest.mocked(ActiveMatchRepository.isPlayerInActiveMatch).mockResolvedValue(true);

      const updateMock = jest.mocked(QueueRepository.updateBallChaserInQueue);
      const addMock = jest.mocked(QueueRepository.addBallChaserToQueue);

      const resultJoin = await joinQueue(mockBallChaser.id, mockBallChaser.name);

      expect(resultJoin).toBeNull();
      expect(updateMock).not.toHaveBeenCalled();
      expect(addMock).not.toHaveBeenCalled();
    });

    it("updates queueTime if player is already in the queue", async () => {
      const mockBallChaser = BallChaserQueueBuilder.single();

      jest.mocked(ActiveMatchRepository.isPlayerInActiveMatch).mockResolvedValue(false);
      jest.mocked(QueueRepository.getBallChaserInQueue).mockResolvedValue(mockBallChaser);

      const getAllMock = jest.mocked(QueueRepository.getAllBallChasersInQueue);
      const updateMock = jest.mocked(QueueRepository.updateBallChaserInQueue);
      const addMock = jest.mocked(QueueRepository.addBallChaserToQueue);

      await joinQueue(mockBallChaser.id, mockBallChaser.name);

      expect(updateMock).toHaveBeenCalledWith({
        id: mockBallChaser.id,
        queueTime: DateTimeSixtyMinutesFromNow,
      });
      expect(getAllMock).toHaveBeenCalled();
      expect(addMock).not.toHaveBeenCalled();
    });
  });

  describe("Leaving queue", () => {
    it("removes player from queue", async () => {
      const mockBallChaser = BallChaserQueueBuilder.single();
      jest.mocked(ActiveMatchRepository.isPlayerInActiveMatch).mockResolvedValue(false);
      const removeMock = jest.mocked(QueueRepository.removeBallChaserFromQueue);
      const getAllMock = jest.mocked(QueueRepository.getAllBallChasersInQueue);

      await leaveQueue(mockBallChaser.id);

      expect(removeMock).toHaveBeenCalledWith(mockBallChaser.id);
      expect(getAllMock).toHaveBeenCalled();
    });
  });

  describe("Queue timers", () => {
    it("removes stale players from an unpopped queue", async () => {
      const mockBallChasersToRemove = BallChaserQueueBuilder.many(3, {
        isCap: false,
        queueTime: DateTime.now().minus({ minutes: 1 }),
      });
      const mockBallChasersToStay = BallChaserQueueBuilder.many(2, {
        isCap: false,
        queueTime: DateTime.now().plus({ minutes: 1 }),
      });

      jest
        .mocked(QueueRepository.getAllBallChasersInQueue)
        .mockResolvedValue([...mockBallChasersToRemove, ...mockBallChasersToStay]);
      const removeMock = jest.mocked(QueueRepository.removeBallChaserFromQueue);

      await checkQueueTimes();

      expect(removeMock).toHaveBeenCalledTimes(mockBallChasersToRemove.length);
      mockBallChasersToRemove.forEach((ballChaser) => {
        expect(removeMock).toHaveBeenCalledWith(ballChaser.id);
      });
    });

    it("does not remove any players from a popped queue", async () => {
      const mockBallChasers = BallChaserQueueBuilder.many(4, {
        isCap: false,
        queueTime: DateTime.now().minus({ minutes: 1 }),
      });
      const mockCaptains = BallChaserQueueBuilder.many(2, {
        isCap: true,
        queueTime: DateTime.now().minus({ minutes: 1 }),
      });

      jest.mocked(QueueRepository.getAllBallChasersInQueue).mockResolvedValue([...mockBallChasers, ...mockCaptains]);
      const removeMock = jest.mocked(QueueRepository.removeBallChaserFromQueue);

      await checkQueueTimes();

      expect(removeMock).not.toHaveBeenCalled();
    });

    it("returns null if there are no players to remove", async () => {
      const mockBallChasers = BallChaserQueueBuilder.many(4, {
        isCap: false,
        queueTime: DateTime.now().plus({ minutes: 1 }),
      });

      jest.mocked(QueueRepository.getAllBallChasersInQueue).mockResolvedValue(mockBallChasers);
      const removeMock = jest.mocked(QueueRepository.removeBallChaserFromQueue);

      const result = await checkQueueTimes();

      expect(result).toBeNull();
      expect(removeMock).not.toHaveBeenCalled();
    });
  });
});
