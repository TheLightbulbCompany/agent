// State database path helpers resolve shared OpenClaw state DB paths.
import os from "node:os";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
import { resolveStateDir } from "../config/paths.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";

/**
 * Path helpers for the shared OpenClaw SQLite state database.
 *
 * Tests get worker-scoped temp state roots unless they explicitly provide
 * `OPENCLAW_STATE_DIR`, which prevents parallel Vitest workers from sharing WAL files.
 */
function resolveOpenClawStateRootDir(env: NodeJS.ProcessEnv): string {
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    const workerId = parseStrictNonNegativeInteger(
      env.VITEST_WORKER_ID ?? env.VITEST_POOL_ID ?? "",
    );
    const shardSuffix =
      workerId !== undefined
        ? `${process.pid}-${workerId}`
        : isMainThread
          ? String(process.pid)
          : `${process.pid}-${threadId}`;
    return path.join(os.tmpdir(), "openclaw-test-state", shardSuffix);
  }
  return resolveStateDir(env);
}

/**
 * Resolve the directory that contains the shared state SQLite file.
 *
 * `OPENCLAW_SQLITE_DIR` relocates ONLY the SQLite databases, leaving the rest
 * of the state dir where it is. This exists because `OPENCLAW_STATE_DIR` is
 * all-or-nothing: it takes openclaw.json, credentials/, identity/ and every
 * other durable subtree with it. A deployment that puts hot SQLite on fast
 * ephemeral disk while keeping durable state on a network filesystem needs to
 * move the databases alone.
 *
 * Note this knob also relocates the PER-AGENT databases, because
 * `resolveOpenClawAgentDbPath` derives them from `path.dirname()` of this
 * directory rather than from the state root.
 */
export function resolveOpenClawStateSqliteDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_SQLITE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveOpenClawStateRootDir(env), "state");
}

/** Resolve the shared state SQLite file path. */
export function resolveOpenClawStateSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenClawStateSqliteDir(env), "openclaw.sqlite");
}
