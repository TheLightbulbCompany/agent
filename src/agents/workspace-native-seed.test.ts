// Isol8 fork patch: boot-time conversion of a NON-legacy setup-seed sentinel
// (`.openclaw/isol8-setup-seed.json`) into the native SQLite workspace setup
// state via the runtime's own writer, so Isol8 can mark setup complete without
// ever writing the legacy `workspace-state.json` (whose migration bricks the
// presence gate on reprovision). These tests pin the converter's contract:
// convert + delete the sentinel, stay non-throwing on malformed input, honor
// the kill-switch env, and keep the migration gate green.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  assertNoUnmigratedWorkspaceState,
  LEGACY_WORKSPACE_STATE_CURRENT_FILENAME,
  LEGACY_WORKSPACE_STATE_DIRNAME,
  resolveLegacyWorkspaceSourcePaths,
} from "./workspace-legacy-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import { ensureAgentWorkspace } from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-native-seed-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

const ISOL8_SETUP_SEED_SEGMENTS = [".openclaw", "isol8-setup-seed.json"] as const;

async function writeIsol8SetupSeed(dir: string, contents: string): Promise<void> {
  await fs.mkdir(path.join(dir, ISOL8_SETUP_SEED_SEGMENTS[0]), { recursive: true });
  await fs.writeFile(path.join(dir, ...ISOL8_SETUP_SEED_SEGMENTS), contents);
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

async function expectNoLegacyWorkspaceStateWrites(dir: string): Promise<void> {
  await expectPathMissing(path.join(dir, LEGACY_WORKSPACE_STATE_CURRENT_FILENAME));
  await expectPathMissing(path.join(dir, LEGACY_WORKSPACE_STATE_DIRNAME, "workspace-state.json"));
}

describe("ensureAgentWorkspace isol8 native setup seed", () => {
  it("converts an isol8 setup-seed sentinel into native SQLite state and removes it", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    // A memory dir is user-content evidence, so a workspace seeded as
    // setup-complete is treated as surviving rather than vanished -- mirroring
    // the real seed flow where identity files accompany the sentinel.
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    const bootstrapSeededAt = "2026-07-25T01:00:00.000Z";
    const setupCompletedAt = "2026-07-25T02:00:00.000Z";
    await writeIsol8SetupSeed(tempDir, JSON.stringify({ bootstrapSeededAt, setupCompletedAt }));

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    const snapshot = readWorkspaceStateSnapshot(tempDir);
    expect(snapshot.setupExists).toBe(true);
    expect(snapshot.setup).toStrictEqual({
      version: 1,
      bootstrapSeededAt,
      setupCompletedAt,
    });
    // The sentinel is consumed, and no legacy JSON was written.
    await expectPathMissing(path.join(tempDir, ...ISOL8_SETUP_SEED_SEGMENTS));
    await expectNoLegacyWorkspaceStateWrites(tempDir);
    // Force a fresh presence check (bypassing the per-run cache) to prove the
    // migration gate stays green for a natively seeded workspace.
    resetLegacyWorkspaceStateCheckForTest();
    expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir: tempDir })).not.toThrow();
  });

  it("honors null sentinel fields without seeding stale markers", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    const setupCompletedAt = "2026-07-25T03:00:00.000Z";
    await writeIsol8SetupSeed(
      tempDir,
      JSON.stringify({ bootstrapSeededAt: null, setupCompletedAt }),
    );

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false });

    expect(readWorkspaceStateSnapshot(tempDir).setup).toStrictEqual({
      version: 1,
      setupCompletedAt,
    });
    await expectPathMissing(path.join(tempDir, ...ISOL8_SETUP_SEED_SEGMENTS));
  });

  it("does not brick boot when the sentinel is malformed and leaves it in place", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await writeIsol8SetupSeed(tempDir, "{ this is not valid json");

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).resolves.toBeDefined();

    // The converter did not seed native state from the malformed sentinel and
    // left it untouched (not deleted) so it can be inspected/re-tried.
    await expect(
      fs.access(path.join(tempDir, ...ISOL8_SETUP_SEED_SEGMENTS)),
    ).resolves.toBeUndefined();
  });

  it("is inert when the kill-switch env is set to 0", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await writeIsol8SetupSeed(
      tempDir,
      JSON.stringify({ setupCompletedAt: "2026-07-25T04:00:00.000Z" }),
    );
    vi.stubEnv("ISOL8_NATIVE_SETUP_SEED", "0");

    try {
      await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false });
    } finally {
      vi.unstubAllEnvs();
    }

    // Kill-switch => converter never ran; sentinel remains and its timestamp
    // was not written to native setup state by the converter.
    await expect(
      fs.access(path.join(tempDir, ...ISOL8_SETUP_SEED_SEGMENTS)),
    ).resolves.toBeUndefined();
    expect(readWorkspaceStateSnapshot(tempDir).setup.setupCompletedAt).toBeUndefined();
  });

  it("uses a sentinel path that is never a legacy workspace-state source path", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    const sentinelPath = path.resolve(path.join(tempDir, ...ISOL8_SETUP_SEED_SEGMENTS));
    const legacy = resolveLegacyWorkspaceSourcePaths(tempDir);
    const allLegacyPaths = [
      ...legacy.setupStatePaths,
      ...legacy.stateDirAttestationPaths,
      ...legacy.siblingAttestationPaths,
    ].map((legacyPath) => path.resolve(legacyPath));

    expect(allLegacyPaths).not.toContain(sentinelPath);
  });
});
