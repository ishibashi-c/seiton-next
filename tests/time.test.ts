import { describe, expect, it } from "vitest";
import {
  clockOf,
  dateKeyOf,
  dateKeyToLocalDate,
  formatLocalIso,
  isValidAt,
  isValidDateKey,
} from "../src/domain/time";

describe("記録日時", () => {
  it("ローカル時刻とオフセットをISO 8601で保存する", () => {
    const value = formatLocalIso(new Date(2026, 9, 26, 9, 32, 5));
    expect(value).toMatch(/^2026-10-26T09:32:05[+-]\d{2}:\d{2}$/u);
    expect(isValidAt(value)).toBe(true);
    expect(dateKeyOf(value)).toBe("2026-10-26");
    expect(clockOf(value)).toBe("09:32");
  });

  it("オフセット付き文字列の日付・時刻をそのまま表示に使う", () => {
    expect(dateKeyOf("2026-10-26T23:30:00-05:00")).toBe("2026-10-26");
    expect(clockOf("2026-10-26T23:30:00-05:00")).toBe("23:30");
  });

  it("不正な日時を拒否する", () => {
    expect(isValidAt("2026-10-26T09:32:00")).toBe(false);
    expect(isValidAt("2026-13-01T09:32:00+09:00")).toBe(false);
    expect(isValidAt("2026-02-30T09:32:00+09:00")).toBe(false);
    expect(isValidAt("2026-10-26T24:00:00+09:00")).toBe(false);
    expect(isValidAt("")).toBe(false);
  });

  it("うるう日を受理する", () => {
    expect(isValidAt("2024-02-29T12:00:00+09:00")).toBe(true);
    expect(isValidAt("2025-02-29T12:00:00+09:00")).toBe(false);
  });

  it("日付キーを検証し、表示用の正午Dateにする", () => {
    expect(isValidDateKey("2026-10-26")).toBe(true);
    expect(isValidDateKey("2026-02-29")).toBe(false);
    const date = dateKeyToLocalDate("2026-10-26");
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(9);
    expect(date?.getDate()).toBe(26);
    expect(date?.getHours()).toBe(12);
    expect(dateKeyToLocalDate("bad")).toBeNull();
  });
});
