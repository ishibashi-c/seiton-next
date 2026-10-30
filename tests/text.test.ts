import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "../src/domain/text";

describe("decodeHtmlEntities", () => {
  it("数値・16進・名前付き参照を戻す", () => {
    expect(decodeHtmlEntities("&#x7dd2; &#32218; &amp;")).toBe("緒 線 &");
  });

  it("参照でない文字列は変えない", () => {
    expect(decodeHtmlEntities("A & B")).toBe("A & B");
  });
});
