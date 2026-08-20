import { getRuntimeConfig } from "../config/config.js";
/**
 * Wires the pure snapshot/restore in session-state-store.ts to a running
 * managed browser: resolves a browser-level CDP socket from a profile's cdpUrl,
 * gates on browser.sessionState config, and swallows every failure so session
 * persistence never blocks a browser launch, snapshot tick, or shutdown.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveCdpReachabilityPolicy } from "./cdp-reachability-policy.js";
import type { CdpSendFn } from "./cdp.helpers.js";
import { withCdpSocket } from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { BrowserServerState } from "./server-context.types.js";
import {
  type ResolvedSessionStateConfig,
  resolveSessionStateConfig,
  restoreSessionState,
  snapshotSessionState,
} from "./session-state-store.js";

const log = createSubsystemLogger("browser").child("session-state");

const SESSION_STATE_CDP_TIMEOUT_MS = 15_000;

export type ManagedSessionStateParams = {
  profile: ResolvedBrowserProfile;
  resolved: ResolvedBrowserConfig;
};

/** Read + resolve browser.sessionState from runtime config (disabled on error). */
function readSessionStateConfig() {
  try {
    return resolveSessionStateConfig(getRuntimeConfig().browser?.sessionState);
  } catch {
    return resolveSessionStateConfig(undefined);
  }
}

/** Open a browser-level CDP socket for a managed profile and run `fn`. */
async function withBrowserCdpSend<T>(
  profile: ResolvedBrowserProfile,
  resolved: ResolvedBrowserConfig,
  fn: (send: CdpSendFn) => Promise<T>,
): Promise<T | undefined> {
  const ssrfPolicy = resolveCdpReachabilityPolicy(profile, resolved.ssrfPolicy);
  const wsUrl = await getChromeWebSocketUrl(
    profile.cdpUrl,
    SESSION_STATE_CDP_TIMEOUT_MS,
    ssrfPolicy,
  );
  if (!wsUrl) {
    return undefined;
  }
  return await withCdpSocket(wsUrl, fn, { commandTimeoutMs: SESSION_STATE_CDP_TIMEOUT_MS });
}

/**
 * Restore a persisted session snapshot into a freshly launched managed browser.
 * Never throws — a bad/absent snapshot must not block the launch.
 */
export async function restoreManagedBrowserSessionState(
  params: ManagedSessionStateParams,
): Promise<void> {
  const config = readSessionStateConfig();
  if (!config.enabled) {
    return;
  }
  try {
    const result = await withBrowserCdpSend(params.profile, params.resolved, (send) =>
      restoreSessionState(send, config.path),
    );
    if (result) {
      log.debug(
        `restored session state: ${result.cookies} cookies, ${result.origins} origins from ${config.path}`,
      );
    }
  } catch (err) {
    log.warn(`session-state restore failed (continuing): ${String(err)}`);
  }
}

/**
 * Snapshot a running managed browser's session state. Never throws — a failed
 * snapshot must not disrupt the timer tick or the shutdown path.
 */
export async function snapshotManagedBrowserSessionState(
  params: ManagedSessionStateParams,
): Promise<void> {
  const config = readSessionStateConfig();
  if (!config.enabled) {
    return;
  }
  try {
    const result = await withBrowserCdpSend(params.profile, params.resolved, (send) =>
      snapshotSessionState(send, config.path),
    );
    if (result) {
      log.debug(
        `snapshotted session state: ${result.cookies} cookies, ${result.origins} origins to ${config.path}`,
      );
    }
  } catch (err) {
    log.warn(`session-state snapshot failed (continuing): ${String(err)}`);
  }
}

/**
 * Best-effort snapshot using an already-open browser-level CDP send. Used on the
 * graceful-shutdown path where the close handler already holds the socket, so
 * there is no need to re-resolve one. Never throws.
 */
export async function snapshotSessionStateViaSend(send: CdpSendFn): Promise<void> {
  const config = readSessionStateConfig();
  if (!config.enabled) {
    return;
  }
  try {
    await snapshotSessionState(send, config.path);
  } catch (err) {
    log.warn(`session-state shutdown snapshot failed (continuing): ${String(err)}`);
  }
}

/** Snapshot every running local-managed browser once (skips idle/remote/extension). */
async function snapshotRunningManagedBrowsers(
  state: BrowserServerState,
  snapshotProfile: (params: ManagedSessionStateParams) => Promise<void>,
): Promise<void> {
  for (const runtime of state.profiles.values()) {
    if (!runtime.running) {
      continue;
    }
    // Only OpenClaw's own managed Chrome persists via this JSON. Never touch the
    // user's real browser (extension), a remote CDP, or an existing-session box.
    if (getBrowserProfileCapabilities(runtime.profile).mode !== "local-managed") {
      continue;
    }
    await snapshotProfile({ profile: runtime.profile, resolved: state.resolved });
  }
}

/**
 * Start the periodic session-state snapshot timer. Fires only while a managed
 * browser is running (no wake-spam when idle) and reschedules from config each
 * tick so a hot-reloaded interval/enable takes effect. Fargate task kills are
 * not graceful, so this timer — not the shutdown hook — is the primary
 * durability mechanism. Returns a disposer.
 *
 * `snapshotProfile` and `resolveConfig` are injectable for tests.
 */
export function startBrowserSessionStateSnapshotTimer(params: {
  state: BrowserServerState;
  snapshotProfile?: (p: ManagedSessionStateParams) => Promise<void>;
  resolveConfig?: () => ResolvedSessionStateConfig;
}): () => Promise<void> {
  const snapshotProfile = params.snapshotProfile ?? snapshotManagedBrowserSessionState;
  const resolveConfig = params.resolveConfig ?? readSessionStateConfig;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  const schedule = () => {
    if (stopped) {
      return;
    }
    let intervalMs = 60_000;
    try {
      intervalMs = resolveConfig().intervalMs;
    } catch (err) {
      log.warn(`failed to resolve session-state interval: ${String(err)}`);
    }
    timer = setTimeout(run, intervalMs);
    timer.unref?.();
  };

  const run = () => {
    if (stopped) {
      return;
    }
    if (running) {
      schedule();
      return;
    }
    let enabled = false;
    try {
      enabled = resolveConfig().enabled;
    } catch {
      // resolve failure ⇒ treat as disabled this tick
    }
    if (!enabled) {
      schedule();
      return;
    }
    running = snapshotRunningManagedBrowsers(params.state, snapshotProfile)
      .catch((err: unknown) => {
        log.warn(`session-state snapshot sweep failed: ${String(err)}`);
      })
      .finally(() => {
        running = null;
        schedule();
      });
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await running?.catch(() => {});
  };
}
