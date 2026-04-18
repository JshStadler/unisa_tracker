import { issueCookie, clearCookieHeader, isAuthed, checkPassword, json } from "./_auth.js";

export async function onRequestGet({ request, env }) {
  return json({ authed: await isAuthed(request, env) });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  if (!checkPassword(body?.password, env)) {
    // 401 with no detail — family-only, but still no need to help probing.
    return json({ error: "invalid_password" }, { status: 401 });
  }

  const cookie = await issueCookie(env, request.url);
  return json({ authed: true }, { headers: { "Set-Cookie": cookie } });
}

export async function onRequestDelete({ request }) {
  return json({ authed: false }, {
    headers: { "Set-Cookie": clearCookieHeader(request.url) },
  });
}
