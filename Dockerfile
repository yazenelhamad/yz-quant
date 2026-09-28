# API + built dashboard in one container (the API serves apps/web/dist on the same origin).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY tsconfig.base.json tsconfig.json ./
RUN npm ci
RUN npm run build -w apps/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/data
EXPOSE 8787
# Run migrations, then start. Provide DATABASE_URL, SECRETS_MASTER_KEY, SESSION_SECRET, APP_ORIGIN, API_ORIGIN.
CMD ["sh", "-c", "npx tsx scripts/migrate.ts && HOST=0.0.0.0 npx tsx apps/api/src/main.ts"]
