import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{core,adapters,plugins,cli,packages}/**/*.test.ts"],
    environment: "node",
  },
});
