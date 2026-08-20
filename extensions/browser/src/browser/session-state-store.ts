/**
 * Browser session-state snapshot/restore.
 *
 * Persists a managed browser's *state* — cookies + per-origin localStorage —
 * to a single JSON so an owner's logged-in sessions survive a container/browser
 * restart. Deliberately NOT the Chrome user-data-dir (LevelDB/SQLite): that
 * class of state must never live on EFS/NFS (the O6 `database is locked`
 * hazard). Persist state, not the profile dir — mirrors Browserbase Contexts.
 *
 * The snapshot is driven entirely through a browser-level CDP send function
 * (the abstraction `withCdpSocket` hands callers), so it needs no Playwright
 * page handle and is trivially testable with a mock send.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CdpSendFn } from "./cdp.helpers.js";

export const SESSION_STATE_VERSION = 1;

/** How long to wait for a throwaway restore tab to commit on its origin. */
const ORIGIN_COMMIT_ATTEMPTS = 8;
const ORIGIN_COMMIT_POLL_MS = 250;

type SessionCookie = Record<string, unknown>;
type OriginState = { origin: string; localStorage: Record<string, string> };
type SessionStateFile = {
  version: number;
  savedAt: string;
  cookies: SessionCookie[];
  origins: OriginState[];
};

/** http/https origin usable for storage persistence, or null (chrome://, about:, …). */
function persistableOrigin(url: unknown): string | null {
  if (typeof url !== "string" || !url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Keep only string→string entries; CDP returnByValue can carry non-strings. */
function coerceStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
}

/** Write JSON via a sibling temp file + rename so a crash never leaves a partial. */
async function atomicWriteJson(outPath: string, payload: unknown): Promise<void> {
  const resolved = path.resolve(outPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fs.rename(tmp, resolved);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Read all cookies across browser contexts. */
async function readAllCookies(send: CdpSendFn): Promise<SessionCookie[]> {
  const res = (await send("Storage.getCookies")) as { cookies?: unknown } | null;
  const cookies = res?.cookies;
  return Array.isArray(cookies) ? (cookies as SessionCookie[]) : [];
}

/** Read one page target's localStorage as a string map (attach → evaluate → detach). */
async function readOriginLocalStorage(
  send: CdpSendFn,
  targetId: string,
): Promise<Record<string, string>> {
  const attached = (await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })) as { sessionId?: unknown } | null;
  const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined;
  if (!sessionId) {
    return {};
  }
  try {
    const res = (await send(
      "Runtime.evaluate",
      {
        expression: "Object.fromEntries(Object.entries(localStorage))",
        returnByValue: true,
      },
      sessionId,
    )) as { result?: { value?: unknown } } | null;
    return coerceStringMap(res?.result?.value);
  } finally {
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

/** Collect per-origin localStorage from all open http/https page targets (deduped by origin). */
async function readAllOrigins(send: CdpSendFn): Promise<OriginState[]> {
  const res = (await send("Target.getTargets")) as { targetInfos?: unknown } | null;
  const infos = Array.isArray(res?.targetInfos)
    ? (res.targetInfos as Array<Record<string, unknown>>)
    : [];
  const seen = new Set<string>();
  const out: OriginState[] = [];
  for (const info of infos) {
    if (info?.type !== "page") {
      continue;
    }
    const origin = persistableOrigin(info?.url);
    if (!origin || seen.has(origin)) {
      continue;
    }
    seen.add(origin);
    const targetId = typeof info?.targetId === "string" ? info.targetId : undefined;
    if (!targetId) {
      continue;
    }
    const localStorage = await readOriginLocalStorage(send, targetId).catch(() => ({}));
    out.push({ origin, localStorage });
  }
  return out;
}

/**
 * Snapshot the browser's cookies + per-origin localStorage to `outPath` as a
 * v1 JSON, written atomically. Returns the counts persisted.
 */
export async function snapshotSessionState(
  send: CdpSendFn,
  outPath: string,
): Promise<{ cookies: number; origins: number }> {
  const cookies = await readAllCookies(send);
  const origins = await readAllOrigins(send);
  const payload: SessionStateFile = {
    version: SESSION_STATE_VERSION,
    savedAt: new Date().toISOString(),
    cookies,
    origins,
  };
  await atomicWriteJson(outPath, payload);
  return { cookies: cookies.length, origins: origins.length };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Drop fields Network.CookieParam rejects; require name+value. */
function toCookieParam(cookie: unknown): SessionCookie | null {
  if (!cookie || typeof cookie !== "object") {
    return null;
  }
  const copy = { ...(cookie as Record<string, unknown>) };
  if (typeof copy.name !== "string" || typeof copy.value !== "string") {
    return null;
  }
  // `size` and `session` are read-only Cookie fields, not accepted as params.
  delete copy.size;
  delete copy.session;
  return copy;
}

/** Set cookies in one call; on failure retry per-cookie so one bad cookie doesn't abort. */
async function restoreCookies(send: CdpSendFn, cookies: unknown[]): Promise<number> {
  const params = cookies.map(toCookieParam).filter((c): c is SessionCookie => c != null);
  if (params.length === 0) {
    return 0;
  }
  try {
    await send("Storage.setCookies", { cookies: params });
    return params.length;
  } catch {
    let added = 0;
    for (const cookie of params) {
      try {
        await send("Storage.setCookies", { cookies: [cookie] });
        added += 1;
      } catch {
        // Individual cookie rejected by Chrome; counted as not restored.
      }
    }
    return added;
  }
}

/** Poll a throwaway tab until its committed document is on the target origin. */
async function waitForTargetOrigin(
  send: CdpSendFn,
  sessionId: string,
  origin: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < ORIGIN_COMMIT_ATTEMPTS; attempt += 1) {
    const res = (await send(
      "Runtime.evaluate",
      { expression: "location.origin", returnByValue: true },
      sessionId,
    ).catch(() => null)) as { result?: { value?: unknown } } | null;
    if (res?.result?.value === origin) {
      return true;
    }
    if (attempt < ORIGIN_COMMIT_ATTEMPTS - 1) {
      await delay(ORIGIN_COMMIT_POLL_MS);
    }
  }
  return false;
}

/**
 * Restore one origin's localStorage by navigating a throwaway tab to it and
 * replaying the items. Per-item failure is tolerated inside the page. Returns
 * true when the items were written.
 */
async function restoreOriginLocalStorage(send: CdpSendFn, entry: unknown): Promise<boolean> {
  const origin =
    entry && typeof entry === "object" && typeof (entry as OriginState).origin === "string"
      ? (entry as OriginState).origin
      : "";
  const items = coerceStringMap((entry as OriginState | undefined)?.localStorage);
  const pairs = Object.entries(items);
  if (!origin || pairs.length === 0) {
    return false;
  }

  const created = (await send("Target.createTarget", { url: origin }).catch(() => null)) as {
    targetId?: unknown;
  } | null;
  const targetId = typeof created?.targetId === "string" ? created.targetId : undefined;
  if (!targetId) {
    return false;
  }
  try {
    const attached = (await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    }).catch(() => null)) as { sessionId?: unknown } | null;
    const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined;
    if (!sessionId) {
      return false;
    }
    if (!(await waitForTargetOrigin(send, sessionId, origin))) {
      return false;
    }
    // Replay every item in the page with a per-item try/catch so a single
    // rejected key (e.g. a quota error) never aborts the rest.
    const expr =
      `(function(items){var n=0;for(var i=0;i<items.length;i++){` +
      `try{localStorage.setItem(items[i][0],items[i][1]);n++;}catch(e){}}return n;})` +
      `(${JSON.stringify(pairs)})`;
    const res = (await send(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true },
      sessionId,
    ).catch(() => null)) as { result?: { value?: unknown } } | null;
    return typeof res?.result?.value === "number";
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

/**
 * Restore a v1 snapshot from `inPath` into the running browser. Returns null if
 * the file is absent, unreadable, or a version mismatch (no CDP calls made in
 * those cases). Idempotent and best-effort: individual cookie/origin failures
 * are swallowed so a partial snapshot still restores what it can.
 */
export async function restoreSessionState(
  send: CdpSendFn,
  inPath: string,
): Promise<{ cookies: number; origins: number } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(inPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const file = parsed as Partial<SessionStateFile>;
  if (file.version !== SESSION_STATE_VERSION) {
    return null;
  }

  const cookies = Array.isArray(file.cookies) ? file.cookies : [];
  const origins = Array.isArray(file.origins) ? file.origins : [];

  const cookieCount = await restoreCookies(send, cookies);
  let originCount = 0;
  for (const entry of origins) {
    try {
      if (await restoreOriginLocalStorage(send, entry)) {
        originCount += 1;
      }
    } catch {
      // Best-effort: skip an origin that fails unexpectedly.
    }
  }
  return { cookies: cookieCount, origins: originCount };
}
