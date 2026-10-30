import { describe, expect, it } from "vitest";
import { countSessionsByProject } from "../src/domain/projects";
import type { PromptSessionSummary } from "../src/services/promptService";

function session(project: string | null, path: string): PromptSessionSummary {
  return {
    createdAt: "2026-10-30T00:00:00+09:00",
    draftPreview: "",
    lastPromptPreview: "",
    mtime: 1,
    path,
    project,
    promptCount: 0,
    state: "open",
    title: path,
  };
}

describe("countSessionsByProject", () => {
  it("プロンプト0件のセッションも数える", () => {
    const counts = countSessionsByProject([
      session("サンプル企画", "a.md"),
      session("サンプル企画", "b.md"),
      session(null, "c.md"),
    ]);
    expect(counts.get("村田tv")).toBe(2);
  });

  it("リンク表記を正規化して同じプロジェクトに寄せる", () => {
    const counts = countSessionsByProject([
      session("[[サンプル企画]]", "a.md"),
      session("サンプル企画", "b.md"),
    ]);
    expect(counts.get("村田tv")).toBe(2);
  });
});
