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
npm run dev:api                 # http://localhost:8787
npm run dev:web                 # http://localhost:5173
```

`DATABASE_URL=pglite://./data/pglite` runs an embedded PostgreSQL for development. Use a real `postgres://` URL in production.

## Tests

```bash
npm run typecheck
npm test
```
