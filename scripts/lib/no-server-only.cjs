// Lets CLI scripts import server modules: "server-only" throws outside Next's server bundle.
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return require.resolve("./empty.cjs");
  return orig.call(this, request, ...rest);
};
