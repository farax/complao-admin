# Complao action log portal

This is the admin portal described in *Complao Action Log Portal: Requirements and Acceptance Criteria* (13 Nov 2026). Every action in Complao (a login, an audit, a registration, an approval) becomes one record with its own ID. Every step that action triggered sits under it, with its latency, response and AI cost.

```
Complao services ──JSON events──▶ CloudWatch Logs ──scheduled pull──▶ DynamoDB action store ◀── Portal API ◀── React portal
 (packages/logger)                                   (apps/ingest Lambda)                     (apps/api)        (apps/web)
```

The design in section 6 is followed as written. The portal never queries CloudWatch directly; it reads only the action store, so every screen is a keyed read (see the FAQ in the doc for why).

## Try it locally (no AWS needed)

```bash
npm install
npm run demo        # API on :8787, portal on http://localhost:5173
```

Demo mode fills a simulated CloudWatch log group with a week of realistic traffic. People sign in, act in a role and take turns on audits, and five audits are always in progress so the Live view has something to show. The real puller reads it into an in-memory store, using the same checkpoint, overlap and pause logic as the Lambda. New actions keep arriving every 20 seconds. The demo data includes all six action types, nested Bedrock calls, wrong passwords, throttles, model errors, multi-day registration journeys, one stalled audit, one action with a lost event (Incomplete), and a never-seen-before `Test` action type (R12). Sign-in is skipped in demo mode.

**Static preview:** `npm run build:preview -w @complao/web` builds a version that runs entirely in the browser. The demo data, simulator and puller all run in the page, so you can host it on Vercel, Netlify or S3 with no backend. It's for showing people, not for real data.

## What's in the repo

| Path | What it is |
|---|---|
| `packages/core` | Event schema (Appendix A), status rules (R7), latency histograms, cost, and the `ActionStore` interface with two implementations: `DynamoStore` (Appendix B key design) and `MemoryStore` (demo and tests) |
| `packages/logger` | **Phase 0** library for Complao's services. `startAction`, `step`, `continueAction` (from `traceparent`), `bedrockUsage`. Writes never throw or block (R2). |
| `apps/ingest` | The scheduled Lambda (section 6.3). Reads each log group from its checkpoint, minus a 2-minute overlap, catches up in bounded windows, honours pause and interval, and pulls twice a minute at the 30-second setting. |
| `apps/api` | Express API with password + TOTP sign-in (R13). It resolves user IDs to names at read time (R15), records views (R16), and holds the queries behind every view. |
| `apps/web` | React portal: Mantine 8, mantine-datatable, Mantine Charts, TanStack Query |
| `infra/template.yaml` | SAM template: table and GSIs with no TTL, the Lambda (reserved concurrency 1, every minute), scoped IAM roles (R14), and App Runner for the portal |
| `tests/` | Acceptance tests mapped to R-numbers (including R22 to R24 for sessions and Live), plus a DynamoDB-emulator run that checks `DynamoStore` gives the same output as `MemoryStore` for every view |
| `docs/` | The requirements addendum for sessions, Live and multi-person journeys |

## The views

1. **Live** (R23, the landing page): everything happening right now, grouped by case with one lane per person (auditor, TIC, CB, admin). Bars are actions, circles are sign-ins and diamonds are sign-outs. Running actions grow until they finish, and failures are red. Select any bar to see its full step tree without leaving the page. Below the timeline is everyone currently signed in.
2. **Actions** (R4, R5): newest first, filtered by type, status (including Incomplete), role, initiator and dates. Paste an action ID, a `traceparent` or a case ID into the top search.
3. **Sessions** (R22): every sign-in, login to logout, marked Active, Idle, Signed out or Expired. Open one to see everything that person did in that visit, in order, with the gaps between actions and the cases they worked on.
4. **Action detail** (R6, R7, R18): the indented step tree with a waterfall timeline. The slowest step is highlighted, and failed steps are red and opened. The header shows status, duration, initiator and role, AI cost and tokens. It links to the person's session and to the case journey.
5. **Case journey** (R18, R24): every action on one audit or registration. "Who did what" shows a lane per person across all their sessions; below it is the same work in time order, with the waiting time between turns.
6. **Component health** (R19, R20, R21): requests, success rate, median and 95th percentile for the last hour, 24 hours or 7 days, each compared with the previous period. Components with a server-side failure or a step over 60 seconds are flagged Degraded; a wrong password doesn't count. Select a component to see its failed and slowest steps. AI cost is shown per day and per week.
7. **Logs by area** (R8): every step one component recorded, filtered by step name, status, response code, dates and action ID, with an option to sort failures first.

