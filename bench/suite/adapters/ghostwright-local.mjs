// Ghostwright on the harness's local Chrome (attached over CDP).
import { openGhostwright, sdkAvailable, sdkVersion } from "./_ghostwright-common.mjs";

export default {
  name: "ghostwright-local",
  describe() {
    return { sdk: "ghostwright", version: sdkVersion(), notes: "local Chrome over CDP" };
  },
  available: sdkAvailable,
  open: (opts) => openGhostwright(opts, "local"),
};
