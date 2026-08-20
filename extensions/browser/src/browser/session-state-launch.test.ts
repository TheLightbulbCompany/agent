// Verifies the periodic session-state snapshot timer (fires while a managed
// browser runs, silent when idle) and the graceful-shutdown snapshot hook.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

import { getRuntimeConfig } from "../config/config.js";
import type { CdpSendFn } from "./cdp.helpers.js";
import type { RunningChrome } from "./chrome.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";
import type { BrowserServerState } from "./server-context.types.js";
import {
  snapshotSessionStateViaSend,
  startBrowserSessionStateSnapshotTimer,
} from "./session-state-launch.js";

const enabledConfig = () => ({ enabled: true, intervalMs: 60_000, path: "/unused" });

function stateWithRunningManagedProfile(): BrowserServerState {
  const state = makeBrowserServerState();
  state.profiles.set("openclaw", {
    profile: makeBrowserProfile(),
    running: { pid: 1 } as RunningChrome,
  });
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("startBrowserSessionStateSnapshotTimer", () => {
  it("snapshots on the interval while a managed browser is running", async () => {
    vi.useFakeTimers();
    const snapshotProfile = vi.fn(async () => {});
    const stop = startBrowserSessionStateSnapshotTimer({
      state: stateWithRunningManagedProfile(),
      snapshotProfile,
      resolveConfig: enabledConfig,
    });

    expect(snapshotProfile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshotProfile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshotProfile).toHaveBeenCalledTimes(2);

    await stop();
  });

  it("does not snapshot when no browser is running (no wake-spam)", async () => {
    vi.useFakeTimers();
    const snapshotProfile = vi.fn(async () => {});
    const stop = startBrowserSessionStateSnapshotTimer({
      state: makeBrowserServerState(), // empty profiles map
      snapshotProfile,
      resolveConfig: enabledConfig,
    });

    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(snapshotProfile).not.toHaveBeenCalled();

    await stop();
  });

  it("does not snapshot while disabled", async () => {
    vi.useFakeTimers();
    const snapshotProfile = vi.fn(async () => {});
    const stop = startBrowserSessionStateSnapshotTimer({
      state: stateWithRunningManagedProfile(),
      snapshotProfile,
      resolveConfig: () => ({ enabled: false, intervalMs: 60_000, path: "/unused" }),
    });

    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(snapshotProfile).not.toHaveBeenCalled();

    await stop();
  });
});

describe("snapshotSessionStateViaSend", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-state-shutdown-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("snapshots via the given send when enabled", async () => {
    const outPath = path.join(tmpDir, "state.json");
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: { sessionState: { enabled: true, path: outPath } },
    } as unknown as ReturnType<typeof getRuntimeConfig>);

    const cookies = [{ name: "sid", value: "v", domain: "e.com", path: "/" }];
    const send: CdpSendFn = async (method) => {
      if (method === "Storage.getCookies") {
        return { cookies };
      }
      if (method === "Target.getTargets") {
        return { targetInfos: [] };
      }
      throw new Error(`unexpected ${method}`);
    };

    await snapshotSessionStateViaSend(send);

    const written = JSON.parse(await fs.readFile(outPath, "utf8"));
    expect(written.cookies).toEqual(cookies);
  });

  it("is a no-op (no CDP calls, no file) when disabled", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: {},
    } as unknown as ReturnType<typeof getRuntimeConfig>);

    const send = vi.fn(async () => ({}));
    await snapshotSessionStateViaSend(send as unknown as CdpSendFn);

    expect(send).not.toHaveBeenCalled();
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });
});
