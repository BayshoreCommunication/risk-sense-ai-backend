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

Production signup/sign-in also requires a real Firebase project. The application accepts an app
session only after Firebase reports a verified email; authorized domains, verification-email
template/delivery, and the later application OTP flow must be configured and tested externally.

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

See `../docs/ai/DeploymentGuide.md` before using any script against a non-development database.

## Release boundary

Repository checks do not prove production readiness. Real Firebase/IdP authorized domains, verified-email
delivery/templates, SSO claims, OTP credentials, TAC
content and scoring approval, deployed TLS and independent security evidence, monitoring/SLO
evidence, Atlas backup/PITR drills, external cold storage, live-model validation, usability/UAT, and
legal approvals remain external release gates.
