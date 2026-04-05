import { spawn } from "node:child_process";
import path from "node:path";
import { resolveIntegrationTestEnvironment } from "./require-test-database-url.mjs";

try {
  const { testDatabaseUrl } = resolveIntegrationTestEnvironment();
  const jestScriptPath = path.resolve(
    process.cwd(),
    "node_modules",
    "jest",
    "bin",
    "jest.js"
  );
  const child = spawn(
    process.execPath,
    [
      jestScriptPath,
      "--runInBand",
      "--testMatch=**/__tests__/*.int.spec.ts",
      "--testNamePattern=",
    ],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL: testDatabaseUrl,
      },
      stdio: "inherit",
    }
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
