import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { classify } from "./fleet.mjs";

describe("fleet completion classification", () => {
  const realCompletionScreens = [
    {
      file: "TASK-JARVIS-82-FIX6-20261014.txt",
      key: "TASK-JARVIS-82-FIX6-20261014",
      attempt: "5b681d72-81a9-4ad5-b541-4478d467ebb7",
      summary: "기존 재시도 identity 수정 확인 및 전후 로그 게시·재조회 완료",
    },
    {
      file: "TASK-JARVIS-RELEASE-E780-PREP-20261014.txt",
      key: "TASK-JARVIS-RELEASE-E780-PREP-20261014",
      attempt: "38c212aa-d59a-41f5-9f6e-1d2ead2074d5",
      summary: "stage=OK e780 배포 스크립트· dry-run seal·운영 체크리스트 작성 완료",
    },
    {
      file: "TASK-CRM-DEPLOY-VERIFY-GAPS-20261014.txt",
      key: "TASK-CRM-DEPLOY-VERIFY-GAPS-20261014",
      attempt: "a6a6d496-1eb5-4350-9886-95680f75f422",
      summary: "두 배포기의 TLS·DB identity 검 증 보강 및 새 PR·전후 로그 게시 완료",
    },
    {
      file: "TASK-COMPANY-HANDOFF-ACTIVATE-PLAN-20261014.txt",
      key: "TASK-COMPANY-HANDOFF-ACTIVATE-PLAN-20261014",
      attempt: "6b515135-890c-4355-89c8-45fe7a342f4e",
      summary: "대표 필요 2단계, 계 획·격리 검증 완료",
    },
  ];
  const dispatchPromptText = (key, attempt, request) => `${key} [attempt=${attempt} skill:ulw]: 지시문 파일 ${request} 전체를 읽고 그대로 수행해. 끝나면 마지막 줄에 ${key}_DONE attempt=${attempt} <한 줄 요약> 또는 ${key}_BLOCKED attempt=${attempt} reason=<한 줄>.`;
  const wrapTextAtWidth = (text, width) => {
    const lines = [];
    for (let offset = 0; offset < text.length; offset += width) lines.push(text.slice(offset, offset + width));
    return lines;
  };

  for (const fixture of realCompletionScreens) {
    it(`replays the markerless real screen for ${fixture.key}`, () => {
      const screen = readFileSync(new URL(`./fixtures/completion/${fixture.file}`, import.meta.url), "utf8");
      expect(screen).not.toMatch(/^\s*(?:⏺|●|Assistant:)\s*/m);
      expect(classify(screen).done).toEqual({
        key: fixture.key, kind: "DONE", attempt: fixture.attempt, text: fixture.summary,
      });
    });
  }

  it("filters the visible dispatch template but accepts its markerless current DONE", () => {
    const key = "TASK-MARKERLESS-PROMPT";
    const attempt = "36000000-0000-4000-8000-000000000036";
    const template = `${key}_DONE attempt=${attempt} <한 줄 요약> 또는 ${key}_BLOCKED attempt=${attempt} reason=<한 줄>.`;
    const screen = `❯ Finish with this exact final line:\n${template}\n\n${key}_DONE attempt=${attempt} completed without an assistant marker\n\n❯`;
    const result = classify(screen);
    expect(result.done).toEqual({ key, kind: "DONE", attempt, text: "completed without an assistant marker" });
    expect(result.doneCandidates.filter((candidate) => candidate.filtered).map(({ kind }) => kind))
      .toEqual(["DONE"]);
  });

  it("filters a wrapped BLOCKED reason placeholder", () => {
    const key = "TASK-WRAPPED-BLOCKED-TEMPLATE";
    const attempt = "3b000000-0000-4000-8000-00000000003b";
    const screen = `⏺ Instructions\n${key}_BLOCKED attempt=${attempt} reason=<한\n  줄>. 안내 예시\n\n❯`;
    const result = classify(screen);
    expect(result.done).toBeNull();
    expect(result.doneCandidates).toContainEqual({
      key, kind: "BLOCKED", attempt, text: "reason=<한 줄>. 안내 예시", filtered: true,
    });
  });

  it("filters width-73 DONE and wrapped BLOCKED placeholders in unruled scrollback", () => {
    const key = "TASK-INPUT-BOX-PROMPT";
    const attempt = "3a000000-0000-4000-8000-00000000003a";
    const request = "/tmp/fleet-input-box-request.md";
    const message = dispatchPromptText(key, attempt, request);
    const wrapped = wrapTextAtWidth(message, 73);
    const markerLine = wrapped.findIndex((line) => line.startsWith(`${key}_DONE attempt=${attempt}`));
    expect(markerLine).toBeGreaterThanOrEqual(0);
    expect(wrapped[markerLine]).toEndWith("<");
    expect(wrapped[markerLine + 1].startsWith("한 줄 요약>")).toBe(true);
    const result = classify(wrapped.join("\n") + "\n\n❯");
    expect(result.done).toBeNull();
    expect(result.doneCandidates.some((candidate) => candidate.key === key && candidate.kind === "DONE" && candidate.filtered))
      .toBe(true);

    const blockedKey = "TASK-BLOCKED-PLACEHOLDER-WRAP";
    const blocked = classify(`${blockedKey}_BLOCKED attempt=${attempt} reason=<한\n줄>. 안내 예시\n\n❯`);
    expect(blocked.done).toBeNull();
    expect(blocked.doneCandidates).toContainEqual({
      key: blockedKey, kind: "BLOCKED", attempt, text: "reason=<한 줄>. 안내 예시", filtered: true,
    });
  });

  it("sweeps 4,420 unruled dispatch echoes without current-attempt completions", () => {
    const keys = [
      "TASK-A",
      "TASK-INPUT-BOX-PROMPT",
      "TASK-JARVIS-82-FIX7-20261015",
      "TASK-CRM-DEPLOY-VERIFY-GAPS-20261014",
      "TASK-COMPANY-HANDOFF-ACTIVATE-PLAN-20261014",
    ];
    const pathLengths = [20, 31, 80, 160];
    const attempt = "3a000000-0000-4000-8000-00000000003a";
    let cases = 0;
    const falseCompletions = [];
    for (const key of keys) {
      for (let pathIndex = 0; pathIndex < pathLengths.length; pathIndex++) {
        const pathLength = pathLengths[pathIndex];
        const pathPrefix = `/tmp/p${pathIndex}-`;
        const pathSuffix = ".md";
        const request = `${pathPrefix}${"x".repeat(pathLength - pathPrefix.length - pathSuffix.length)}${pathSuffix}`;
        expect(request.length).toBe(pathLength);
        const message = dispatchPromptText(key, attempt, request);
        for (let width = 20; width <= 240; width++) {
          const screen = `Older scrollback\n${wrapTextAtWidth(message, width).join("\n")}\n\n❯`;
          const result = classify(screen);
          if (result.done?.key === key && result.done.attempt === attempt
            || result.doneCandidates.some((candidate) => candidate.key === key && candidate.attempt === attempt && !candidate.filtered))
            falseCompletions.push({ key, pathLength, width, done: result.done });
          cases++;
        }
      }
    }
    expect(cases).toBe(4420);
    expect(falseCompletions).toEqual([]);
  });
});
