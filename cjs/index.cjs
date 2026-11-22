"use strict";
// CommonJS entry. Ghostwright is an ES module; require() loads it where Node
// can (20.19+, 22.12+ and newer). On an older Node the error says what to do.
try {
  module.exports = require("./index.js");
} catch (e) {
  if (e && (e.code === "ERR_REQUIRE_ESM" || e.code === "ERR_REQUIRE_ASYNC_MODULE")) {
    const err = new Error(
      "ghostwright is an ES module and Node " + process.version + " cannot require() one. " +
      'Use `const { Ghostwright } = await import("ghostwright")`, or run Node 20.19+ / 22.12+, ' +
      'or make your project an ES module ("type": "module" in package.json).',
    );
    err.code = "ERR_GHOSTWRIGHT_ESM";
    throw err;
  }
  throw e;
}
