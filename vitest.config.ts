import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // the examples import "ghostwright", as a user's script does: here that is this source
  resolve: { alias: { ghostwright: fileURLToPath(new URL("./src/index.ts", import.meta.url)) } },
  test: {
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
