// Ghostwright on Phantom (Browsa's browser, opened through the Browsa API).
// Needs BROWSA_API_KEY. The browser is remote, so it cannot reach the local fixture
// server: this adapter runs only the live tasks (bot walls, live extracts).
// Optional: BENCH_PHANTOM_PROXY='{"network":"auto"}'.
import { openGhostwright, sdkAvailable, sdkVersion } from "./_ghostwright-common.mjs";

export default {
  name: "ghostwright-phantom",
  ownsBrowser: true,
  fixtures: false,
  describe() {
    return { sdk: "ghostwright", version: sdkVersion(), notes: "Phantom via the Browsa API" };
  },
  async available() {
    const a = await sdkAvailable();
    if (a !== true) return a;
    return process.env.BROWSA_API_KEY ? true : "BROWSA_API_KEY is not set";
  },
  open: (opts) => openGhostwright(opts, "phantom"),
};
