import { randomUUID } from "node:crypto";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const JS_RE = /\.(js|jsx|mjs|cjs)$/i;
const MAX_FILES = 100;
const MAX_COMMENTS = 50;
const DAY = 86400;

export function validateJob(job) {
  if (!job || typeof job !== "object") throw new Error("job must be an object");
  if (!REPO_RE.test(job.repo || "")) throw new Error("bad repo");
  if (!Number.isInteger(job.pr)) throw new Error("bad pr");
  if (!SHA_RE.test(job.headSha || "")) throw new Error("bad headSha");
  if (!job.deliveryId || typeof job.deliveryId !== "string") throw new Error("bad deliveryId");
}

export function toFindings(path, vulnerabilities) {
  const seen = new Set();
  const out = [];
  for (const v of vulnerabilities || []) {
    const key = `${path}|${v.id}|${v.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ruleId: v.id, name: v.name, severity: String(v.severity || "").toUpperCase(),
      file: path, line: v.line, column: v.column, evidence: v.evidence, message: v.message,
    });
  }
  return out;
}

export async function processJob(job, deps) {
  validateJob(job);
  const { store, github, scanner, notifier } = deps;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

  const claim = await store.claimDelivery(job.deliveryId, now);
  if (!claim.claimed) return { skipped: true };
  const scanId = claim.scanId;
  const scanTime = claim.scanTime;

  const files = (await github.listChangedFiles(job.repo, job.pr))
    .filter((f) => f.status !== "removed" && JS_RE.test(f.filename))
    .slice(0, MAX_FILES);

  const findings = [];
  for (const f of files) {
    const code = await github.getFile(job.repo, f.filename, job.headSha);
    const res = await scanner.scanCode(code);
    findings.push(...toFindings(f.filename, res.vulnerabilities));
  }

  const count = (s) => findings.filter((x) => x.severity === s).length;
  const counts = { HIGH: count("HIGH"), MEDIUM: count("MEDIUM"), LOW: count("LOW") };
  const status = counts.HIGH > 0 ? "fail" : "pass";
  const reportKey = `reports/${job.repo}/${scanId}.json`;

  await store.putReport(reportKey, { scanId, repo: job.repo, pr: job.pr, sha: job.headSha, status, counts, filesScanned: files.map((f) => f.filename), findings });
  await store.putScan({
    repo: job.repo, scanKey: `${scanTime}#${scanId}`, scanId, scanTime,
    repoPr: `${job.repo}#${job.pr}`, type: "SAST", pr: job.pr, sha: job.headSha,
    status, counts, reportKey, deliveryId: job.deliveryId, ttl: now + 90 * DAY,
  });

  const comments = findings.filter((x) => x.severity === "HIGH").slice(0, MAX_COMMENTS)
    .map((x) => ({ path: x.file, line: x.line, body: `**${x.name}** (${x.severity}): ${x.message}` }));
  await notifier.notify({
    repo: job.repo, pr: job.pr, sha: job.headSha, context: "safemerge/sast",
    state: status === "fail" ? "failure" : "success",
    description: status === "fail" ? `${counts.HIGH} high-severity finding(s)` : "No high-severity findings",
    targetUrl: deps.dashboardUrl || undefined, comments,
  });

  await store.markDone(job.deliveryId);
  return { skipped: false, scanId, status, counts };
}

export { randomUUID };
