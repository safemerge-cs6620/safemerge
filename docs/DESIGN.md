# SafeMerge design

## Product
SafeMerge is a security platform for software teams that use AI coding assistants (customer type: Developer Tooling).
- **Stage 1 (SAST, before merge):** pull requests are scanned with the course-provided SAST scanner. Findings appear as inline PR comments and a commit status. Branch protection blocks merges on HIGH findings.
- **Stage 2 (deploy gate, after merge):** the demo app is deployed to a temporary staging task and tested with the course-provided pentest tool. The production deploy job only runs if the gate passes.
- **Dashboard:** scan history and trends, behind a login.

## Course requirements
- Everything runs in AWS Academy Learner Lab.
- At least 2 AWS services beyond EC2, and Docker for at least one component.
- Use and extend the provided SAST and pentest code (Node.js/Express). Do not replace it.
- A working public URL, no hardcoded secrets, restricted security groups.

## Learner Lab constraints (verified)
| Item | Status | What we do |
|---|---|---|
| IAM | Only LabRole | Every Lambda, ECS task, Step Functions state machine, and scheduler uses LabRole. Terraform never creates IAM roles. |
| ECS Fargate | Works | Staging and pentest run as Fargate tasks |
| CloudFront | Blocked | Dashboard is served by a Lambda behind an API Gateway HTTP API (public HTTPS URL) |
| Cognito | Blocked | GitHub OAuth login in the dashboard Lambda: allowlist of team usernames, HMAC-signed HttpOnly session cookie (8 hours), state cookie against forged logins |
| Step Functions starting Fargate | Works (tested in S2-1, and in prod at about 1 min 45 s per gate run) | Deploy gate uses ecs:runTask.sync for the pentest task |
| Session credentials | Expire every few hours | Refresh GitHub Actions secrets each session |
| S3 bucket creation in Terraform | Blocked (object lock read is denied) | Create buckets with a CLI script, then manage their settings in Terraform |
| Lab resets | Can delete everything in the account | Every resource must be in Terraform or a script, so it can be rebuilt |

Region: us-east-1.

## Architecture
- **GitHub** sends signed webhooks to **API Gateway** (HTTPS). GitHub Actions builds images.
- **4 Lambdas:** webhook receiver, SAST worker (container image), dashboard (page, login, and API), notifier.
- **SQS** with a **dead-letter queue**: 3 retries, then the notifier posts an `error` status. PR scans fail closed.
- **Step Functions** deploy gate: register a task definition with the new image, start staging, wait until healthy and read its private IP, run the pentest task and wait, stop staging. Every state has a timeout and a Catch that routes to teardown.
- **ECS Fargate**, two separate tasks in public subnets. `staging-sg` allows TCP 4000 only from `pentest-sg`. The pentest targets staging's private IP. Public IPs are for outbound only. No NAT Gateway.
- The SAST worker runs outside the VPC. It needs the GitHub API and never talks to staging.
- **DynamoDB** (Repos, Scans, Findings), **S3** (private reports, 15-minute pre-signed URLs), **Secrets Manager**, **ECR** (SHA-tagged images), **SNS** (email alerts), **EventBridge Scheduler** (nightly runs), **CloudWatch** (logs, metrics, alarms).
- **Terraform** for all infrastructure, state in S3 with versioning and locking.
- GitHub access uses a personal access token in Secrets Manager and commit statuses.

## Interfaces
Changes need the owner's approval and an update to this file in the same pull request.

### SQS scan job message (owner: Shahana)
```json
{ "repo": "safemerge-cs6620/safemerge-demo-api", "pr": 42, "headSha": "abc123", "baseSha": "def456",
  "deliveryId": "github-delivery-uuid" }
```
The SAST worker lists the PR's changed files itself, so the webhook replies within GitHub's 10-second limit.

### Step Functions input (owner: Aniket)
```json
{ "repo": "safemerge-cs6620/safemerge-demo-api", "commitSha": "abc123",
  "image": "<account>.dkr.ecr.us-east-1.amazonaws.com/demo-api:abc123", "mode": "deploy" }
```
`mode` is `deploy` or `nightly`.

`commitSha` is the full 40-character `GITHUB_SHA`, because the notifier only accepts a full sha. The image tag stays the 7-character short sha. The deploy gate posts the `safemerge/deploy-gate` commit status itself through the notifier (the `notifier_function_name` variable): `success` when the pentest exits 0 and staging is stopped, `failure` when it exits 1, and `error` for anything else (exit 2 or 3, staging not healthy, a teardown or Step Functions error).

### Notifier input (owner: Shahana)
```json
{ "repo": "safemerge-cs6620/safemerge-demo-api", "pr": 42, "sha": "abc123", "context": "safemerge/sast",
  "state": "failure", "description": "2 new HIGH, 1 fixed",
  "targetUrl": "https://<dashboard>/scans/<scanId>",
  "comments": [{ "path": "src/app.js", "line": 12, "body": "Hardcoded secret" }] }
```
`context` is `safemerge/sast` or `safemerge/deploy-gate`. `state` is `pending`, `success`, `failure`, or `error`. The notifier only accepts a full 40-character `sha`.

### Pentest exit codes (owner: Aniket)
`scanners/pentest/run-scan.sh` exits with:

| Exit code | Meaning | Gate result |
|---|---|---|
| 0 | Scan ran, no HIGH failures | Pass |
| 1 | Scan ran, at least one result with status FAIL and severity HIGH | Block the production deploy (`failure`) |
| 2 | Staging unreachable | `error` |
| 3 | Pentest server did not start | `error` |

