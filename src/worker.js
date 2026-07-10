// Cloudflare Worker entry point.
// - /api/auth      GET/POST/DELETE authentication
// - /api/state     GET/PUT tracker state
// - everything else is served from the static Assets binding

const COOKIE_NAME = "tracker_auth";
const SESSION_DAYS = 30;
const KV_KEY = "state";
const BACKUP_KV_KEY = "state:backup";
const EMPTY_STATE = Object.freeze({ completion: {}, dates: {} });

const MAX_STATE_BYTES = 64 * 1024