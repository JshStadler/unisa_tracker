// Workers entry point.
// - /api/auth      GET  → { authed }
//                  POST → { password } → sets cookie, returns { authed: true }
//                  DELETE → clears cookie
// - /api/state     GET  → { version, data }
//                  PUT  → { version, data } (auth required, optimistic concurrency)
// - everything else → static asset from the [assets] binding (index.html and friends)

const COOKIE_NAME = "tracker_auth";
const SESSION_DAYS = 30;
const KV_KEY = "state";
const EMPTY_STATE = { completion: {}, dates: {} };

// ---------- helpers: base64url + hmac + cookies ----------

function b64urlEncode(bytes) {
  let str = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
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

async function sign(payloadStr, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadStr));
  return b64urlEncode(sig);
}

async function verifySig(payloadStr, sigB64, secret) {
  try {
    const key = await hmacKey(secret);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sigB64),
      new TextEncoder().encode(payloadStr),
    );
  } catch {
    return false;
  }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function issueCookie(env, requestUrl) {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ iat: now, exp: now + SESSION_DAYS * 86400 });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const sig = await sign(payloadB64, env.SESSION_SECRET);
  const token = `${payloadB64}.${sig}`;
  const isHttps = new URL(requestUrl).protocol === "https:";
  const secureFlag = isHttps ? " Secure;" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly;${secureFlag} SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearCookieHeader(requestUrl) {
  const isHttps = new URL(requestUrl).protocol === "https:";
  const secureFlag = isHttps ? " Secure;" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secureFlag} SameSite=Strict; Max-Age=0`;
}

async function isAuthed(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const token = match[1];
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await verifySig(payloadB64, sig, env.SESSION_SECRET))) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    const now = Math.floor(Date.now() / 1000);
    return typeof payload.exp === "number" && payload.exp >= now;
  } catch {
    return false;
  }
}

function checkPassword(supplied, env) {
  if (!env.ADMIN_PASSWORD || typeof supplied !== "string") return false;
  return constantTimeEqual(supplied, env.ADMIN_PASSWORD);
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// ---------- KV state ----------

async function readState(env) {
  const raw = await env.TRACKER.get(KV_KEY);
  if (!raw) return { version: 0, data: EMPTY_STATE };
  try {
    const parsed = JSON.parse(raw);
    return {
      version: typeof parsed.version === "number" ? parsed.version : 0,
      data: {
        completion: parsed.data?.completion || {},
        dates: parsed.data?.dates || {},
      },
    };
  } catch {
    return { version: 0, data: EMPTY_STATE };
  }
}

// ---------- route handlers ----------

async function handleAuth(request, env) {
  const method = request.method;

  if (method === "GET") {
    return json({ authed: await isAuthed(request, env) });
  }

  if (method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, { status: 400 }); }

    if (!checkPassword(body?.password, env)) {
      return json({ error: "invalid_password" }, { status: 401 });
    }
    return json(
      { authed: true },
      { headers: { "Set-Cookie": await issueCookie(env, request.url) } },
    );
  }

  if (method === "DELETE") {
    return json(
      { authed: false },
      { headers: { "Set-Cookie": clearCookieHeader(request.url) } },
    );
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
}

async function handleState(request, env) {
  const method = request.method;

  if (method === "GET") {
    const stored = await readState(env);
    return json(stored, { headers: { "Cache-Control": "no-store" } });
  }

  if (method === "PUT") {
    if (!(await isAuthed(request, env))) {
      return json({ error: "unauthorised" }, { status: 401 });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, { status: 400 }); }

    const incomingVersion = typeof body?.version === "number" ? body.version : null;
    const incomingData = body?.data;
    if (
      !incomingData ||
      typeof incomingData.completion !== "object" ||
      typeof incomingData.dates !== "object"
    ) {
      return json({ error: "invalid_shape" }, { status: 400 });
    }

    const current = await readState(env);
    if (incomingVersion !== null && incomingVersion !== current.version) {
      return json({ error: "version_conflict", current }, { status: 409 });
    }

    const next = {
      version: current.version + 1,
      data: {
        completion: incomingData.completion,
        dates: incomingData.dates,
      },
    };
    await env.TRACKER.put(KV_KEY, JSON.stringify(next));
    return json(next);
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
}

// ---------- main fetch handler ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname === "/api/auth") return handleAuth(request, env);
    if (url.pathname === "/api/state") return handleState(request, env);

    // Everything else → static assets
    return env.ASSETS.fetch(request);
  },
};