### SAST scan record (owner: Srujan)
The SAST worker saves one Scans item per scan:
```json
{
  "repo": "safemerge-cs6620/safemerge-demo-api",
  "scanKey": "2026-11-24T15:04:05.123Z#3f2b9c1e-...",
  "scanId": "3f2b9c1e-...",
  "scanTime": "2026-11-24T15:04:05.123Z",
  "repoPr": "safemerge-cs6620/safemerge-demo-api#42",
  "type": "SAST",
  "pr": 42,
  "sha": "<full 40-character SHA>",
  "status": "fail",
  "counts": { "HIGH": 2, "MEDIUM": 1, "LOW": 0 },
  "reportKey": "reports/safemerge-cs6620/safemerge-demo-api/3f2b9c1e-....json",
  "deliveryId": "<GitHub delivery ID>",
  "ttl": 1798000000
}
```
- `repo` + `scanKey` are the table keys. `scanKey` is `scanTime#scanId`, with `scanTime` in ISO 8601 UTC, so scans sort by time.
- `repoPr` + `scanTime` feed the `byPr` index (latest scan for a PR).
- `status` is `fail` if any HIGH finding, `pass` otherwise, and `error` if the scan itself broke.
- `ttl` is Unix time in seconds, set to now + 90 days.
- Each finding in the S3 report keeps `ruleId`, `severity`, `file`, `line`, and the matched code line, which S2-4 uses for fingerprints.

**Duplicate deliveries:** GitHub can deliver the same webhook more than once, and SQS can redeliver a message. The SAST worker claims each delivery with a conditional DynamoDB update on a marker item (`repo = "delivery"`, `scanKey = <deliveryId>`). The claim succeeds only if the marker does not exist, or if it is still `processing` and its lease (`leaseUntil`, 120 s) has expired, so a crashed attempt can be retried but two workers never scan at once. The marker holds `scanId` and `scanTime` (set once with `if_not_exists`), so a retry reuses them and writes the same Scans item instead of a second one. The marker is set to `done` only after the notifier call succeeds; a delivery that is `done` or still inside its lease is skipped. Markers expire after 7 days (`ttl`). The queue visibility timeout is 360 s, `maxReceiveCount` is 3, and the Lambda timeout is 60 s (batch size 1, `ReportBatchItemFailures`).

### Pentest scan record (owner: Srujan)
Each deploy gate run saves one Scans item with `type = "PENTEST"`, `sha`, `status` (`pass`, `fail`, or `error`), per-test counts (`passed`, `failed`, `warnings`), and `reportKey`. It uses the same `repo`, `scanKey`, `scanId`, `scanTime`, and `ttl` fields as the SAST record, without `pr` or `repoPr`. The full JSON report goes to S3 at `reports/{repo}/{scanId}.json`.

### DynamoDB tables (owner: Srujan)
| Table | Partition key | Sort key | Main attributes |
|---|---|---|---|
| Repos | repo | none | severity threshold, staging allowlist, alert email |
| Scans | repo | scanKey (scanTime#scanId) | type, sha, pr, status, severity counts, reportKey, ttl (90 days) |
| Scans GSI `byPr` | repoPr (repo#pr) | scanTime | latest scan for a PR |
| Findings | repo | findingKey (filePath#fingerprint) | ruleId, severity, line, open or fixed, firstSeenSha, lastSeenSha, fixedAt, ttl |

Fingerprint = hash of rule ID + file path + normalized code line, without the line number, so moved code is not reported as new.

### Other names
| Item | Value | Owner |
|---|---|---|
| Commit status contexts | `safemerge/sast`, `safemerge/deploy-gate` | Shahana |
| Notifier function | `sm-<env>-notifier` (callers read it from the `NOTIFIER_FUNCTION_NAME` environment variable) | Shahana |
| S3 report path | `reports/{repo}/{scanId}.json` | Srujan |
| ECR repositories | `safemerge-sast`, `safemerge-pentest`, `demo-api` | Aniket |
| Image tags | Commit SHA only, never `latest` | Aniket |
| Secrets | `sm/github-token`, `sm/webhook-secret`, `sm/github-oauth`, `sm/session-secret` | Srujan |
| Dashboard login allowlist | `srujan-codes`, `shahana-neu`, `aniketnandi` | Srujan |

## Conventions
- Tags on every resource: `project=safemerge`, `env=prod|dev`, `owner=<name>`. Names start with `sm-<env>-`.
- Build images with `--platform linux/amd64`. Lambda images also need `--provenance=false`.
- Each person tests in their own Learner Lab account with their own Terraform state. Only Srujan applies to production.
- New image tags reach production through a pull request that updates the tag variable in `terraform/variables.tf`, then a manual apply. CI never runs `terraform apply`.
- After testing, stop tasks or run `terraform destroy`, then end the lab session.
- Buckets are created with CLI scripts in the repo (see `terraform/bootstrap/`).

## Definition of done
1. Tested in your own Learner Lab account
2. All AWS resources are in Terraform, or in a script in the repo for S3 buckets
3. Pull request reviewed by the area steward and merged
4. Applied to production by Srujan
5. This file updated if an interface changed

## GitHub settings (not in Terraform)
Demo repo branch protection on `main`:
- Now: require a pull request with 1 approval.
- Once the webhook, SAST worker, and notifier run in production: also require the `safemerge/sast` status check, with no bypassing.
