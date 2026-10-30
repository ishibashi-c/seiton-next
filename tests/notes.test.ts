import { describe, expect, it } from "vitest";
import {
  bodyAfterFrontmatter,
  frontmatterField,
} from "../src/domain/frontmatter";
import {
  appendPromotionLink,
  buildPromotedNoteDocument,
  isPromotableKind,
  promotedNotePath,
  sanitizeNoteTitle,
  stripMarkdownExtension,
  titleFromMemoBody,
  withPathSuffix,
} from "../src/domain/notes";

describe("昇格ノートの生成", () => {
  it("本文の先頭からタイトルを作る", () => {
    expect(titleFromMemoBody("# 見出し\n本文")).toBe("見出し");
    expect(titleFromMemoBody("**太字** のアイデア")).toBe("太字 のアイデア");
    expect(titleFromMemoBody("- [リンク](https://example.com) のメモ")).toBe(
      "リンク のメモ"
    );
    expect(titleFromMemoBody("[[Seiton|整頓]] の話")).toBe("整頓 の話");
    expect(titleFromMemoBody("```ts\nconst x = 1;\n```")).toBe("一言メモ");
    expect(titleFromMemoBody("")).toBe("一言メモ");
  });

  it("ファイル名に使えない文字を置き換える", () => {
    expect(sanitizeNoteTitle('a/b:c*d?e"f<g>h|i#j^k[l]m')).toBe(
      "a-b-c-d-e-f-g-h-i-j-k-l-m"
    );
    expect(sanitizeNoteTitle("  ..  ")).toBe("一言メモ");
    expect(sanitizeNoteTitle("CON")).toBe("_CON");
    expect(sanitizeNoteTitle("通常の タイトル")).toBe("通常の タイトル");
  });

  it("昇格先パスを作る", () => {
    expect(promotedNotePath("2026-10-26", "買い物/リスト")).toBe(
      "Seiton/Notes/2026-10-26-買い物-リスト.md"
    );
    expect(withPathSuffix("Seiton/Notes/a.md", "abcd1234")).toBe(
      "Seiton/Notes/a-abcd1234.md"
    );
    expect(stripMarkdownExtension("Seiton/Notes/a.md")).toBe("Seiton/Notes/a");
  });

  it("昇格ノートのfrontmatterと本文を生成する", () => {
    const body = "本文\n\n```ts\nconst x = 1;\n```";
    const document = buildPromotedNoteDocument({
      body,
      created: "2026-10-26T10:00:00+09:00",
      kind: "idea",
      memoId: "m_TEST",
    });
    expect(frontmatterField(document, "kind")).toBe("idea");
    expect(frontmatterField(document, "seiton_memo_id")).toBe("m_TEST");
    expect(frontmatterField(document, "created")).toBe(
      "2026-10-26T10:00:00+09:00"
    );
    expect(bodyAfterFrontmatter(document)).toBe(`${body}\n`);
  });

  it("昇格リンクを重複して追記しない", () => {
    const link = "[[Seiton/Notes/a]]";
    const once = appendPromotionLink("本文", link);
    expect(once).toBe(`本文\n\n> 昇格先: ${link}`);
    expect(appendPromotionLink(once, link)).toBe(once);
    expect(appendPromotionLink("", link)).toBe(`> 昇格先: ${link}`);
  });

  it("昇格可能な種類だけを受理する", () => {
    expect(isPromotableKind("idea")).toBe(true);
    expect(isPromotableKind("note")).toBe(true);
    expect(isPromotableKind("memo-log")).toBe(false);
  });
});

describe("sanitizeNoteTitle と絵文字", () => {
  it("Dropboxが拒否する絵文字をファイル名から除く", () => {
    expect(sanitizeNoteTitle("ito✖️駄菓子")).toBe("ito駄菓子");
    expect(sanitizeNoteTitle("🎉パーティー🍣")).toBe("パーティー");
    expect(sanitizeNoteTitle("a🍣b")).toBe("ab");
  });

  it("絵文字を除いた結果が空なら既定名にする", () => {
    expect(sanitizeNoteTitle("🍣")).toBe("一言メモ");
  });
});
