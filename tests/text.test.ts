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

describe("httpStatusHint", () => {
  it("代表的なステータスを日本語の理由に変える", async () => {
    const { httpStatusHint } = await import("../src/domain/errors");
    expect(httpStatusHint(401)).toContain("APIキー");
    expect(httpStatusHint(404)).toBe("見つかりませんでした");
    expect(httpStatusHint(429)).toContain("回数制限");
    expect(httpStatusHint(503)).toContain("時間をおいて");
    expect(httpStatusHint(418)).toBe("通信できませんでした");
  });
});
