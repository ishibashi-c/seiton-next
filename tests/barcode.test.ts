import { describe, expect, it } from "vitest";
import { extractIsbnFromBarcode, isScanCooldown } from "../src/domain/barcode";

describe("extractIsbnFromBarcode", () => {
  it("有効なISBN-13（978/979）を正常に抽出する", () => {
    // 達人プログラマー (978-4-274-22629-8)
    expect(extractIsbnFromBarcode("9784274226298")).toBe("9784274226298");
    expect(extractIsbnFromBarcode("978-4-274-22629-8")).toBe("9784274226298");
  });

  it("日本の書籍の2段目バーコード（192で始まるCコード）を除外する", () => {
    // 1923055032009 (C3055 ¥3200E)
    expect(extractIsbnFromBarcode("1923055032009")).toBeNull();
  });

  it("チェックデジットが不正なコードや文字化けを除外する", () => {
    expect(extractIsbnFromBarcode("9784274226290")).toBeNull(); // 不正チェックデジット
    expect(extractIsbnFromBarcode("1234567890123")).toBeNull();
    expect(extractIsbnFromBarcode("invalid-text")).toBeNull();
    expect(extractIsbnFromBarcode("")).toBeNull();
  });
});

describe("isScanCooldown", () => {
  it("同一ISBNでクールダウン時間内の場合はtrueを返す", () => {
    const isbn = "9784274226298";
    expect(isScanCooldown(isbn, isbn, 1000, 2000, 1500)).toBe(true);
    expect(isScanCooldown(isbn, isbn, 1000, 3000, 1500)).toBe(false);
  });

  it("異なるISBNの場合はクールダウン時間内でもfalseを返す", () => {
    expect(
      isScanCooldown("9784274226298", "9784873119243", 1000, 1500, 1500)
    ).toBe(false);
  });
});
