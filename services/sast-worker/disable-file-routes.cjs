// Preloaded into the provided scanner so /scan/file and /scan/directory
// (which read arbitrary paths) are never registered. Only /scan/code stays.
const express = require("express");
const BLOCK = new Set(["/scan/file", "/scan/directory"]);
const METHODS = ["get", "post", "put", "delete", "all", "use"];
for (const target of [express.application, express.Router]) {
  for (const m of METHODS) {
    const orig = target[m];
    if (typeof orig !== "function") continue;
    target[m] = function (path, ...rest) {
      if (typeof path === "string" && BLOCK.has(path)) return this;
      return orig.call(this, path, ...rest);
    };
  }
}
