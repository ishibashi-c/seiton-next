import { describe, expect, it } from "vitest";
import {
  appendProjectLinkToMarkdown,
  appendTaskToMarkdown,
  countSessionsByProject,
  extractMarkdownTasks,
  extractProjectLinks,
  normalizeProjectStatus,
  projectTagName,
  relatedMemosForProject,
  removeProjectLinkFromMarkdown,
  resolveNextAction,
  toggleTaskLineInMarkdown,
} from "../src/domain/projects";
import type { PromptSessionSummary } from "../src/services/promptService";
import type { MemoIndexItem } from "../src/services/vaultIndex";

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

function memo(
  id: string,
  body: string,
  at: string,
  state: MemoIndexItem["state"] = "active"
): MemoIndexItem {
  return {
    at,
    body,
    entryId: id,
    line: 1,
    path: "Seiton/System/Logs/Memos/2026-W47.md",
    promotedTo: null,
    state,
    title: body,
    type: "memo",
    week: "2026-W47",
  };
}

describe("countSessionsByProject", () => {
  it("プロンプト0件のセッションも数える", () => {
    const counts = countSessionsByProject([
      session("サンプル企画", "a.md"),
      session("サンプル企画", "b.md"),
      session(null, "c.md"),
    ]);
    expect(counts.get("サンプル企画")).toBe(2);
  });

  it("リンク表記を正規化して同じプロジェクトに寄せる", () => {
    const counts = countSessionsByProject([
      session("[[サンプル企画]]", "a.md"),
      session("サンプル企画", "b.md"),
    ]);
    expect(counts.get("サンプル企画")).toBe(2);
  });
});

