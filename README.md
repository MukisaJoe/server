# LoveApp Sync Server

Node/Express + MongoDB sync backend for LoveApp.

## Endpoints

- `GET /healthz` basic process health
- `GET /readyz` DB readiness (`ping`)
- `POST /accounts/register`
- `POST /accounts/login`
- `POST /accounts/link`
- `POST /sync/push`
- `GET /sync/pull?spaceId=...`
- `GET /dashboard/:spaceId`
- `GET /insights/mood/:spaceId?days=7`

If `SYNC_API_KEY` is set, all requests must include header:

- `x-api-key: <SYNC_API_KEY>`

## Render Deploy

1. Push repo to GitHub.
2. In Render, create a new **Web Service** from repo.
3. Use `server/sync-server/render.yaml` (Blueprint) or set:
- Root Directory: `server/sync-server`
- Build Command: `npm ci`
- Start Command: `npm start`
4. Set env vars:
- `MONGODB_URI`
- `MONGODB_DB=loveapp`
- `SYNC_API_KEY=<long-random-secret>`
- `CORS_ORIGINS=*` (or your domain/app list)

## Verify

```bash
curl -sS https://<your-render-domain>/healthz
curl -sS https://<your-render-domain>/readyz
```

With API key:

```bash
curl -sS https://<your-render-domain>/readyz \
  -H "x-api-key: <SYNC_API_KEY>"
```

## Local Run

```bash
cp .env.example .env
npm install
npm start
```
# server
