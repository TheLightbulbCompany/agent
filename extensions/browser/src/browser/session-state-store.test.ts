import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CdpSendFn } from "./cdp.helpers.js";
import {
  resolveSessionStateConfig,
  restoreSessionState,
  SESSION_STATE_VERSION,
  snapshotSessionState,
} from "./session-state-store.js";

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

describe("restoreSessionState", () => {
  it("returns null when the snapshot file is absent (no CDP calls)", async () => {
    const calls: string[] = [];
    const send: CdpSendFn = async (method) => {
      calls.push(method);
      return {};
    };
    const result = await restoreSessionState(send, path.join(tmpDir, "missing.json"));
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null on a version mismatch (no CDP calls)", async () => {
    const calls: string[] = [];
    const send: CdpSendFn = async (method) => {
      calls.push(method);
      return {};
    };
    const filePath = path.join(tmpDir, "state.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 999, cookies: [], origins: [] }));
    const result = await restoreSessionState(send, filePath);
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  it("restores cookies and per-origin localStorage from a v1 file", async () => {
    const cookies = [{ name: "sid", value: "abc", domain: "example.com", path: "/" }];
    const filePath = path.join(tmpDir, "state.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: SESSION_STATE_VERSION,
        savedAt: new Date().toISOString(),
        cookies,
        origins: [{ origin: "https://example.com", localStorage: { token: "xyz" } }],
      }),
    );

    let setCookiesArg: unknown;
    let setItemsExpr: string | undefined;
    const send = mockSend({
      "Storage.setCookies": (params) => {
        setCookiesArg = params?.cookies;
        return {};
      },
      "Target.createTarget": () => ({ targetId: "t1" }),
      "Target.attachToTarget": () => ({ sessionId: "s1" }),
      "Runtime.evaluate": (params) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("location.origin")) {
          return { result: { value: "https://example.com" } };
        }
        setItemsExpr = expr;
        return { result: { value: 1 } };
      },
      "Target.closeTarget": () => ({}),
    });

    const result = await restoreSessionState(send, filePath);
    expect(result).toEqual({ cookies: 1, origins: 1 });
    expect(setCookiesArg).toEqual(cookies);
    expect(setItemsExpr).toContain("token");
    expect(setItemsExpr).toContain("localStorage.setItem");
  });

  it("continues past a rejected cookie (per-item tolerance)", async () => {
    const cookies = [
      { name: "good", value: "1", domain: "e.com", path: "/" },
      { name: "bad", value: "2", domain: "e.com", path: "/" },
    ];
    const filePath = path.join(tmpDir, "state.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: SESSION_STATE_VERSION, savedAt: "x", cookies, origins: [] }),
    );

    let bulkTried = false;
    const send: CdpSendFn = async (method, params) => {
      if (method !== "Storage.setCookies") {
        throw new Error(`unexpected CDP method: ${method}`);
      }
      const arr = (params as { cookies?: Array<{ name?: string }> })?.cookies ?? [];
      if (arr.length > 1) {
        bulkTried = true;
        throw new Error("bulk rejected");
      }
      if (arr[0]?.name === "bad") {
        throw new Error("bad cookie");
      }
      return {};
    };

    const result = await restoreSessionState(send, filePath);
    expect(bulkTried).toBe(true);
    expect(result).toEqual({ cookies: 1, origins: 0 });
  });
});

describe("resolveSessionStateConfig", () => {
  it("defaults to disabled with a home-expanded path when no config is set", () => {
    const resolved = resolveSessionStateConfig(undefined);
    expect(resolved.enabled).toBe(false);
    expect(resolved.intervalMs).toBe(60_000);
    expect(resolved.path.endsWith("/.openclaw/browser-state/state.json")).toBe(true);
    expect(resolved.path.startsWith("~")).toBe(false);
  });

  it("enables on presence and honors interval + custom path", () => {
    const resolved = resolveSessionStateConfig({ intervalSeconds: 30, path: "/data/state.json" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.intervalMs).toBe(30_000);
    expect(resolved.path).toBe("/data/state.json");
  });

  it("floors the interval to avoid wake-spam and honors enabled:false", () => {
    expect(resolveSessionStateConfig({ intervalSeconds: 1 }).intervalMs).toBe(15_000);
    expect(resolveSessionStateConfig({ enabled: false }).enabled).toBe(false);
  });
});
