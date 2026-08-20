// Verifies browser.sessionState config parsing (session persistence feature).
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

function parseBrowser(sessionState: unknown) {
  const result = OpenClawSchema.safeParse({ browser: { sessionState } });
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }
  return result.data.browser?.sessionState;
}

describe("OpenClawSchema browser.sessionState config", () => {
  it("is absent by default", () => {
    expect(OpenClawSchema.parse({}).browser?.sessionState).toBeUndefined();
  });

  it("accepts the full opt-in block", () => {
    expect(
      parseBrowser({
        enabled: true,
        intervalSeconds: 60,
        path: "~/.openclaw/browser-state/state.json",
      }),
    ).toStrictEqual({
      enabled: true,
      intervalSeconds: 60,
      path: "~/.openclaw/browser-state/state.json",
    });
  });

  it("rejects unknown keys and non-positive intervals", () => {
    expect(OpenClawSchema.safeParse({ browser: { sessionState: { nope: 1 } } }).success).toBe(
      false,
    );
    expect(
      OpenClawSchema.safeParse({ browser: { sessionState: { intervalSeconds: 0 } } }).success,
    ).toBe(false);
  });
});
