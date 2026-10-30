import { describe, expect, it } from "vitest";
import {
  bodyAfterFrontmatter,
  buildFrontmatter,
  frontmatterField,
  frontmatterList,
  scanFrontmatter,
  setFrontmatterScalar,
  yamlQuoted,
} from "../src/domain/frontmatter";

describe("frontmatter読み取り", () => {
  it("単純なスカラー・引用符・行末コメントを読む", () => {
    const content = [
      "---",
      "kind: memo-log",
      'week: "2026-W44"',
      "title: 今週のメモ # コメント",
      "created: '2026-10-26T09:00:00+09:00'",
      "nested:",
      "  child: ignore",
      "---",
      "",
      "本文",
    ].join("\n");
    const scan = scanFrontmatter(content);
    expect(scan.present).toBe(true);
    expect(scan.closed).toBe(true);
    expect(scan.fields.kind).toBe("memo-log");
    expect(scan.fields.week).toBe("2026-W44");
    expect(scan.fields.title).toBe("今週のメモ");
    expect(scan.fields.created).toBe("2026-10-26T09:00:00+09:00");
    expect(scan.fields.nested).toBe("");
    expect(scan.bodyStartLine).toBe(8);
    expect(bodyAfterFrontmatter(content)).toBe("本文");
  });

  it("frontmatterがない文書をそのまま本文として扱う", () => {
    const scan = scanFrontmatter("# 見出し\n本文");
    expect(scan.present).toBe(false);
    expect(bodyAfterFrontmatter("# 見出し\n本文")).toBe("# 見出し\n本文");
  });

  it("閉じていないfrontmatterを検出する", () => {
    const scan = scanFrontmatter("---\nkind: memo-log\n本文");
    expect(scan.present).toBe(true);
    expect(scan.closed).toBe(false);
    expect(scan.closeLineNumber).toBeNull();
  });

  it("重複キーを報告し、最初の値を使う", () => {
    const scan = scanFrontmatter(
      "---\nkind: memo-log\nkind: note\nweek: 2026-W44\n---\n"
    );
    expect(scan.fields.kind).toBe("memo-log");
    expect(scan.duplicateKeys).toContain("kind");
    expect(frontmatterField("---\nweek: 2026-W44\n---\n", "week")).toBe(
      "2026-W44"
    );
  });

  it("CRLFとBOMを扱える", () => {
    const content =
      "\uFEFF---\r\nkind: memo-log\r\nweek: 2026-W44\r\n---\r\n\r\n本文\r\n";
    const scan = scanFrontmatter(content);
    expect(scan.fields.kind).toBe("memo-log");
    expect(bodyAfterFrontmatter(content)).toBe("本文\r\n");
  });

  it("新規frontmatterを生成し、引用符を安全に扱う", () => {
    const value = 'a"b\\c\nd';
    const quoted = yamlQuoted(value);
    const content = buildFrontmatter({ kind: "note", title: quoted });
    const scan = scanFrontmatter(content);
    expect(scan.fields.title).toBe(value);
    expect(scan.fields.kind).toBe("note");
  });
});

describe("frontmatterのリストと状態更新", () => {
  it("projectsのリンクリストを読む", () => {
    const content = `---\nkind: prompt-session\nprojects:\n  - "[[Seiton]]"\n  - "[[別プロジェクト]]"\nsession_state: open\n---\n\n本文\n`;
    expect(frontmatterList(content, "projects")).toEqual([
      "[[Seiton]]",
      "[[別プロジェクト]]",
    ]);
  });

  it("他のキーのリストを混ぜない", () => {
    const content = `---\nprojects:\n  - "[[A]]"\ntags:\n  - tag1\n---\n`;
    expect(frontmatterList(content, "projects")).toEqual(["[[A]]"]);
    expect(frontmatterList(content, "tags")).toEqual(["tag1"]);
  });

  it("状態の1行だけを置き換える", () => {
    const content =
      "---\nkind: prompt-session\ncustom: keep\nsession_state: open\n---\n\n本文\n";
    const updated = setFrontmatterScalar(content, "session_state", "closed");
    expect(updated).toContain("custom: keep");
    expect(updated).toContain("session_state: closed");
    expect(updated).toContain("本文");
  });

  it("キーがなければ終端の直前に追加する", () => {
    const content = "---\nkind: note\n---\n\n本文\n";
    const updated = setFrontmatterScalar(content, "archived", "true");
    expect(updated).toContain("kind: note");
    expect(updated).toContain("archived: true");
    expect(updated.indexOf("archived: true")).toBeLessThan(
      updated.lastIndexOf("---")
    );
  });
});
