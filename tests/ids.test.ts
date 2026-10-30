import { describe, expect, it } from "vitest";
import {
  createId,
  createMemoId,
  isLogEntryId,
  timestampOfId,
} from "../src/domain/ids";

describe("安定ID", () => {
  it("m_ + 26文字のULID形式になる", () => {
    const id = createMemoId({ now: 1_790_000_000_000 });
    expect(id).toMatch(/^m_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(isLogEntryId(id)).toBe(true);
  });

  it("同じ時刻でも乱数部分で区別できる", () => {
    const now = 1_790_000_000_000;
    let counter = 0;
    const randomBytes = (size: number): Uint8Array => {
      const bytes = new Uint8Array(size);
      bytes.fill(counter);
      counter += 1;
      return bytes;
    };
    const first = createMemoId({ now, randomBytes });
    const second = createMemoId({ now, randomBytes });
    expect(first).not.toBe(second);
    expect(timestampOfId(first)).toBe(now);
  });

  it("接頭辞を検証する", () => {
    expect(createId("p_", { now: 0 })).toMatch(/^p_/u);
    expect(() => createId("memo")).toThrow();
  });

  it("I/L/O/Uを使わないCrockford Base32", () => {
    const id = createMemoId({
      now: 1,
      randomBytes: (size) => new Uint8Array(size).fill(31),
    });
    expect(id.slice(2)).not.toMatch(/[ILOU]/u);
  });

  it("不正なIDは時刻を取り出せない", () => {
    expect(timestampOfId("m_short")).toBeNull();
    expect(isLogEntryId("x_00000000000000000000000000")).toBe(true);
    expect(isLogEntryId("x_0000000000000000000000000I")).toBe(false);
  });
});
