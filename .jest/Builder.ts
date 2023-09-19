import { Team } from "../src/types/common";
import * as faker from "faker";
import { DateTime } from "luxon";
import { PlayerInActiveMatch } from "../src/repositories/ActiveMatchRepository/types";
import { PlayerStats } from "../src/repositories/LeaderboardRepository/types";
import { PlayerInQueue } from "../src/repositories/QueueRepository/types";

abstract class Builder<T> {
  abstract isEqual(a: T, b: T): boolean;

  abstract single(overrides?: Partial<T>): T;

  many(count: number, overrides?: Partial<T>): Array<T> {
    const items: Array<T> = [];

    for (let i = 0; i < count; i++) {
      let isNotUnique = true;
      let hardStopCounter = 0;
      let item: T;

      do {
        if (hardStopCounter === 1000) {
          throw new Error(
            "Generated too many items without finding a unique instance. You may need to adjust your isEqual implementation."
          );
        }

        hardStopCounter++;
        item = this.single(overrides);
        isNotUnique = items.some((i) => this.isEqual(item, i));
      } while (isNotUnique);

      items.push(item);
    }

    return items;
  }
}

class BallChaserQueueBuilderClass extends Builder<PlayerInQueue> {
  isEqual(a: PlayerInQueue, b: PlayerInQueue) {
    return a.id === b.id;
  }

  single(overrides?: Partial<PlayerInQueue>) {
    return {
      id: faker.datatype.uuid(),
      isCap: faker.datatype.boolean(),
      name: faker.random.word(),
      mmr: 100,
      queueTime: DateTime.fromJSDate(faker.date.future()).set({ millisecond: 0, second: 0 }),
      team: faker.random.arrayElement([Team.Blue, Team.Orange]),
      ...overrides,
    };
  }
}
export const BallChaserQueueBuilder = new BallChaserQueueBuilderClass();

class ActiveMatchBuilderClass extends Builder<PlayerInActiveMatch> {
  isEqual(a: PlayerInActiveMatch, b: PlayerInActiveMatch): boolean {
    return a.id === b.id;
  }

  single(overrides?: Partial<PlayerInActiveMatch>): PlayerInActiveMatch {
    const mockBallChaser = BallChaserQueueBuilder.single();
    return {
      id: mockBallChaser.id,
      mmr: mockBallChaser.mmr,
      matchId: faker.datatype.uuid(),
      reportedTeam: null,
      team: mockBallChaser.team!,
      brokenQueue: false,
      ...overrides,
    };
  }
}
export const ActiveMatchBuilder = new ActiveMatchBuilderClass();

class LeaderboardBuilderClass extends Builder<PlayerStats> {
  isEqual(a: PlayerStats, b: PlayerStats): boolean {
    return a.id === b.id;
  }

  single(overrides?: Partial<PlayerStats>): PlayerStats {
    const mockBallChaser = BallChaserQueueBuilder.single();

    const wins = faker.datatype.number({ min: 0 });
    const losses = faker.datatype.number({ min: 0 });

    return {
      id: mockBallChaser.id,
      losses,
      matchesPlayed: wins + losses,
      mmr: faker.datatype.number({ min: 0 }),
      name: mockBallChaser.name,
      winPerc: wins / (wins + losses),
      wins,
      ...overrides,
    };
  }
}
export const LeaderboardBuilder = new LeaderboardBuilderClass();
