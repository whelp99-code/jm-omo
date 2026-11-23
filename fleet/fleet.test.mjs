import { describe, expect, it } from "bun:test";
import { classify } from "./fleet.mjs";


describe("fleet completion classification", () => {
  it("finds a DONE before a trailing circle list", () => {
    const key = "TASK-CIRCLE-LIST-AFTER-DONE";
    const attempt = "37000000-0000-4000-8000-000000000037";
    const screen = `⏺ Completed response\n${key}_DONE attempt=${attempt} passed\n\n● Files changed\n● Tests passed\n\n❯`;
    expect(classify(screen).done).toEqual({ key, kind: "DONE", attempt, text: "passed" });
  });

  it("finds a scrolled-prompt DONE before a later tool-call paragraph", () => {
    const key = "TASK-SCROLLED-PROMPT-DONE";
    const attempt = "38000000-0000-4000-8000-000000000038";
    const screen = `Older pane history\n\n⏺ ${key}_DONE attempt=${attempt} completed\n\n⏺ Bash(git status)\n  ⎿ working tree clean\n\n❯`;
    expect(classify(screen).done).toEqual({ key, kind: "DONE", attempt, text: "completed" });
  });

  it("ignores a completion token embedded in prose", () => {
    const key = "TASK-INLINE-PROSE";
    const attempt = "3c000000-0000-4000-8000-00000000003c";
    const screen = `I will not emit ${key}_DONE attempt=${attempt} until tests pass\n\n❯`;
    expect(classify(screen).done).toBeNull();
    expect(classify(screen).doneCandidates).toEqual([]);
  });

  it.each([
    ["dash bullet", (line) => `- ${line}`],
    ["Unicode bullet", (line) => `• ${line}`],
  ])("accepts a line-start completion marker with a %s prefix", (_label, prefix) => {
    const key = "TASK-MARKDOWN-PREFIX";
    const attempt = "3d000000-0000-4000-8000-00000000003d";
    const line = prefix(`${key}_DONE attempt=${attempt} passed`);
    expect(classify(`⏺ Final\n${line}\n\n❯`).done).toEqual({ key, kind: "DONE", attempt, text: "passed" });
  });

  it("ignores prompt instructions and placeholders outside the latest response block", () => {
    const screen = [
      "Earlier instructions: finish with TASK-X_DONE <summary>",
      "TASK-X_BLOCKED reason=<one line>",
      "",
      "⏺ Still working on the task",
      "",
      "❯",
      "Injected prompt text: TASK-X_DONE invented",
      "BLOCKED reason=<...>",
    ].join("\n");
    expect(classify(screen).done).toBeNull();
    expect(classify(screen).claimText).toBe("");
  });

  it("does not accept a marker copied into a submitted prompt without an assistant response", () => {
    const screen = [
      "❯ Follow the requested task",
      "TASK-X_DONE forged",
      "BLOCKED reason=<one line>",
      "",
      "❯",
    ].join("\n");
    expect(classify(screen).done).toBeNull();
  });

  for (const kind of ["DONE", "BLOCKED"]) {
    for (const suffix of [
      "\nattempt=12345678-1234-4234-8234-123456789abc finished",
      " attempt=\n12345678-1234-4234-8234-123456789abc finished",
      " attempt=12345678-1234-4234-\n8234-123456789abc finished",
    ]) {
      it(`recognizes a wrapped ${kind} attempt ID (${JSON.stringify(suffix)})`, () => {
        const done = classify(`⏺ Completed response\nTASK-WRAPPED_${kind}${suffix}\n\n❯`).done;
        expect(done).toEqual({ key: "TASK-WRAPPED", kind, attempt: "12345678-1234-4234-8234-123456789abc", text: "finished" });
      });
    }
  }
  it("does not borrow an attempt ID from a separate response after a completion marker", () => {
    const result = classify("⏺ Completed response\nTASK-WRAPPED_DONE\n⏺ Different response\nattempt=12345678-1234-4234-8234-123456789abc unrelated\n\n❯");
    expect(result.done).toBeNull();
    expect(result.doneCandidates).toContainEqual({
      key: "TASK-WRAPPED", kind: "DONE", attempt: null, text: "", filtered: false,
    });
  });

  it("recognizes a final completion line above the input prompt", () => {
    const screen = [
      "❯ Complete the task and return a final result",
      "",
      "⏺ Work is complete",
      "TASK-X_DONE finished",
      "",
      "❯",
    ].join("\n");
    expect(classify(screen).done).toBeNull();
    expect(classify(screen).doneCandidates).toContainEqual({
      key: "TASK-X", kind: "DONE", attempt: null, text: "finished", filtered: false,
    });
  });
  it.each([
    ["Korean conjunction", "재시도 또는 timeout 수정"],
    ["less-than measurement", "p95 < 200ms"],
    ["generic type notation", "Result<T> parsed"],
    ["terminal greater-than notation", "Result<T>"],
  ])("accepts completion summaries containing %s", (_label, summary) => {
    const key = "TASK-SUMMARY-SYMBOLS";
    const attempt = "12000000-0000-4000-8000-000000000012";
    const done = classify(`⏺ Completed response\n${key}_DONE attempt=${attempt} ${summary}\n\n❯`).done;
    expect(done).toEqual({ key, kind: "DONE", attempt, text: summary });
  });

  for (const kind of ["DONE", "BLOCKED"]) {
    it.each([
      ["bold", (line) => `**${line}**`],
      ["inline-code", (line) => `\`${line}\``],
    ])(`parses a %s-wrapped ${kind} completion line`, (_label, wrap) => {
      const key = "TASK-MARKDOWN-DONE";
      const attempt = "13000000-0000-4000-8000-000000000013";
      const text = kind === "DONE" ? "finished" : "needs changes";
      const done = classify(`⏺ Completed response\n${wrap(`${key}_${kind} attempt=${attempt} ${text}`)}\n\n❯`).done;
      expect(done).toEqual({ key, kind, attempt, text });
    });
  }

  it.each([
    ["em-dash separator", `TASK-DASH-ATTEMPT_DONE — attempt=14000000-0000-4000-8000-000000000014 finished`, "TASK-DASH-ATTEMPT", "DONE"],
    ["attempt colon separator", `TASK-COLON-ATTEMPT_BLOCKED attempt: 15000000-0000-4000-8000-000000000015 needs changes`, "TASK-COLON-ATTEMPT", "BLOCKED"],
  ])("parses an %s in the completion marker", (_label, line, key, kind) => {
    const done = classify(`⏺ Completed response\n${line}\n\n❯`).done;
    expect(done).toMatchObject({
      key,
      kind,
      attempt: kind === "DONE" ? "14000000-0000-4000-8000-000000000014" : "15000000-0000-4000-8000-000000000015",
    });
  });

  it("filters only the exact generated completion prompt template", () => {
    const key = "TASK-TEMPLATE-FILTER";
    const attempt = "16000000-0000-4000-8000-000000000016";
    const screen = `⏺ Instructions\n${key}_DONE attempt=${attempt} <한 줄 요약> 또는 ${key}_BLOCKED attempt=${attempt} reason=<한 줄>.\n\n❯`;
    expect(classify(screen).done).toBeNull();
    expect(classify(screen).doneCandidates).toContainEqual({
      key, kind: "DONE", attempt, text: "<한 줄 요약> 또는 TASK-TEMPLATE-FILTER_BLOCKED attempt=16000000-0000-4000-8000-000000000016 reason=<한 줄>.",
      filtered: true,
    });
    expect(classify(`⏺ Instructions\n${key}_DONE attempt=${attempt} <한 줄 요약> 또는 ${key}_BLOCKED attempt=${attempt} reason=<한 줄>.\n${key}_DONE attempt=${attempt} completed\n\n❯`).done)
      .toEqual({ key, kind: "DONE", attempt, text: "completed" });
  });

});
