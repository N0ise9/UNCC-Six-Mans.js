module.exports = {
  collectCoverageFrom: ["src/**/*.ts"],
  modulePathIgnorePatterns: ["<rootDir>/build/"],
  preset: "ts-jest",
  setupFiles: ["<rootDir>/jest.setup.js"],
  testPathIgnorePatterns: ["/node_modules/", "/build/"],
  testEnvironment: "node",
};
