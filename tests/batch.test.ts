import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/domain/concurrency";
import { analyzeCoverCache, formatBytes } from "../src/domain/coverCache";
import { parseIsbnList } from "../src/domain/isbnBatch";

describe("parseIsbnList", () => {
  it("normalizes, dedupes and separates invalid values", () => {
    const result = parseIsbnList(
      "978-4-87311-924-3\n9784873119243, 12345\n9784101010014"
    );
    expect(result.valid).toEqual(["9784873119243", "9784101010014"]);
    expect(result.duplicates).toEqual(["9784873119243"]);
    expect(result.invalid).toEqual(["12345"]);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps input order and respects the limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return value * 2;
      }
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("analyzeCoverCache", () => {
  it("finds orphans and totals sizes inside the folder", () => {
    const analysis = analyzeCoverCache(
      [
        { path: "Seiton/System/Assets/Covers/a.jpg", size: 100 },
        { path: "Seiton/System/Assets/Covers/b.jpg", size: 300 },
        { path: "Seiton/Notes/x.jpg", size: 50 },
      ],
      ["Seiton/System/Assets/Covers/a.jpg"],
      "Seiton/System/Assets/Covers"
    );
    expect(analysis.files).toHaveLength(2);
    expect(analysis.totalBytes).toBe(400);
    expect(analysis.orphans.map((file) => file.path)).toEqual([
      "Seiton/System/Assets/Covers/b.jpg",
    ]);
    expect(analysis.orphanBytes).toBe(300);
  });

  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
