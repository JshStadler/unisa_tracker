import { isAuthed, json } from "./_auth.js";

const KV_KEY = "state";
const EMPTY_STATE = { completion: {}, dates: {} };

async function readState(env) {
  const raw = await env.TRACKER.get(KV_KEY);
  if (!raw) return { version: 0, data: EMPTY_STATE };
  try {
    const parsed = JSON.parse(raw);
    // Normalise shape — be lenient for any hand-edits.
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

export async function onRequestGet({ env }) {
  const stored = await readState(env);
  return json(stored, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function onRequestPut({ request, env }) {
  if (!(await isAuthed(request, env))) {
    return json({ error: "unauthorised" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

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
    // Client is stale — return the current server state so UI can reconcile.
    return json(
      { error: "version_conflict", current },
      { status: 409 }
    );
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
