// SafeMerge dashboard: serves the page and handles GitHub OAuth login.
// CloudFront and Cognito are blocked in Learner Lab, so this Lambda sits behind
// API Gateway (HTTPS) and does the login itself with a signed session cookie.
import crypto from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});
const ALLOWED = new Set(
  (process.env.ALLOWED_USERS || '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean)
);
const SESSION_SECONDS = 8 * 60 * 60;
let cached;

// Secrets are read once per Lambda container, then reused
async function getSecrets() {
  if (cached) return cached;
  const [oauth, session] = await Promise.all([
    sm.send(new GetSecretValueCommand({ SecretId: process.env.OAUTH_SECRET_ARN })),
    sm.send(new GetSecretValueCommand({ SecretId: process.env.SESSION_SECRET_ARN })),
  ]);
  cached = { oauth: JSON.parse(oauth.SecretString), sessionKey: session.SecretString };
  return cached;
}

// --- Signed session tokens: base64url(payload).HMAC ---
function sign(payload, key) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verify(token, key) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

// --- Cookies (API Gateway payload v2 sends them as an array) ---
function getCookie(event, name) {
  for (const c of event.cookies || []) {
    const i = c.indexOf('=');
    if (i > 0 && c.slice(0, i).trim() === name) return decodeURIComponent(c.slice(i + 1));
  }
  return null;
}

const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// --- Responses ---
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const escape = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(content, statusCode = 200, cookies = []) {
  return {
    statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
    cookies,
    body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SafeMerge</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    header { padding: 20px 32px; background: #111827; border-bottom: 1px solid #1f2937; display: flex; justify-content: space-between; align-items: center; }
    h1 { margin: 0; font-size: 22px; }
    main { padding: 32px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 20px; max-width: 640px; }
    .muted { color: #94a3b8; }
    a { color: #93c5fd; }
    .button { display: inline-block; padding: 10px 16px; background: #238636; color: #fff; border-radius: 6px; text-decoration: none; }
  </style>
</head>
<body>${content}</body>
</html>`,
  };
}

const redirect = (location, cookies = []) => ({
  statusCode: 302,
  headers: { location, ...SECURITY_HEADERS },
  cookies,
  body: '',
});

// --- Routes ---
async function home(event) {
  const { sessionKey } = await getSecrets();
  const session = verify(getCookie(event, 'sm_session'), sessionKey);
  if (!session) {
    return page(`
      <header><div><h1>SafeMerge</h1><span class="muted">Security from pull request to production</span></div></header>
      <main><div class="card">
        <h2>Sign in</h2>
        <p class="muted">The dashboard is limited to the SafeMerge team.</p>
        <a class="button" href="/login">Sign in with GitHub</a>
      </div></main>`);
  }
  return page(`
    <header>
      <div><h1>SafeMerge</h1><span class="muted">Security from pull request to production</span></div>
      <div class="muted">Signed in as ${escape(session.sub)} &middot; <a href="/logout">Sign out</a></div>
    </header>
    <main><div class="card">
      <h2>Dashboard</h2>
      <p class="muted">Scan history and trends will appear here.</p>
    </div></main>`);
}

async function login(event) {
  const { oauth } = await getSecrets();
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: oauth.client_id,
    redirect_uri: `https://${event.requestContext.domainName}/callback`,
    state,
    allow_signup: 'false',
  });
  // The state cookie proves the callback belongs to a login this browser started
  return redirect(`https://github.com/login/oauth/authorize?${params}`, [setCookie('sm_state', state, 600)]);
}

async function callback(event) {
  const { oauth, sessionKey } = await getSecrets();
  const q = event.queryStringParameters || {};
  const expectedState = getCookie(event, 'sm_state');
  if (!q.code || !q.state || !expectedState || q.state !== expectedState) {
    return page('<main><div class="card"><h2>Login failed</h2><p class="muted">Invalid login state. <a href="/">Try again</a>.</p></div></main>', 400);
  }

  // Exchange the one-time code for a GitHub access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: oauth.client_id,
      client_secret: oauth.client_secret,
      code: q.code,
      redirect_uri: `https://${event.requestContext.domainName}/callback`,
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) throw new Error(`token exchange failed: ${tokenJson.error || tokenRes.status}`);

  // Read the username. The GitHub token is used once here and then discarded.
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenJson.access_token}`, 'User-Agent': 'safemerge' },
  });
  const user = await userRes.json();
  const loginName = String(user.login || '').toLowerCase();

  const clearState = setCookie('sm_state', '', 0);
  if (!ALLOWED.has(loginName)) {
    console.warn('access denied for', loginName);
    return page(`<main><div class="card"><h2>Access denied</h2><p class="muted">${escape(loginName)} is not on the SafeMerge team.</p></div></main>`, 403, [clearState]);
  }

  const token = sign({ sub: loginName, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }, sessionKey);
  console.log('login ok for', loginName);
  return redirect('/', [clearState, setCookie('sm_session', token, SESSION_SECONDS)]);
}

export const handler = async (event) => {
  try {
    switch (event.rawPath) {
      case '/login': return await login(event);
      case '/callback': return await callback(event);
      case '/logout': return redirect('/', [setCookie('sm_session', '', 0)]);
      default: return await home(event);
    }
  } catch (err) {
    console.error('dashboard error', err.message);
    return page('<main><div class="card"><h2>Something went wrong</h2><p class="muted">Please try again.</p></div></main>', 500);
  }
};