Sessions, Live and multi-person journeys are specified in [`docs/requirements-addendum-sessions.md`](docs/requirements-addendum-sessions.md). That document adds two fields to the log format: `session_id` and `actor_role`.

**Settings** covers the pull interval (30 s to 24 h) and pause (R9), the stalled, degraded and session idle/expiry thresholds, display names for action types and components (R12), the AI price table, and the currency. Costs show in AUD with USD in brackets by default; you can change this.

## Deploying to AWS

```bash
# 1. Secrets for the shared admin login
npm run setup:admin          # prints ADMIN_PASSWORD_HASH, ADMIN_TOTP_SECRET, SESSION_SECRET and an otpauth link
aws secretsmanager create-secret --name complao/action-log-portal --secret-string '{"ADMIN_PASSWORD_HASH":"…","ADMIN_TOTP_SECRET":"…","SESSION_SECRET":"…"}'

# 2. Portal image
docker build -t complao-action-log-portal .
# push to ECR …

# 3. Table, ingester and portal
npm run build -w @complao/ingest
sam deploy -t infra/template.yaml --guided \
  --parameter-overrides LogGroupPrefix=/complao/ PortalImageUri=<ecr-uri> PortalSecretArn=<arn> UserLookupUrl=<read-only lookup>
```

Leave `PortalImageUri` empty to deploy only the table and ingester (Phase 0/1 data before the UI).

**User lookup (R15).** Point `USER_LOOKUP_URL` at a read-only Complao endpoint that takes `POST {"ids": [...]}` and returns `{"<id>": "<name>"}`. Names are cached in memory for 5 minutes and are never written to the store. If the lookup is down, the portal shows IDs instead of failing.

**Log retention (R17).** The action store has no TTL. Set the Complao log groups to *Never expire*.

## Instrumenting a service (Phase 0)

```ts
import { createActionLogger, bedrockUsage } from '@complao/logger';
const log = createActionLogger({ component: 'Audit engine' });

// sessionId comes from your auth layer (the session or token ID); actorRole is the role they're acting in.
const action = log.startAction({ actionType: 'Audit', actorId: user.id, actorRole: 'Auditor', sessionId: req.session.id, caseId: audit.id });
try {
  await action.run(async () => {
    await log.step('Load audit template', () => loadTemplate(audit));
    await log.step('Bedrock call', async (s) => {
      const res = await bedrock.send(cmd);
      Object.assign(s.details, bedrockUsage(modelId, res));   // model + token counts, never the prompt
      await log.step('Response validation', () => validate(res));  // nests under the call
    }, { component: 'Amazon Bedrock' });
  });
  action.end('success');
} catch (e) { action.end('failure'); throw e; }

// Downstream service: pass action.traceparent() in the traceparent header or a queue attribute
log.continueAction({ traceparent: req.headers.traceparent, actorId, actorRole, sessionId, caseId }, () => …);

// Sign-in and sign-out are ordinary actions: type 'Login' opens a session, 'Logout' closes it.
```

## Decisions worth knowing

- **Idempotent ingestion.** Steps are keyed by action ID, start time and step ID. Counters (AI cost, health windows, daily cost) only move the first time a step is written, so the 2-minute overlap and pause/resume never double count. The tests check this for R9.
- **Status is derived when read,** not stored. That way Stalled reflects "now", and changing the stalled limit applies straight away. Session status (Active, Idle, Signed out, Expired) works the same way.
- **Sessions are built from events,** not from a separate feed. Every event carrying a `session_id` extends that session's record. A `Login` action marks the sign-in and a `Logout` marks the sign-out; a session with no sign-out shows as Expired after the timeout.
- **Incomplete** means the start event is missing, or a step names a parent that never arrived. The tree shows orphans at the top level, marked "parent missing".
- **Percentiles** come from 80 geometric latency buckets per 5-minute window (ratio 1.2), so they are accurate to about ±10%. Section 6.4 explains why histograms are used.
- **Server-side failure** means a failed step with a code of 500 or above (configurable). A failed step with a non-numeric code also counts, unless the code reads like a client error. A 4xx shows in the logs and success rate but never flags Degraded.
- **AI cost** uses the price table in force at pull time. Changing a price applies to calls pulled afterwards, not to history.
- **IAM caveat (R14 vs R16).** Recording views (R16) means the portal must write somewhere other than the pull setting. The portal role may write the `SETTINGS` partition and `V#<actionId>` view items, and nothing else. IAM can't restrict by sort key, so the API itself limits `SETTINGS` writes to `pull` and `config`.

## Scripts

`npm run demo` · `npm run dev` (real store; needs `.env`, see `.env.example`) · `npm test` · `npm run typecheck` · `npm run build` · `npm run setup:admin`
