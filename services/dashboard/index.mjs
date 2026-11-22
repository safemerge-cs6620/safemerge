// Serves the SafeMerge dashboard page.
// CloudFront is blocked in Learner Lab, so the page is served by this Lambda behind API Gateway (HTTPS).
const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SafeMerge</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    header { padding: 20px 32px; background: #111827; border-bottom: 1px solid #1f2937; }
    h1 { margin: 0; font-size: 22px; }
    main { padding: 32px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 20px; max-width: 640px; }
    .muted { color: #94a3b8; }
  </style>
</head>
<body>
  <header><h1>SafeMerge</h1><span class="muted">Security from pull request to production</span></header>
  <main>
    <div class="card">
      <h2>Dashboard</h2>
      <p class="muted">Scan history and trends will appear here.</p>
    </div>
  </main>
</body>
</html>`;

export const handler = async () => ({
  statusCode: 200,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    // Basic browser protections for the page itself
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  },
  body: PAGE,
});
