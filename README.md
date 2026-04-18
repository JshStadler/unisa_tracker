# UNISA Tracker — Cloudflare Workers deployment

Static tracker + auth-gated API, deployed as a single Cloudflare Worker with static assets.
Read access is public; writes require unlocking via the `🔒 Unlock to edit` button.

## Project layout

```
public/
  index.html              Tracker UI (served via Workers Assets)
src/
  worker.js               Single entry point: routes /api/* and serves assets
wrangler.toml             Worker + Assets + KV config
.dev.vars.example         Copy to .dev.vars for local dev
```

## Routes

- `GET  /api/auth`   → `{ authed: boolean }`
- `POST /api/auth`   → body `{ password }` → sets HMAC-signed cookie on success
- `DELETE /api/auth` → clears cookie
- `GET  /api/state`  → `{ version, data: { completion, dates } }` — public
- `PUT  /api/state`  → body `{ version, data }` — requires auth, 409 on version mismatch
- everything else    → served from `/public` via the `ASSETS` binding

## One-time setup

### 1. Create the KV namespace

```bash
wrangler kv namespace create TRACKER
```

Copy the printed `id` into `wrangler.toml`, replacing `REPLACE_WITH_ID_FROM_WRANGLER_KV_CREATE`.

### 2. Push to Git + connect to Cloudflare

Commit and push to your Git repo. Then in the dashboard:

**Workers & Pages → Create → Workers → Import a repository**

Pick the repo. Cloudflare will auto-detect `wrangler.toml` and default to `npx wrangler deploy`, which is correct this time.

### 3. Set secrets

Two options — either from your terminal:

```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET   # use: openssl rand -base64 32
```

Or via the dashboard: **Workers & Pages → unisa-tracker → Settings → Variables and Secrets → Add**. Mark both as type "Secret".

### 4. Deploy

If connected via Git, just push to your production branch — Cloudflare auto-deploys.
If deploying from your machine:

```bash
wrangler deploy
```

Your site is live at `https://unisa-tracker.<your-subdomain>.workers.dev` (or your custom domain).

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with a local password + session secret

wrangler dev
```

Opens on `http://localhost:8787`. KV reads/writes use a local filesystem-backed namespace — no production data touched.

## How it works

- **Assets** — the `[assets]` binding serves everything in `./public` directly (HTML, fonts, etc). The Worker only handles paths it explicitly routes; everything else falls through to `env.ASSETS.fetch(request)`.
- **Auth** — `POST /api/auth` with the right password returns a signed cookie (HMAC-SHA256 over payload `{iat, exp}`, 30-day expiry). `PUT /api/state` verifies the signature per-request; no session storage in KV.
- **Concurrency** — KV holds `{version, data}`. Every write bumps `version`. PUTs include the version the client thinks is current; a mismatch returns 409 and the client rebases once automatically.

## Updating the tracker later

Edit `public/index.html` (or `src/worker.js`) and push. KV state is preserved across deploys.

## Resetting state

From the footer while unlocked: `↺ Reset overrides` clears everything.
Or directly: `wrangler kv key delete --binding=TRACKER --remote "state"`.

## Security notes

- Cookie is `HttpOnly` + `SameSite=Strict`; can't be read by JS or sent cross-site.
- No rate limiting on `/api/auth` — family-only site, password is the only gate.
- Rotating `SESSION_SECRET` invalidates all existing sessions. Useful if you ever suspect cookie compromise.
