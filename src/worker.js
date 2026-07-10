const COOKIE_NAME = "tracker_auth";
const SESSION_DAYS = 30;
const KV_KEY = "state";
const BACKUP_KV_KEY = "state:backup";
const EMPTY_STATE = { completion: {}, dates: {} };
const MAX_STATE_BYTES = 64 * 1024;
const MAX_STATE_ENTRIES = 250;
const AUTH_WINDOW_SECONDS = 15 * 60;
const AUTH_MAX_FAILURES = 8;
const KEY_PATTERN = /^[A-Z]{3}\d{4}:\d{1,2}$/;
const ISO_DATE_PATTERN = /^2026-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

function b64urlEncode(bytes) {
  let str = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob((str + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload, secret) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(payload),
  );
  return b64urlEncode(signature);
}

async function verifySig(payload, signature, secret) {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(signature),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Frame-Options": "DENY",
  };
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...securityHeaders(),
      ...(init.headers || {}),
    },
  });
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function authRateKey(request) {
  return `auth-fail:${clientIp(request)}`;
}

async function getAuthFailures(request, env) {
  const raw = await env.TRACKER.get(authRateKey(request));
  const count = Number.parseInt(raw || "0", 10);
  return Number.isFinite(count) ? count : 0;
}

async function recordAuthFailure(request, env) {
  const count = (await getAuthFailures(request, env)) + 1;
  await env.TRACKER.put(authRateKey(request), String(count), {
    expirationTtl: AUTH_WINDOW_SECONDS,
  });
  return count;
}

async function clearAuthFailures(request, env) {
  await env.TRACKER.delete(authRateKey(request));
}

async function issueCookie(env, requestUrl) {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ iat: now, exp: now + SESSION_DAYS * 86400 });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const token = `${payloadB64}.${await sign(payloadB64, env.SESSION_SECRET)}`;
  const secure = new URL(requestUrl).protocol === "https:" ? " Secure;" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearCookieHeader(requestUrl) {
  const secure = new URL(requestUrl).protocol === "https:" ? " Secure;" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=0`;
}

async function isAuthed(request, env) {
  if (!env.SESSION_SECRET) return false;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const dot = match[1].indexOf(".");
  if (dot < 1) return false;
  const payloadB64 = match[1].slice(0, dot);
  const signature = match[1].slice(dot + 1);
  if (!(await verifySig(payloadB64, signature, env.SESSION_SECRET))) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    const now = Math.floor(Date.now() / 1000);
    return Number.isFinite(payload.iat) && Number.isFinite(payload.exp) && payload.iat <= now + 60 && payload.exp >= now;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function validateState(data) {
  if (!isPlainObject(data) || !isPlainObject(data.completion) || !isPlainObject(data.dates)) {
    return "invalid_shape";
  }
  const completionEntries = Object.entries(data.completion);
  const dateEntries = Object.entries(data.dates);
  if (completionEntries.length + dateEntries.length > MAX_STATE_ENTRIES) return "too_many_entries";

  for (const [key, value] of completionEntries) {
    if (!KEY_PATTERN.test(key) || !["done", "undone"].includes(value)) return "invalid_completion";
  }
  for (const [key, value] of dateEntries) {
    if (!KEY_PATTERN.test(key) || !isPlainObject(value)) return "invalid_dates";
    const keys = Object.keys(value);
    if (keys.some((name) => !["open", "due"].includes(name))) return "invalid_dates";
    if (value.open !== null && value.open !== undefined && !isValidIsoDate(value.open)) return "invalid_dates";
    if (!isValidIsoDate(value.due)) return "invalid_dates";
    if (value.open && value.open > value.due) return "invalid_dates";
  }
  return null;
}

async function parseJsonRequest(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.toLowerCase().includes("application/json")) return { error: "content_type_required", status: 415 };
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_STATE_BYTES) return { error: "payload_too_large", status: 413 };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_STATE_BYTES) return { error: "payload_too_large", status: 413 };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: "invalid_json", status: 400 };
  }
}

async function readState(env) {
  const raw = await env.TRACKER.get(KV_KEY);
  if (!raw) return { version: 0, data: { ...EMPTY_STATE } };
  try {
    const parsed = JSON.parse(raw);
    const error = validateState(parsed.data);
    if (!Number.isFinite(parsed.version) || error) throw new Error(error || "invalid_version");
    return { version: parsed.version, data: parsed.data };
  } catch (error) {
    console.error("Invalid tracker state in KV", error);
    return { version: 0, data: { ...EMPTY_STATE }, warning: "invalid_stored_state" };
  }
}

async function handleAuth(request, env) {
  if (request.method === "GET") return json({ authed: await isAuthed(request, env) }, { headers: { "Cache-Control": "no-store" } });

  if (request.method === "POST") {
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ error: "server_not_configured" }, { status: 500 });
    const failures = await getAuthFailures(request, env);
    if (failures >= AUTH_MAX_FAILURES) {
      return json({ error: "too_many_attempts" }, { status: 429, headers: { "Retry-After": String(AUTH_WINDOW_SECONDS) } });
    }
    const parsed = await parseJsonRequest(request);
    if (parsed.error) return json({ error: parsed.error }, { status: parsed.status });
    if (!constantTimeEqual(parsed.body?.password, env.ADMIN_PASSWORD)) {
      await recordAuthFailure(request, env);
      return json({ error: "invalid_credentials" }, { status: 401 });
    }
    await clearAuthFailures(request, env);
    return json({ authed: true }, { headers: { "Set-Cookie": await issueCookie(env, request.url), "Cache-Control": "no-store" } });
  }

  if (request.method === "DELETE") {
    return json({ authed: false }, { headers: { "Set-Cookie": clearCookieHeader(request.url), "Cache-Control": "no-store" } });
  }
  return json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET, POST, DELETE" } });
}

async function handleState(request, env) {
  if (request.method === "GET") return json(await readState(env), { headers: { "Cache-Control": "no-store" } });

  if (request.method === "PUT") {
    if (!(await isAuthed(request, env))) return json({ error: "unauthorised" }, { status: 401 });
    const parsed = await parseJsonRequest(request);
    if (parsed.error) return json({ error: parsed.error }, { status: parsed.status });
    const incomingVersion = parsed.body?.version;
    if (!Number.isInteger(incomingVersion) || incomingVersion < 0) return json({ error: "invalid_version" }, { status: 400 });
    const validationError = validateState(parsed.body?.data);
    if (validationError) return json({ error: validationError }, { status: 400 });

    const current = await readState(env);
    if (incomingVersion !== current.version) return json({ error: "version_conflict", current }, { status: 409 });
    const next = { version: current.version + 1, data: parsed.body.data };
    if (!current.warning) await env.TRACKER.put(BACKUP_KV_KEY, JSON.stringify(current));
    await env.TRACKER.put(KV_KEY, JSON.stringify(next));
    return json(next, { headers: { "Cache-Control": "no-store" } });
  }
  return json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET, PUT" } });
}

function withStaticSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (new URL(response.url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth") return handleAuth(request, env);
    if (url.pathname === "/api/state") return handleState(request, env);
    return withStaticSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

export { isValidIsoDate, validateState };
