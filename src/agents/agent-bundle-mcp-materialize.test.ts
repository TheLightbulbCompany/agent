import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { materializeBundleMcpToolsForRunNonBlocking } from "./agent-bundle-mcp-materialize.js";
import type {
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

const DEFAULT_TOOLS: McpCatalogTool[] = [
  {
    serverName: "bundleProbe",
    safeServerName: "bundleProbe",
    toolName: "bundle_probe",
    description: "Bundle probe",
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: "Bundle probe",
  },
];

function makeCatalog(tools: McpCatalogTool[]): McpToolCatalog {
  const servers: McpToolCatalog["servers"] = {};
  for (const tool of tools) {
    servers[tool.serverName] = {
      serverName: tool.serverName,
      launchSummary: tool.serverName,
      toolCount: tools.filter((candidate) => candidate.serverName === tool.serverName).length,
      supportsParallelToolCalls: false,
    };
  }
  return { version: 1, generatedAt: 1, servers, tools };
}

/**
 * Fake runtime whose catalog starts cold (peekCatalog === null). getCatalog
 * blocks on `warmGate` until `settleWarm()` is called, then caches — mirroring
 * the real runtime, whose getCatalog returns the cache without reconnecting once
 * warm. This lets the tests prove that materialization does NOT block on the
 * cold connect, and that the warm path reuses the cache.
 */
function makeColdRuntime(params: { tools?: McpCatalogTool[]; result?: CallToolResult } = {}): {
  runtime: SessionMcpRuntime;
  settleWarm: () => void;
  getCatalogCalls: () => number;
  leaseBalance: () => number;
} {
  const tools = params.tools ?? DEFAULT_TOOLS;
  const warmCatalog = makeCatalog(tools);
  let cached: McpToolCatalog | null = null;
  let getCatalogCalls = 0;
  let activeLeases = 0;
  let resolveWarm: (() => void) | undefined;
  const warmGate = new Promise<void>((resolve) => {
    resolveWarm = resolve;
  });

  const runtime: SessionMcpRuntime = {
    sessionId: "session-cold",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    acquireLease: () => {
      activeLeases += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases = Math.max(0, activeLeases - 1);
      };
    },
    markUsed: () => {},
    getCatalog: async () => {
      // Real getCatalog returns the cache without reconnecting once warm.
      if (cached) {
        return cached;
      }
      getCatalogCalls += 1;
      await warmGate;
      cached = warmCatalog;
      return warmCatalog;
    },
    peekCatalog: () => cached,
    callTool: async () =>
      params.result ?? {
        content: [{ type: "text", text: "FROM-BUNDLE" }],
        isError: false,
      },
    dispose: async () => {},
  };

  return {
    runtime,
    settleWarm: () => resolveWarm?.(),
    getCatalogCalls: () => getCatalogCalls,
    leaseBalance: () => activeLeases,
  };
}

describe("materializeBundleMcpToolsForRunNonBlocking", () => {
  it("returns immediately with zero tools when the catalog is cold (does not block on getCatalog)", async () => {
    const { runtime, getCatalogCalls } = makeColdRuntime();

    const started = Date.now();
    const materialized = await materializeBundleMcpToolsForRunNonBlocking({ runtime });
    const elapsed = Date.now() - started;

    // Cold path advertises ZERO MCP tools — never a ghost/half-attached tool.
    expect(materialized.tools).toEqual([]);
    // It must not have awaited the (still-pending) getCatalog.
    expect(elapsed).toBeLessThan(100);
    // But it kicked off a background warm.
    expect(getCatalogCalls()).toBe(1);

    await materialized.dispose();
  });

  it("holds a lease for the duration of the background warm and releases it after", async () => {
    const { runtime, settleWarm, leaseBalance } = makeColdRuntime();

    const materialized = await materializeBundleMcpToolsForRunNonBlocking({ runtime });
    // Lease held while the background warm is in flight so the idle sweeper
    // cannot dispose the runtime mid-connect.
    expect(leaseBalance()).toBe(1);

    settleWarm();
    // Let the background getCatalog().finally() run.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(leaseBalance()).toBe(0);

    await materialized.dispose();
  });

  it("projects the full tool set once the background warm settles (next-run behavior)", async () => {
    const { runtime, settleWarm } = makeColdRuntime();

    const cold = await materializeBundleMcpToolsForRunNonBlocking({ runtime });
    expect(cold.tools).toEqual([]);
    await cold.dispose();

    settleWarm();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    const warm = await materializeBundleMcpToolsForRunNonBlocking({ runtime });
    expect(warm.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);

    await warm.dispose();
  });

  it("round-trips a warm tool's execute through callTool", async () => {
    const { runtime, settleWarm } = makeColdRuntime({
      result: { content: [{ type: "text", text: "PONG" }], isError: false },
    });

    const cold = await materializeBundleMcpToolsForRunNonBlocking({ runtime });
    await cold.dispose();
    settleWarm();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    const warm = await materializeBundleMcpToolsForRunNonBlocking({ runtime });
    const tool = warm.tools[0];
    if (!tool) {
      throw new Error("expected a warm bundle MCP tool");
    }
    const result = await tool.execute("call-bundle-probe", {}, undefined, undefined);

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected text content from the bundle MCP probe");
    }
    expect(content.text).toBe("PONG");
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
    });

    await warm.dispose();
  });

  it("reuses the cache and holds a run-lease (no new connect) when already warm", async () => {
    const { runtime, settleWarm, getCatalogCalls, leaseBalance } = makeColdRuntime();
    // Warm the runtime first.
    const cold = await materializeBundleMcpToolsForRunNonBlocking({ runtime });
    await cold.dispose();
    settleWarm();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(getCatalogCalls()).toBe(1);
    expect(leaseBalance()).toBe(0);

    // Warm call: reuses the cached catalog — no new getCatalog connect — and
    // holds a run-duration lease released on dispose.
    const warm = await materializeBundleMcpToolsForRunNonBlocking({ runtime });
    expect(getCatalogCalls()).toBe(1);
    expect(warm.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(leaseBalance()).toBe(1);

    await warm.dispose();
    expect(leaseBalance()).toBe(0);
  });
});
