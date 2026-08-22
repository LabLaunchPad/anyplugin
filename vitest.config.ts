import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{core,adapters,plugins,cli}/**/*.test.ts"],
    environment: "node",
  },
});
