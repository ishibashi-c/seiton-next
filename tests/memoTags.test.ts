import { describe, expect, it } from "vitest";
import { extractTags } from "../src/domain/memoTags";

describe("extractTags", () => {
  it("本文のタグを最初に出た順で返す", () => {
    expect(extractTags("今日は #授業 のあと #読書 する")).toEqual([
      "授業",
      "読書",
    ]);
  });

  it("コードブロックとインラインコードの中は拾わない", () => {
    const body = "```\n#コード\n```\n`#インライン` と #本文\n\n    #インデント";
    expect(extractTags(body)).toEqual(["本文"]);
  });

  it("URLとエスケープした#は拾わない", () => {
    const body =
      "https://example.com/page#section と \\#タグ と #本物 https://zenn.dev/a#x";
    expect(extractTags(body)).toEqual(["本物"]);
  });

  it("句読点を除き、ドットを含む語と数字だけの語は拾わない", () => {
    expect(extractTags("#タグ、#foo.bar #123 #v2")).toEqual(["タグ", "v2"]);
  });

  it("大文字小文字の重複をまとめる", () => {
    expect(extractTags("#Web #web #WEB")).toEqual(["Web"]);
  });

  it("見出し記号は拾わない", () => {
    expect(extractTags("# 見出し\n## 小見出し")).toEqual([]);
  });
});
