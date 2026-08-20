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
import {
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
