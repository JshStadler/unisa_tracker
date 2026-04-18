// Shared auth helpers: HMAC-signed stateless cookies.
// Cookie format: <base64url(payload)>.<base64url(hmac)>
// Payload = JSON { iat: epochSeconds, exp: epochSeconds }

const COOKIE_NAME = "tracker_auth";
const SESSION_DAYS = 30;

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
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(payloadStr, secret) {
  const key = await hmacKey(secret);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadStr));
  return b64urlEncode(sig);
}

async function verifySig(payloadStr, sigB64, secret) {
  const key = await hmacKey(secret);
  const enc = new TextEncoder();
  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sigB64),
      enc.encode(payloadStr)
    );
  } catch {
    return false;
  }
}

// Constant-time string comparison for password check.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function issueCookie(env, requestUrl) {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ iat: now, exp: now + SESSION_DAYS * 86400 });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const sig = await sign(payloadB64, env.SESSION_SECRET);
  const token = `${payloadB64}.${sig}`;

  const isHttps = new URL(requestUrl).protocol === "https:";
  const secureFlag = isHttps ? " Secure;" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly;${secureFlag} SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearCookieHeader(requestUrl) {
  const isHttps = new URL(requestUrl).protocol === "https:";
  const secureFlag = isHttps ? " Secure;" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secureFlag} SameSite=Strict; Max-Age=0`;
}

export async function isAuthed(request, env) {
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
    if (typeof payload.exp !== "number" || payload.exp < now) return false;
    return true;
  } catch {
    return false;
  }
}

export function checkPassword(supplied, env) {
  if (!env.ADMIN_PASSWORD) return false;
  if (typeof supplied !== "string") return false;
  return constantTimeEqual(supplied, env.ADMIN_PASSWORD);
}

export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
