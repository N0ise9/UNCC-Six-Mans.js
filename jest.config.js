module.exports = {
  collectCoverageFrom: ["src/**/*.ts"],
  modulePathIgnorePatterns: ["<rootDir>/build/"],
  preset: "ts-jest",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testPathIgnorePatterns: ["/node_modules/", "/build/"],
  testEnvironment: "node",
};
