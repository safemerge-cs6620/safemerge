import crypto from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sqs = new SQSClient({});
const sm = new SecretsManagerClient({});
const SCAN_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);
let cachedSecrets;

// Secrets are read once per Lambda container, then reused.
async function getSecrets() {
  if (cachedSecrets) return cachedSecrets;
  const [webhook, token] = await Promise.all([
    sm.send(new GetSecretValueCommand({ SecretId: process.env.WEBHOOK_SECRET_ARN })),
    sm.send(new GetSecretValueCommand({ SecretId: process.env.GITHUB_TOKEN_ARN })),
  ]);
  cachedSecrets = { webhook: webhook.SecretString, token: token.SecretString };
  return cachedSecrets;
}

// Same check as the S0-3 test: HMAC-SHA256 over the raw body, constant-time compare.
export function verifySignature(rawBody, header, secret) {
  if (!header) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const received = Buffer.from(header);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

const reply = (statusCode, message) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message }),
});

async function postPending(job, token) {
  const res = await fetch(`https://api.github.com/repos/${job.repo}/statuses/${job.headSha}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'safemerge',
    },
    body: JSON.stringify({ state: 'pending', context: 'safemerge/sast', description: 'SafeMerge scan queued' }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
}

export const handler = async (event) => {
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const rawBody = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
  const { webhook, token } = await getSecrets();

  if (!verifySignature(rawBody, headers['x-hub-signature-256'], webhook)) {
    console.warn('rejected: bad signature', headers['x-github-delivery']);
    return reply(401, 'invalid signature');
  }

  const ghEvent = headers['x-github-event'];
  if (ghEvent === 'ping') return reply(200, 'pong');

  const payload = JSON.parse(rawBody.toString('utf8'));
  if (ghEvent !== 'pull_request' || !SCAN_ACTIONS.has(payload.action)) {
    return reply(202, 'ignored');
  }

  // SQS scan job message, as defined in docs/DESIGN.md (files omitted: the worker lists them).
  const job = {
    repo: payload.repository.full_name,
    pr: payload.pull_request.number,
    headSha: payload.pull_request.head.sha,
    baseSha: payload.pull_request.base.sha,
    deliveryId: headers['x-github-delivery'],
  };

  // Post pending BEFORE queueing, so a fast worker result can never be overwritten by pending.
  // If this fails, still queue the scan: the worker's final status will appear anyway.
  try {
    await postPending(job, token);
  } catch (err) {
    console.error('pending status failed', err.message);
  }

  // If SQS fails, the Lambda throws, API Gateway returns 500, and the PR stays unmerged (fail closed).
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.QUEUE_URL,
    MessageBody: JSON.stringify(job),
  }));

  console.log('queued', JSON.stringify(job));
  return reply(202, 'queued');
};
