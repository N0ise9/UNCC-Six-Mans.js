module.exports = {
  collectCoverageFrom: ["src/**/*.ts"],
  modulePathIgnorePatterns: ["<rootDir>/build/"],
  preset: "ts-jest",
  setupFiles: ["dotenv/config"],
  testPathIgnorePatterns: ["/node_modules/", "/build/"],
  testEnvironment: "node",
};
