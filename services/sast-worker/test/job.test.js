import { test } from "node:test";
import assert from "node:assert/strict";
import { processJob } from "../src/job.js";

const SHA = "a".repeat(40);
const job = (o = {}) => ({ repo: "o/r", pr: 7, headSha: SHA, deliveryId: "d1", ...o });

function setup({ vulns = {}, claim, notifyFails = false } = {}) {
  const log = { scans: [], reports: [], notified: [], done: [], claims: 0 };
  const deps = {
    now: () => 1000,
    store: {
      async claimDelivery() { log.claims++; return claim || { claimed: true, scanId: "sid", scanTime: "T" }; },
      async markDone(id) { log.done.push(id); },
      async putScan(i) { log.scans.push(i); },
      async putReport(k, b) { log.reports.push([k, b]); },
    },
    github: {
      async listChangedFiles() { return [{ filename: "a.js", status: "added" }, { filename: "b.md", status: "added" }, { filename: "c.js", status: "removed" }, { filename: "d/e.mjs", status: "modified" }]; },
      async getFile(_r, p) { return p; },
    },
    scanner: { async scanCode(code) { return { vulnerabilities: vulns[code] || [] }; } },
    notifier: { async notify(p) { if (notifyFails) throw new Error("boom"); log.notified.push(p); } },
  };
  return { deps, log };
}
const V = (id, sev, line = 1) => ({ id, name: id, severity: sev, line, column: 1, evidence: "x", message: "m" });

test("HIGH finding fails", async () => {
  const { deps, log } = setup({ vulns: { "a.js": [V("HARDCODED_SECRET", "HIGH")] } });
  const r = await processJob(job(), deps);
  assert.equal(r.status, "fail");
  assert.equal(log.notified[0].state, "failure");
  assert.equal(log.notified[0].context, "safemerge/sast");
  assert.equal(log.scans[0].status, "fail");
  assert.equal(log.scans[0].reportKey, "reports/o/r/sid.json");
  assert.equal(log.reports[0][1].findings[0].file, "a.js");
  assert.deepEqual(log.done, ["d1"]);
});
test("MEDIUM only passes", async () => {
  const { deps, log } = setup({ vulns: { "a.js": [V("X", "MEDIUM")] } });
  assert.equal((await processJob(job(), deps)).status, "pass");
  assert.equal(log.notified[0].state, "success");
});
test("clean passes, only js files scanned", async () => {
  const { deps, log } = setup();
  await processJob(job(), deps);
  assert.deepEqual(log.reports[0][1].filesScanned, ["a.js", "d/e.mjs"]);
  assert.equal(log.scans[0].counts.high, 0);
});
test("dedupes same path/id/line", async () => {
  const { deps, log } = setup({ vulns: { "a.js": [V("X", "HIGH"), V("X", "HIGH")] } });
  await processJob(job(), deps);
  assert.equal(log.reports[0][1].findings.length, 1);
});
test("already-claimed delivery is skipped", async () => {
  const { deps, log } = setup({ claim: { claimed: false } });
  const r = await processJob(job(), deps);
  assert.equal(r.skipped, true);
  assert.equal(log.scans.length, 0);
  assert.equal(log.notified.length, 0);
});
test("notifier failure leaves delivery not done and throws", async () => {
  const { deps, log } = setup({ notifyFails: true });
  await assert.rejects(processJob(job(), deps));
  assert.deepEqual(log.done, []);
});
test("retry reuses scanId and scanTime from the claim", async () => {
  const { deps, log } = setup({ claim: { claimed: true, scanId: "old", scanTime: "T0" } });
  await processJob(job(), deps);
  assert.equal(log.scans[0].scanId, "old");
  assert.equal(log.scans[0].scanKey, "T0#old");
});
test("bad SHA rejected before any work", async () => {
  const { deps, log } = setup();
  await assert.rejects(processJob(job({ headSha: "abc" }), deps));
  assert.equal(log.claims, 0);
});
