import type { SessionToolOverrides } from "../config/sessions/types.js";
/** Shared session MCP runtime constants and create-runtime factory type. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type {
  RequesterMcpConnect,
  SessionMcpRequesterScope,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import type { McpServerConnectionResolved } from "./mcp-connection-resolver.js";

export const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
export const DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS = 10 * 60 * 1000;
export const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
// Bounds live per-sender MCP transports in one session between idle sweeps;
// far above concurrent-run parallelism, so active requesters never evict.
export const SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES = 64;

/** Checks whether harness-scoped MCP can affect a turn without loading its runtime graph. */
export function shouldLoadRequesterScopedMcpHarnessRuntime(params: {
  sessionId: string;
  requesterSenderId?: string | null;
}): boolean {
  if (params.requesterSenderId?.trim()) {
    return true;
  }
  const manager = (globalThis as Record<PropertyKey, unknown>)[SESSION_MCP_RUNTIME_MANAGER_KEY] as
    | SessionMcpRuntimeManager
    | undefined;
  return (manager?.getAdvertisedScopedCatalog(params.sessionId)?.tools.length ?? 0) > 0;
}

export type CreateSessionMcpRuntime = (params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
  redactConnectionServerNames?: ReadonlySet<string>;
  requesterScope?: SessionMcpRequesterScope;
  requesterConnect?: RequesterMcpConnect;
  configFingerprint?: string;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}) => SessionMcpRuntime;

export function resolveSessionMcpRuntimeIdleTtlMs(): number {
  return DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
}

// ISOL8 FORK PATCH (shared-runtime-scope) --------------------------------------
// Bundled-MCP runtime cache scope. Fork-only key `mcp.runtimeScope`.
export type SessionMcpRuntimeScope = "session" | "shared";

/**
 * - `"session"` (default, upstream behavior): the static runtime is keyed by the
 *   gateway sessionId, so every session gets its own runtime and per-session
 *   disposal tears it down.
 * - `"shared"`: the static runtime is keyed by (workspaceDir, agentDir,
 *   configFingerprint) instead, so sessions that share a workspace + agent + MCP
 *   server config reuse one already-connected runtime. Reaped by the idle sweep
 *   (a fixed DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS at this base -- upstream
 *   retired the `mcp.sessionIdleTtlMs` knob), never by per-session disposal.
 *   Intended for single-tenant per-owner containers, where every session is the
 *   same owner and sharing collapses an otherwise per-session MCP connect storm.
 */
export function resolveSessionMcpRuntimeScope(cfg?: OpenClawConfig): SessionMcpRuntimeScope {
  return cfg?.mcp?.runtimeScope === "shared" ? "shared" : "session";
}

const SHARED_RUNTIME_KEY_PREFIX = "__mcp-shared__";

/**
 * Cache key for a shared static MCP runtime. The prefix guarantees it never
 * collides with a caller-supplied sessionId (those look like `agent:<id>:...`) or
 * a requester-scoped composite key (JSON, starts with `{`). `agentDir` is part of
 * the key because the manager's static-reuse check is agentDir-sensitive -- two
 * agents sharing one workspace would otherwise thrash a single runtime between
 * them on every alternation.
 */
export function buildSharedRuntimeKey(
  workspaceDir: string,
  agentDir: string | undefined,
  configFingerprint: string,
): string {
  return `${SHARED_RUNTIME_KEY_PREFIX}::${workspaceDir}::${agentDir ?? ""}::${configFingerprint}`;
}
