# UNISA Tracker — Cloudflare Workers deployment

Static assessment tracker with a small authenticated API, deployed as one Cloudflare Worker with static assets.

Read access is public. Changes require unlocking through the **Unlock to edit** button.

## Project layout

```text
public/
  index.html              Tracker UI served through Workers Assets
  favicon.svg
src/
  worker.js               API routes, authentication and static asset fallback
test/
  worker.test.js          State/date validation tests
.github/workflows/
  check.yml               Tests and Wrangler deployment validation
wrangler.toml             Worker, Assets, KV and observability configuration
package.json              Pinned development tooling and scripts
.dev.vars.example         Local secret template
```

## API routes

- `GET /api/auth` returns the current authentication state.
- `POST /api/auth` accepts `{ "password": "..." }` and sets a signed session cookie.
- `DELETE /api/auth` clears the session cookie.
- `GET /api/state` returns `{ version, data: { completion, dates } }`.
- `PUT /api/state` validates and saves `{ version, data }`; authentication is required.
- Other paths are served from `public/` through the `ASSETS` binding.

## One-time setup

### 1. Create the KV namespace

```bash
wrangler kv namespace create TRACKER
```

Copy the resulting namespace ID into `wrangler.toml`.

### 2. Configure secrets

```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
```

Generate a strong session secret with:

```bash
openssl rand -base64 32
```

The same secrets can be added in **Workers & Pages → unisa-tracker → Settings → Variables and Secrets**.

### 3. Deploy

When the repository is connected to Cloudflare, pushes to the production branch deploy automatically. To deploy locally:

```bash
npm install
npm run deploy
```

## Local development

```bash
cp .dev.vars.example .dev.vars
# Add local ADMIN_PASSWORD and SESSION_SECRET values
npm install
npm run dev
```

The local Worker normally opens at `http://localhost:8787`. Local KV storage does not modify production data.

## Checks

Run the validation tests:

```bash
npm test
```

Run tests followed by a Wrangler dry-run build:

```bash
npm run check
```

GitHub Actions runs these checks for pushes to `main` and pull requests.

## Storage and conflict handling

KV stores one versioned state document under the `state` key. Each successful save increments the version. A stale client receives HTTP `409` and can reload/rebase its changes.

The Worker validates assessment keys, completion values, date formats, object shape, entry count and payload size before saving. The previous valid state is copied to `state:backup` before each write.

## Security

- Sessions use an HMAC-SHA256 signed, `HttpOnly`, `SameSite=Strict` cookie.
- Production cookies include the `Secure` attribute.
- Failed logins are limited per connecting IP using short-lived KV counters.
- API responses are not cached.
- Static and API responses include defensive browser security headers.
- State writes require authentication and strict server-side validation.
- Rotating `SESSION_SECRET` invalidates all current sessions.

## Resetting state

Use **Reset overrides** in the footer while unlocked, or delete the production KV key directly:

```bash
wrangler kv key delete --binding=TRACKER --remote "state"
```

The backup can be inspected or restored separately from the `state:backup` key if needed.
