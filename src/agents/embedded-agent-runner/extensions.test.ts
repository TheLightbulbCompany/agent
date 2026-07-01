// Coverage for embedded extension factory selection and runtime wiring.
import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import contextPruningExtension from "../agent-hooks/context-pruning.js";
import { getContextPruningRuntime } from "../agent-hooks/context-pruning/runtime.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  // Plugin-owned cache-TTL decisions are mocked out here; extension selection
  // tests assert the core default wiring only.
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

function buildSafeguardFactories(cfg: OpenClawConfig, workspaceDir?: string) {
  // The safeguard runtime attaches to the session manager, so tests keep the
  // same manager instance around for both factory construction and inspection.
  const sessionManager = {} as SessionManager;
  const model = {
    id: "claude-sonnet-4-20250514",
    contextWindow: 200_000,
  } as Model;

  const factories = buildEmbeddedExtensionFactories({
    cfg,
    sessionManager,
    workspaceDir,
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    model,
  });

  return { factories, sessionManager };
}

function expectSafeguardRuntime(
  cfg: OpenClawConfig,
  expectedRuntime: { qualityGuardEnabled: boolean; qualityGuardMaxRetries?: number },
) {
  const { factories, sessionManager } = buildSafeguardFactories(cfg);

  expect(factories).toContain(compactionSafeguardExtension);
  const runtime = getCompactionSafeguardRuntime(sessionManager);
  expect(runtime?.contextWindowTokens).toBe(200_000);
  expect(runtime?.qualityGuardEnabled).toBe(expectedRuntime.qualityGuardEnabled);
  expect(runtime?.qualityGuardMaxRetries).toBe(expectedRuntime.qualityGuardMaxRetries);
}

describe("buildEmbeddedExtensionFactories", () => {
  it("enables quality-guard retries by default in safeguard mode", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
    });
  });

  it("honors explicit safeguard quality-guard disablement", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: false,
    });
  });

  it("wires explicit safeguard quality-guard runtime flags", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: true,
              maxRetries: 2,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
    });
  });

  it("wires the run workspace into safeguard runtime", () => {
    const { sessionManager } = buildSafeguardFactories(
      {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
            },
          },
        },
      } as OpenClawConfig,
      "/tmp/openclaw-workspace",
    );

    expect(getCompactionSafeguardRuntime(sessionManager)?.workspaceDir).toBe(
      "/tmp/openclaw-workspace",
    );
  });

  it("enables cache-ttl pruning for custom anthropic-messages providers", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      } as OpenClawConfig,
      sessionManager: {} as SessionManager,
      provider: "litellm",
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages", contextWindow: 200_000 } as Model,
    });

    expect(factories).toContain(contextPruningExtension);
  });
});

function buildPruningFactories(params: {
  mode: string;
  provider: string;
  modelId: string;
  api?: string;
}) {
  const sessionManager = {} as SessionManager;
  const factories = buildEmbeddedExtensionFactories({
    cfg: {
      agents: { defaults: { contextPruning: { mode: params.mode } } },
    } as OpenClawConfig,
    sessionManager,
    provider: params.provider,
    modelId: params.modelId,
    model: {
      api: params.api,
      contextWindow: 272_000,
      contextTokens: 272_000,
    } as Model,
  });
  return { factories, sessionManager };
}

describe("contextPruning provider gating", () => {
  it("degrades cache-ttl to size pruning on providers without a prompt cache (openai/chatgpt-responses)", () => {
    // Before the fix this returned no factory: cache-ttl was hard-gated to
    // cache-eligible providers, so gpt-5.5 tool results accumulated to overflow.
    const { factories, sessionManager } = buildPruningFactories({
      mode: "cache-ttl",
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-chatgpt-responses",
    });

    expect(factories).toContain(contextPruningExtension);
    expect(getContextPruningRuntime(sessionManager)?.settings.mode).toBe("size");
  });

  it("keeps cache-ttl semantics on cache-eligible providers (anthropic)", () => {
    const { factories, sessionManager } = buildPruningFactories({
      mode: "cache-ttl",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      api: "anthropic-messages",
    });

    expect(factories).toContain(contextPruningExtension);
    expect(getContextPruningRuntime(sessionManager)?.settings.mode).toBe("cache-ttl");
  });

  it("enables explicit size pruning on any provider", () => {
    const { factories, sessionManager } = buildPruningFactories({
      mode: "size",
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-chatgpt-responses",
    });

    expect(factories).toContain(contextPruningExtension);
    expect(getContextPruningRuntime(sessionManager)?.settings.mode).toBe("size");
  });

  it("does not register pruning when mode is off", () => {
    const { factories } = buildPruningFactories({
      mode: "off",
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-chatgpt-responses",
    });

    expect(factories).not.toContain(contextPruningExtension);
  });
});
