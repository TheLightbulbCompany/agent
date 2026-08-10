/**
 * A transient session-store read failure must surface as
 * SessionLookupUnavailableError instead of resolving to an empty store —
 * an empty store makes chat.history answer ok:true with zero messages,
 * indistinguishable from a brand-new session.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { isSessionLookupUnavailableError, loadSessionEntry } from "./session-utils.js";

const accessorMock = vi.hoisted(() => ({
  failListSessionEntries: false,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    listSessionEntries: (scope?: Parameters<typeof actual.listSessionEntries>[0]) => {
      if (accessorMock.failListSessionEntries) {
        const busy = new Error("database is locked");
        (busy as Error & { code?: string }).code = "SQLITE_BUSY";
        throw busy;
      }
      return actual.listSessionEntries(scope);
    },
  };
});

const MAIN_AGENT_ID = "main";

async function withRuntimeConfig(run: () => Promise<void> | void): Promise<void> {
  await withStateDirEnv("openclaw-lookup-unavailable-", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: MAIN_AGENT_ID, default: true, workspace: "/tmp/openclaw-lookup-unavailable" }],
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    await run();
  });
}

describe("session lookup store read failures", () => {
  afterEach(() => {
    accessorMock.failListSessionEntries = false;
    resetConfigRuntimeState();
    vi.clearAllMocks();
  });

  test("a throwing store read surfaces as SessionLookupUnavailableError, not an empty store", async () => {
    await withRuntimeConfig(() => {
      accessorMock.failListSessionEntries = true;
      let thrown: unknown;
      try {
        loadSessionEntry(`agent:${MAIN_AGENT_ID}:user_abc`);
      } catch (error) {
        thrown = error;
      }
      expect(isSessionLookupUnavailableError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain("database is locked");
    });
  });

  test("an empty store still resolves without throwing (never-ran agent)", async () => {
    await withRuntimeConfig(() => {
      const loaded = loadSessionEntry(`agent:${MAIN_AGENT_ID}:user_abc`);
      expect(loaded.entry).toBeUndefined();
      expect(loaded.canonicalKey).toBeTruthy();
    });
  });
});
