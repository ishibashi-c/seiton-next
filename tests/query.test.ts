import { describe, expect, it } from "vitest";
import { parseQuery } from "../src/domain/query";

describe("parseQuery", () => {
  it("parses filters and leaves the full-text terms", () => {
    const parsed = parseQuery(
      'kind:book tag:積読 project:"新Seiton 開発" is:review カード'
    );
    expect(parsed).toEqual({
      kinds: ["book"],
      list: null,
      project: "新Seiton 開発",
      status: "review",
      tags: ["積読"],
      text: "カード",
    });
  });

  it("supports #tags, comma kinds and list filters", () => {
    const parsed = parseQuery("kind:book,article #読書 list:あとで読む");
    expect(parsed.kinds).toEqual(["book", "article"]);
    expect(parsed.tags).toEqual(["読書"]);
    expect(parsed.list).toBe("あとで読む");
    expect(parsed.text).toBe("");
  });

  it("ignores negations and unknown keys become text", () => {
    const parsed = parseQuery("-is:archived メモ");
    expect(parsed.text).toBe("メモ");
    expect(parseQuery("foo:bar").text).toBe("foo:bar");
  });
});
