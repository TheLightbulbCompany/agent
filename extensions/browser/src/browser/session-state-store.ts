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
