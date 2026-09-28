# yz-quant

Private, two-user autonomous trading intelligence platform that executes through **Robinhood Agentic Trading** (the official MCP surface). One shared intelligence stack, two strictly isolated trading environments.

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Security model: [`docs/SECURITY.md`](docs/SECURITY.md)
- Robinhood capability map: [`docs/robinhood/ROBINHOOD_AGENTIC_TRADING.md`](docs/robinhood/ROBINHOOD_AGENTIC_TRADING.md)

## Quick start (development)

```bash
npm install
cp .env.example .env            # fill SECRETS_MASTER_KEY and SESSION_SECRET (openssl rand -base64 32)
npm run db:migrate
npm run bootstrap               # provisions the two users interactively; there is no signup route
npm run dev:api                 # http://localhost:8787 (API)
npm run dev:web                 # http://localhost:5173 (dashboard with /api proxy)
```

Single-process launch (API serves the built dashboard on the same origin):

```bash
npm run build -w apps/web
APP_ORIGIN=http://localhost:8787 npm run start -w apps/api   # open http://localhost:8787
```

Non-interactive provisioning of the two users:

```bash
BOOTSTRAP_USERS='[{"email":"a@example.com","displayName":"User A","role":"admin","password":"..."},{"email":"b@example.com","displayName":"User B","role":"trader","password":"..."}]' npm run bootstrap
```

After signing in: enrol MFA (Settings → Security), connect the Robinhood Agentic account (Settings → Robinhood), keep the account in `research_only`/`shadow` until shadow results justify raising autonomy.

`DATABASE_URL=pglite://./data/pglite` runs an embedded PostgreSQL for development. Use a real `postgres://` URL in production.

## Tests

```bash
npm run typecheck
npm test
```
