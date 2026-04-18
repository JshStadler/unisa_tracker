# UNISA Tracker — Cloudflare Pages deployment

Static tracker with server-backed dates (Cloudflare KV) and password-gated editing.
Read access is public; writes require unlocking via the `🔒 Unlock to edit` button.

## Project layout

```
public/
  index.html              Tracker UI (modified: loads state from /api/state)
functions/api/
  _auth.js                HMAC-signed cookie helpers (shared)
  auth.js                 GET/POST/DELETE /api/auth
  state.js                GET/PUT /api/state (public GET, auth-gated PUT)
wrangler.toml             Pages + KV binding config
.dev.vars.example         Copy to .dev.vars for local dev
```

## One-time setup

### 1. Install wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Create the KV namespace

```bash
wrangler kv namespace create TRACKER
```

This prints something like:

```
[[kv_namespaces]]
binding = "TRACKER"
id = "abc123..."
```

Copy the `id` value into `wrangler.toml`, replacing `REPLACE_WITH_ID_FROM_WRANGLER_KV_CREATE`.

### 3. Create the Pages project

```bash
wrangler pages project create unisa-tracker --production-branch main
```

### 4. Set secrets

```bash
# Your admin password (whatever you want to type to unlock)
wrangler pages secret put ADMIN_PASSWORD --project-name unisa-tracker

# A random 32+ char string for signing auth cookies. Generate with:
#   openssl rand -base64 32
wrangler pages secret put SESSION_SECRET --project-name unisa-tracker
```

### 5. Bind the KV namespace to the Pages project

The `wrangler.toml` binding only covers local dev. For production, bind it in the dashboard:

**Cloudflare dashboard → Workers & Pages → unisa-tracker → Settings → Bindings → Add → KV namespace**
- Variable name: `TRACKER`
- KV namespace: `TRACKER` (the one created in step 2)
- Apply to both Production and Preview environments.

### 6. Deploy

```bash
wrangler pages deploy public --project-name unisa-tracker
```

Your site is live at `https://unisa-tracker.pages.dev` (or your custom domain).

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with a local password + session secret

wrangler pages dev public
```

Opens on `http://localhost:8788`. KV reads/writes use a local filesystem-backed namespace — no production data touched.

## How it works

- **Read:** `GET /api/state` → returns `{version, data: {completion, dates}}` from KV. Public, no auth.
- **Write:** `PUT /api/state` → requires valid `tracker_auth` cookie. Body is `{version, data}`; server rejects with 409 if client's version is stale (two-tab conflict), and the client rebases and retries once automatically.
- **Auth:** `POST /api/auth {password}` → HMAC-signed cookie, 30-day expiry, HttpOnly + SameSite=Strict. No session in KV — signature is self-validating.
- **Lock:** clicking the green `🔓` button calls `DELETE /api/auth` to clear the cookie.

## Updating the tracker later

Just edit `public/index.html` and rerun `wrangler pages deploy public --project-name unisa-tracker`. State in KV is preserved across deploys.

## Resetting state

From the footer while unlocked: `↺ Reset overrides` clears all dates and completion overrides.
Or nuke directly: `wrangler kv key delete --binding=TRACKER "state"` (use `--remote` for production).

## Security notes

- The cookie is `HttpOnly` + `SameSite=Strict`, so it can't be read by JS or sent cross-site.
- There is no rate limiting on `/api/auth` — family-only site, password is the only gate. If the URL ever leaks publicly, rotate `ADMIN_PASSWORD` and consider adding rate limiting.
- Rotating `SESSION_SECRET` invalidates all existing sessions (everyone has to unlock again). Useful if you ever suspect cookie compromise.
