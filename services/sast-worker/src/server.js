import http from "node:http";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { processJob } from "./job.js";
import { makeStore } from "./store.js";
import { makeGithub } from "./github.js";
import { scanner, waitHealthy } from "./scanner.js";

const env = process.env;
const store = makeStore({ table: env.SCANS_TABLE, bucket: env.REPORTS_BUCKET });
const sm = new SecretsManagerClient({});
const lambda = new LambdaClient({});
let token;
const getToken = async () => {
  if (!token) {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: env.GITHUB_TOKEN_SECRET_ID }));
    token = r.SecretString;
  }
  return token;
};
const github = makeGithub(getToken);
const notifier = {
  async notify(payload) {
    const r = await lambda.send(new InvokeCommand({ FunctionName: env.NOTIFIER_FUNCTION_NAME, Payload: Buffer.from(JSON.stringify(payload)) }));
    if (r.FunctionError) throw new Error(`notifier failed: ${r.FunctionError}`);
  },
};
const deps = { store, github, scanner, notifier, dashboardUrl: env.DASHBOARD_URL };

async function handleEvent(event) {
  const failures = [];
  for (const rec of event.Records || []) {
    try { await processJob(JSON.parse(rec.body), deps); }
    catch (e) { console.error("job failed", rec.messageId, e.message); failures.push({ itemIdentifier: rec.messageId }); }
  }
  return { batchItemFailures: failures };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/ready") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('{"ready":true}');
  }
  if (req.method === "POST" && req.url === "/events") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const out = await handleEvent(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        console.error(e);
        res.writeHead(500); res.end();
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

await waitHealthy();
server.listen(8080, () => console.log("worker listening on 8080"));
