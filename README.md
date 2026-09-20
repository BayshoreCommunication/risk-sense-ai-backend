# RiskSense AI backend

Express 5, TypeScript, Mongoose, and Zod API for the RiskSense AI assessment workflow.
The implementation-facing documentation is in `../docs/ai/`; the source TAC requirements package is
Draft v1 and is not signed acceptance.

## Local setup

```bash
cp .env.example .env
npm ci
npm run seed
npm run seed:content
npm run dev
```

The API is served at `http://localhost:4000/api/v1`. The development seed creates placeholder
identities that can be selected through `AUTH_DEV_BYPASS=true`. That bypass and the console mailer
are rejected when `NODE_ENV=production`.

The seeded `requestor@dev.local` identity belongs to the shared FREE tenant. The optional
`requestor@tac.local` identity and the managed
`admin@dev.local`, `admin2@dev.local`, `sysadmin@dev.local`, and `audit@dev.local` identities belong
to the PAID TAC demo tenant. FREE provisioning accepts requestor accounts only; administrator,
system-administrator, and audit roles require a PAID tenant. Authentication also rejects a legacy
managed-role row that still points at a FREE tenant, before any application session is created.
Re-run `npm run seed` to reconcile the known development identities. For another legacy account,
use the trusted `npm run user:create -- --email ... --name ... --role requestor --tenant public`
operator path to demote it, or move it to a PAID tenant with its approved managed role.
The plan also controls current-login assurance: FREE requestors never require MFA, even if a legacy
`authPolicy.otpRequired` value is `true`; every PAID account requires MFA on the current login,
even if that stored compatibility value is `false`. PAID requestors can satisfy the requirement with
Firebase-verified MFA through their configured IdP or the RiskSense email OTP fallback. PAID managed
roles use the RiskSense OTP. The tenant settings endpoint accepts the legacy field for older clients
but reports and persists its effective plan-derived value. The explicit non-production development
bypass remains exempt.
`npm run seed:content` publishes the reviewed starter library to both the shared FREE namespace and
the TAC demo tenant, so the FREE requestor and PAID administrator demos remain usable without a
managed account in the FREE tenant.

Production signup/sign-in also requires a real Firebase project. The application accepts an app
session only after Firebase reports a verified email; authorized domains, verification-email
template/delivery, and the later application OTP flow must be configured and tested externally.

To provision the same password demo requestor in a configured local or deployed environment, set
`DEMO_USER_PASSWORD` in the untracked environment alongside that environment's
`MONGODB_URI`, `FIREBASE_PROJECT_ID`, and `FIREBASE_SERVICE_ACCOUNT_B64`, then run:

```bash
npm run demo:provision-requestor
```

The command only creates or updates the enabled, email-verified Firebase password identity
`requestor@dev.local` and reconciles its Mongo user row to that Firebase UID. It requires the
existing `public` tenant to be FREE and refuses to move an existing account, change its role, or
reuse a UID owned by another Mongo user. It never creates a tenant or managed role and never prints
the password; the password must be at least 8 characters. A changed Mongo row and its append-only
audit event commit in one transaction. Firebase is necessarily updated before that database
transaction; if Mongo or audit persistence fails, correct the reported database issue and rerun the
same command to converge safely. The configured Firebase project and Mongo URI are the mutation
target, so verify both before running it; the Mongo deployment must support transactions. A
frontend quick-fill deployment must use the same throwaway value in its public demo-password
configuration.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run openapi
```

The automated suite uses a temporary MongoDB replica set so transaction behavior is exercised.
`npm run test:ai-live` is separate, opt-in, billable, and performs one synthetic schema-validated
persona inference only:

```bash
RUN_AI_LIVE=1 AI_PROVIDER=openai OPENAI_API_KEY=... npm run test:ai-live
```

## Operational scripts

| Command | Purpose |
|---|---|
| `npm run schema:scan` | Persist assessment conformance flags and a scan run |
| `npm run content:verify` | Check active content, approval records, links, scenario counts, and golden cases |
| `npm run rules:migrate-versions` | Dry-run the legacy-rule version/index migration; applying requires an exact database name |
| `npm run retention -- --dry-run` | Preview tenant retention enforcement |
| `npm run audit:verify` | Verify a tenant audit hash chain |
| `npm run load:smoke` | Run the local synthetic load harness |
| `npm run accuracy` | Calculate the decision accept-rate diagnostic |
| `npm run user:create -- --email ... --name ... --role ... --tenant ...` | Provision or reconcile one tenant account; managed roles require PAID |
| `npm run demo:provision-requestor` | Reconcile the fixed `requestor@dev.local` Firebase/Mongo FREE demo identity |

See `../docs/ai/DeploymentGuide.md` before using any script against a non-development database.

## Release boundary

Repository checks do not prove production readiness. Real Firebase/IdP authorized domains, verified-email
delivery/templates, SSO claims, OTP credentials, TAC
content and scoring approval, deployed TLS and independent security evidence, monitoring/SLO
evidence, Atlas backup/PITR drills, external cold storage, live-model validation, usability/UAT, and
legal approvals remain external release gates.
