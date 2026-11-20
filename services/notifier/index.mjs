import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});
const CONTEXTS = new Set(['safemerge/sast', 'safemerge/deploy-gate']);
const STATES = new Set(['pending', 'success', 'failure', 'error']);
const MAX_INLINE = 50;
const MAX_SUMMARY = 30;
let cachedToken;

async function getToken() {
  if (cachedToken) return cachedToken;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.GITHUB_TOKEN_ARN }));
  cachedToken = res.SecretString;
  return cachedToken;
}

async function gh(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'safemerge',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// Invalid input is a bug in the caller. Retrying will not fix it.
class BadInput extends Error {}

export function validate(n) {
  if (!n || typeof n !== 'object') throw new BadInput('input must be an object');
  if (!/^[\w.-]+\/[\w.-]+$/.test(n.repo || '')) throw new BadInput(`bad repo: ${n.repo}`);
  if (!/^[0-9a-f]{40}$/.test(n.sha || '')) throw new BadInput(`bad sha: ${n.sha}`);
  if (!CONTEXTS.has(n.context)) throw new BadInput(`bad context: ${n.context}`);
  if (!STATES.has(n.state)) throw new BadInput(`bad state: ${n.state}`);
  if (n.pr !== undefined && !Number.isInteger(n.pr)) throw new BadInput(`bad pr: ${n.pr}`);
}

// New-side line numbers in a diff patch that GitHub accepts review comments on.
export function commentableLines(patch) {
  const lines = new Set();
  if (!patch) return lines;
  let next = 0;
  for (const l of patch.split('\n')) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (l.startsWith('-') || l.startsWith('\\')) continue;
    lines.add(next);
    next += 1;
  }
  return lines;
}

async function changedLines(token, repo, pr) {
  const map = new Map();
  for (let page = 1; page <= 30; page++) {
    const files = await gh(token, 'GET', `/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    for (const f of files) map.set(f.filename, commentableLines(f.patch));
    if (files.length < 100) break;
  }
  return map;
}

// Two scanner rules can flag the same line with the same message. Post it once.
export function dedupe(comments) {
  const seen = new Set();
  return comments.filter((c) => {
    const key = `${c.path}:${c.line}:${c.body}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summaryList(items) {
  const shown = items.slice(0, MAX_SUMMARY).map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join('\n');
  const more = items.length > MAX_SUMMARY ? `\n- ...and ${items.length - MAX_SUMMARY} more` : '';
  return shown + more;
}

async function postReview(token, n) {
  const comments = dedupe(n.comments);
  const changed = await changedLines(token, n.repo, n.pr);
  const inline = comments.filter((c) => changed.get(c.path)?.has(c.line)).slice(0, MAX_INLINE);
  const outside = comments.filter((c) => !inline.includes(c));

  let body = `**SafeMerge SAST**: ${n.description}`;
  if (outside.length) body += `\n\nFindings outside the changed lines:\n${summaryList(outside)}`;

  try {
    await gh(token, 'POST', `/repos/${n.repo}/pulls/${n.pr}/reviews`, {
      commit_id: n.sha,
      event: 'COMMENT',
      body,
      comments: inline.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
    });
  } catch (err) {
    if (err.status !== 422) throw err;
    // GitHub rejected an inline position (for example, a newer commit was pushed). Post a summary only.
    console.warn('inline comments rejected, posting summary only', err.message);
    await gh(token, 'POST', `/repos/${n.repo}/pulls/${n.pr}/reviews`, {
      event: 'COMMENT',
      body: `**SafeMerge SAST**: ${n.description}\n\n${summaryList(comments)}`,
    });
  }
}

async function notify(token, n) {
  validate(n);
  if (n.pr && Array.isArray(n.comments) && n.comments.length) {
    // Comments are helpful, but the status is what blocks the merge. Never skip the status.
    try {
      await postReview(token, n);
    } catch (err) {
      console.error('review failed, still posting status', err.message);
    }
  }
  await gh(token, 'POST', `/repos/${n.repo}/statuses/${n.sha}`, {
    state: n.state,
    context: n.context,
    description: (n.description || '').slice(0, 140),
    ...(n.targetUrl ? { target_url: n.targetUrl } : {}),
  });
  console.log('status posted', n.repo, n.sha, n.context, n.state);
}

export const handler = async (event) => {
  const token = await getToken();

  // From the dead-letter queue: a scan job that failed 3 times. Fail closed with an error status.
  if (Array.isArray(event.Records)) {
    const batchItemFailures = [];
    for (const record of event.Records) {
      try {
        const job = JSON.parse(record.body);
        await notify(token, {
          repo: job.repo,
          sha: job.headSha,
          context: 'safemerge/sast',
          state: 'error',
          description: 'SafeMerge scan failed after 3 attempts. Push a new commit to retry.',
        });
      } catch (err) {
        console.error('DLQ record', record.messageId, err.message);
        // Malformed messages are logged and dropped. GitHub or network errors are retried.
        if (!(err instanceof BadInput || err instanceof SyntaxError)) {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
    }
    return { batchItemFailures };
  }

  // Direct call from the SAST worker or the deploy gate, using the notifier input in docs/DESIGN.md.
  await notify(token, event);
  return { ok: true };
};
