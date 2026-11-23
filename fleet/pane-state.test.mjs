import { describe, expect, it } from "bun:test";
import { classify } from "./fleet.mjs";

describe("fleet pane state and PR claims", () => {
  it("keeps working-state classification and limits PR READY parsing to the latest response", () => {
    const screen = [
      "Earlier prompt: PR READY head=abcdef1234567",
      "",
      "Working (3m 2s)",
      "Current output has no release claim",
      "",
      "❯",
    ].join("\n");
    expect(classify(screen).state).toBe("working");
    expect(classify(screen).ready).toBeNull();
  });

  it("recognizes a PR READY claim in the latest response block", () => {
    const screen = ["Build complete", "jm-omo PR READY head=abcdef1234567", "", "❯"].join("\n");
    expect(classify(screen).ready).toEqual({ repo: "jm-omo", head: "abcdef1234567" });
    expect(classify(screen).claimText).toBe("jm-omo PR READY head=abcdef1234567");
  });
});
