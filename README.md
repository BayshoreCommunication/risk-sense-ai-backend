# risk-sense-ai-backend

Express 5 + TypeScript + Mongoose API for RiskSense AI. Workspace docs: `../docs/ai/`.

```bash
cp .env.example .env     # local mongod works out of the box; Firebase/OpenAI optional in Sprint 0
npm install
npm run seed             # tenants + dev users
npm run dev              # http://localhost:4000/api/v1/health
npm test
```

Dev login without Firebase (AUTH_DEV_BYPASS=true):

```bash
curl -s -X POST http://localhost:4000/api/v1/auth/session -H 'X-Dev-User: requestor@dev.local'
curl -s http://localhost:4000/api/v1/me -H 'X-Dev-User: requestor@dev.local' -H 'X-Session-Id: <sessionId>'
```

Layout: `src/config` (env), `src/lib` (db, logger, errors, hash, firebase, openai), `src/middleware` (auth, session, rbac, validate, error), `src/modules/<name>` (routes → service → model), `src/scripts` (seed, openapi, verify-audit), `src/tests`.
