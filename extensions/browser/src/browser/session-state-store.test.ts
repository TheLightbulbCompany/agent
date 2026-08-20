import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CdpSendFn } from "./cdp.helpers.js";
import { SESSION_STATE_VERSION, snapshotSessionState } from "./session-state-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-state-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

type Handler = (params?: Record<string, unknown>, sessionId?: string) => unknown;

/** Build a CdpSendFn from a per-method handler map; unknown methods throw. */
function mockSend(handlers: Record<string, Handler>): CdpSendFn {
  return async (method, params, sessionId) => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`unexpected CDP method: ${method}`);
    }
    return handler(params, sessionId);
  };
}

describe("snapshotSessionState", () => {
  it("writes a v1 JSON with cookies and per-origin localStorage", async () => {
    const cookies = [{ name: "sid", value: "abc", domain: "example.com", path: "/" }];
    const send = mockSend({
      "Storage.getCookies": () => ({ cookies }),
      "Target.getTargets": () => ({
        targetInfos: [
          { type: "page", targetId: "t1", url: "https://example.com/dash" },
          // same origin as t1 → must be deduped (one origin entry, one attach)
          { type: "page", targetId: "t2", url: "https://example.com/other" },
          // non-http origins are skipped
          { type: "page", targetId: "t3", url: "chrome://newtab/" },
          { type: "page", targetId: "t4", url: "about:blank" },
          // non-page targets are skipped
          { type: "service_worker", targetId: "t5", url: "https://sw.example.com/" },
        ],
      }),
      "Target.attachToTarget": (params) => ({ sessionId: `sess-${params?.targetId}` }),
      "Runtime.evaluate": () => ({ result: { value: { token: "xyz", n: 5 } } }),
      "Target.detachFromTarget": () => ({}),
    });

    const outPath = path.join(tmpDir, "browser-state", "state.json");
    const result = await snapshotSessionState(send, outPath);

    expect(result).toEqual({ cookies: 1, origins: 1 });

    const written = JSON.parse(await fs.readFile(outPath, "utf8"));
    expect(written.version).toBe(SESSION_STATE_VERSION);
    expect(typeof written.savedAt).toBe("string");
    expect(written.cookies).toEqual(cookies);
    // non-string localStorage values (n:5) are dropped
    expect(written.origins).toEqual([
      { origin: "https://example.com", localStorage: { token: "xyz" } },
    ]);
  });

  it("leaves no partial file or temp file when the write cannot be committed", async () => {
    const send = mockSend({
      "Storage.getCookies": () => ({ cookies: [] }),
      "Target.getTargets": () => ({ targetInfos: [] }),
    });

    // A directory at the target path makes the tmp→target rename fail.
    const dirTarget = path.join(tmpDir, "state-as-dir");
    await fs.mkdir(dirTarget);

    await expect(snapshotSessionState(send, dirTarget)).rejects.toBeDefined();

    const leftovers = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect((await fs.stat(dirTarget)).isDirectory()).toBe(true);
  });
});
