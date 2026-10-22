import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{core,adapters,plugins,cli,packages}/**/*.test.ts"],
    environment: "node",
    // The default 5s bound is calibrated for unit tests. Several suites here
    // SCAN the repository or spawn a child process per agent, so their
    // duration is a property of the machine's load rather than of the code:
    // two enforcement-table checks measured 9.4s and 10.4s on a loaded
    // runner and failed on the timeout while the code was correct. That is
    // the F17 class — a pass that depends on runner speed.
    //
    // 30s is the global floor. A suite that genuinely needs more states its
    // own bound (`vi.setConfig({ testTimeout: 120_000 })`); the spawn-heavy
    // ones do. This changes no assertion: a real hang still fails.
    testTimeout: 30_000,
  },
});