describe("projects domain extensions", () => {
  it("normalizeProjectStatus が frontmatter と archived から状態を判定する", () => {
    expect(normalizeProjectStatus({}, false)).toBe("active");
    expect(normalizeProjectStatus({ project_status: "paused" }, false)).toBe(
      "paused"
    );
    expect(normalizeProjectStatus({ project_status: "done" }, false)).toBe(
      "done"
    );
    expect(normalizeProjectStatus({ project_status: "active" }, true)).toBe(
      "done"
    );
  });

  it("extractMarkdownTasks / appendTaskToMarkdown / toggleTaskLineInMarkdown が動作する", () => {
    const initial = [
      "---",
      "kind: project",
      "---",
      "",
      "# 企画A",
      "",
      "## 目的",
      "試作品を作る",
      "",
      "```md",
      "- [ ] コード例は無視",
      "```",
    ].join("\n");

    const withTask1 = appendTaskToMarkdown(initial, "ヒアリング日程を決める");
    expect(withTask1).toContain("## タスク\n\n- [ ] ヒアリング日程を決める");

    const withTask2 = appendTaskToMarkdown(withTask1, "Figmaでモックを作る");
    const tasks = extractMarkdownTasks(
      withTask2,
      "Seiton/Notes/企画A.md",
      "企画A"
    );
    expect(tasks.map((t) => t.text)).toEqual([
      "ヒアリング日程を決める",
      "Figmaでモックを作る",
    ]);
    expect(tasks[0]?.checked).toBe(false);

    const firstTask = tasks[0];
    expect(firstTask).toBeDefined();
    if (!firstTask) {
      throw new Error("expected firstTask");
    }

    const toggled = toggleTaskLineInMarkdown(
      withTask2,
      firstTask.lineIndex,
      firstTask.line
    );
    const afterToggle = extractMarkdownTasks(
      toggled,
      "Seiton/Notes/企画A.md",
      "企画A"
    );
    expect(afterToggle[0]?.checked).toBe(true);
    expect(afterToggle[1]?.checked).toBe(false);

    const toggledFirst = afterToggle[0];
    expect(toggledFirst).toBeDefined();
    if (!toggledFirst) {
      throw new Error("expected toggledFirst");
    }
    const toggledBack = toggleTaskLineInMarkdown(
      toggled,
      toggledFirst.lineIndex,
      toggledFirst.line
    );
    expect(
      extractMarkdownTasks(toggledBack, "Seiton/Notes/企画A.md", "企画A")[0]
        ?.checked
    ).toBe(false);
  });

  it("appendTaskToMarkdown が既存セクションの間に正しく追記する", () => {
    const doc = [
      "## タスク",
      "",
      "- [ ] 最初のタスク",
      "",
      "## メモ",
      "詳細",
    ].join("\n");
    const updated = appendTaskToMarkdown(doc, "次のタスク");
    expect(updated).toBe(
      [
        "## タスク",
        "",
        "- [ ] 最初のタスク",
        "- [ ] 次のタスク",
        "",
        "## メモ",
        "詳細",
      ].join("\n")
    );
  });

  it("extractProjectLinks / appendProjectLinkToMarkdown / removeProjectLinkFromMarkdown が動作する", () => {
    const doc = "# テスト\n\n## 概要\n本文\n";
    const added1 = appendProjectLinkToMarkdown(
      doc,
      "公式Discord",
      "https://discord.com/channels/123"
    );
    const added2 = appendProjectLinkToMarkdown(
      added1,
      "",
      "https://www.figma.com/file/abc"
    );
    // 重複URLは増えない
    const dup = appendProjectLinkToMarkdown(
      added2,
      "別名",
      "https://www.figma.com/file/abc"
    );

    const links = extractProjectLinks(dup);
    expect(links.map((l) => ({ label: l.label, url: l.url }))).toEqual([
      { label: "公式Discord", url: "https://discord.com/channels/123" },
      { label: "figma.com", url: "https://www.figma.com/file/abc" },
    ]);

    const removed = removeProjectLinkFromMarkdown(
      dup,
      "https://discord.com/channels/123"
    );
    expect(extractProjectLinks(removed).map((l) => l.url)).toEqual([
      "https://www.figma.com/file/abc",
    ]);
  });

  it("relatedMemosForProject がプロジェクト名タグ付きのメモだけを新しい順で返す", () => {
    expect(projectTagName("通信制高校 コミュニティ")).toBe(
      "通信制高校_コミュニティ"
    );
    const memos = [
      memo("m1", "#動画企画 撮影場所の下見メモ", "2026-11-20T10:00:00+09:00"),
      memo("m2", "無関係なメモ #日常", "2026-11-21T10:00:00+09:00"),
      memo("m3", "#動画企画 削除済み", "2026-11-22T10:00:00+09:00", "deleted"),
      memo("m4", "サムネイル案 #動画企画", "2026-11-23T09:00:00+09:00"),
    ];
    const matched = relatedMemosForProject(memos, "動画企画");
    expect(matched.map((m) => m.entryId)).toEqual(["m4", "m1"]);
  });

  it("resolveNextAction がピン留め値を優先し、なければ先頭の未完了タスクを返す", () => {
    const tasks = [
      {
        checked: true,
        line: "- [x] 完了済み",
        lineIndex: 0,
        sourcePath: "p.md",
        sourceTitle: "P",
        text: "完了済み",
      },
      {
        checked: false,
        line: "- [ ] 未完了1",
        lineIndex: 1,
        sourcePath: "p.md",
        sourceTitle: "P",
        text: "未完了1",
      },
    ];

    expect(resolveNextAction("今すぐ確認する", tasks)).toEqual({
      isPinned: true,
      text: "今すぐ確認する",
    });
    expect(resolveNextAction("", tasks)).toEqual({
      isPinned: false,
      task: tasks[1],
      text: "未完了1",
    });
    const completedTask = tasks[0];
    expect(completedTask).toBeDefined();
    if (!completedTask) {
      throw new Error("expected completedTask");
    }
    expect(resolveNextAction(undefined, [completedTask])).toBeNull();
  });
});
