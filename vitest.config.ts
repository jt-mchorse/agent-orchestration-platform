import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    reporters: "default",
    // Fails the run if a test leaves a file in <repo>/results/ (#277).
    globalSetup: ["test/setup/no-results-leak.ts"],
  },
});
