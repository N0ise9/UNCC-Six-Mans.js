module.exports = {
  collectCoverageFrom: ["src/**/*.ts"],
  modulePathIgnorePatterns: ["<rootDir>/build/"],
  preset: "ts-jest",
  testPathIgnorePatterns: ["/node_modules/", "/build/"],
  testEnvironment: "node",
};
