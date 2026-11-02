const faker = require("faker");

const FAKER_SEED = 1337;

function createFetchGuard() {
  return jest.fn(async () => {
    throw new Error("Unexpected network request in test. Mock global.fetch explicitly.");
  });
}

process.env.TZ = "UTC";
faker.seed(FAKER_SEED);
global.fetch = createFetchGuard();

beforeEach(() => {
  faker.seed(FAKER_SEED);
  jest.useRealTimers();
  global.fetch = createFetchGuard();
});

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  jest.useRealTimers();
  global.fetch = createFetchGuard();
});
