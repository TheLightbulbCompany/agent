// Verifies a fresh managed-Chrome launch restores persisted session state
// exactly once, after adoption and before reporting available, and never lets a
// restore failure block the launch.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import * as chromeModule from "./chrome.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserServerState } from "./server-context.test-harness.js";
import * as sessionStateLaunch from "./session-state-launch.js";

vi.mock("./session-state-launch.js", () => ({
  restoreManagedBrowserSessionState: vi.fn(async () => {}),
  snapshotManagedBrowserSessionState: vi.fn(async () => {}),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function setupFreshLaunch(pid: number) {
  vi.useFakeTimers();
  vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(false);
  vi.mocked(chromeModule.isChromeCdpReady).mockResolvedValue(true);
  vi.mocked(chromeModule.isChromeCdpOwnedByPid).mockResolvedValue(true);
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  vi.mocked(chromeModule.launchOpenClawChrome).mockResolvedValue({
    pid,
    exe: { kind: "chromium", path: "/usr/bin/chromium" },
    userDataDir: "/tmp/openclaw-test",
    cdpPort: 18800,
    startedAt: Date.now(),
    proc,
  });
  const state = makeBrowserServerState();
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { profile: ctx.forProfile("openclaw"), state };
}

describe("browser launch restores session state", () => {
  it("restores exactly once after adoption, before reporting available", async () => {
    const { profile, state } = setupFreshLaunch(4242);
    const restore = vi.mocked(sessionStateLaunch.restoreManagedBrowserSessionState);
    let runningPidAtRestore: number | null | undefined = undefined;
    restore.mockImplementation(async () => {
      // Running is set by adoptRunning; observing it proves CDP was up and the
      // process adopted before restore ran, and before ensure() returned.
      runningPidAtRestore = state.profiles.get("openclaw")?.running?.pid ?? null;
    });

    await profile.ensureBrowserAvailable();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(runningPidAtRestore).toBe(4242);
    expect(state.profiles.get("openclaw")?.running?.pid).toBe(4242);
  });

  it("does not block launch when restore fails", async () => {
    const { profile, state } = setupFreshLaunch(4343);
    const restore = vi.mocked(sessionStateLaunch.restoreManagedBrowserSessionState);
    restore.mockRejectedValue(new Error("bad snapshot"));

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(state.profiles.get("openclaw")?.running?.pid).toBe(4343);
  });
});
