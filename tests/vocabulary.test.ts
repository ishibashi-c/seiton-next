import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../src/domain/vocabulary";

describe("buildVocabulary", () => {
  it("counts and sorts by usage", () => {
    const result = buildVocabulary([
      ["読書", "認知科学"],
      ["読書", "読書"],
      ["  "],
      ["仕事"],
    ]);
    expect(result[0]).toEqual({ count: 3, value: "読書" });
    expect(result.map((entry) => entry.value)).toEqual([
      "読書",
      "仕事",
      "認知科学",
    ]);
  });
});
