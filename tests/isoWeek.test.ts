import { describe, expect, it } from "vitest";
import {
  formatWeekId,
  isoWeekOf,
  isoWeeksInYear,
  isValidWeekId,
  localDate,
  parseWeekId,
  recentWeekIds,
  startOfIsoWeek,
  weekIdOf,
  weekRange,
} from "../src/domain/isoWeek";

describe("ISO週", () => {
  it.each([
    ["2026-01-01", 2026, 1],
    ["2026-10-26", 2026, 44],
    ["2026-11-01", 2026, 44],
    ["2026-12-31", 2026, 53],
    ["2027-01-01", 2026, 53],
    ["2027-01-04", 2027, 1],
    ["2021-01-01", 2020, 53],
    ["2020-12-31", 2020, 53],
    ["2024-12-30", 2025, 1],
    ["2019-12-30", 2020, 1],
    ["2015-12-31", 2015, 53],
    ["2016-01-01", 2015, 53],
    ["2024-02-29", 2024, 9],
  ])("%s は %i-W%i", (dateText, year, week) => {
    const [y, m, d] = dateText.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    expect(isoWeekOf(localDate(y, m, d))).toEqual({ week, year });
    expect(weekIdOf(localDate(y, m, d))).toBe(formatWeekId(year, week));
  });

  it("年末年始でも週年が切り替わる", () => {
    expect(weekIdOf(localDate(2026, 12, 31))).toBe("2026-W53");
    expect(weekIdOf(localDate(2027, 1, 3))).toBe("2026-W53");
    expect(weekIdOf(localDate(2027, 1, 4))).toBe("2027-W01");
  });

  it("存在する週だけを受理する", () => {
    expect(isValidWeekId("2026-W44")).toBe(true);
    expect(isValidWeekId("2026-W53")).toBe(true);
    expect(isValidWeekId("2025-W53")).toBe(false);
    expect(isValidWeekId("2026-W54")).toBe(false);
    expect(isValidWeekId("2026-W00")).toBe(false);
    expect(isValidWeekId("2026-44")).toBe(false);
    expect(isValidWeekId("0000-W01")).toBe(false);
  });

  it("週数を52/53で返す", () => {
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeeksInYear(2020)).toBe(53);
    expect(isoWeeksInYear(2024)).toBe(52);
  });

  it("週の月曜から日曜を返す", () => {
    const range = weekRange("2026-W44");
    expect(range).not.toBeNull();
    expect(range?.start.getFullYear()).toBe(2026);
    expect(range?.start.getMonth()).toBe(9);
    expect(range?.start.getDate()).toBe(26);
    expect(range?.end.getDate()).toBe(1);
    expect(range?.end.getMonth()).toBe(10);
  });

  it("週をまたぐ過去週リストを作る", () => {
    expect(recentWeekIds(localDate(2026, 10, 26, 9), 3)).toEqual([
      "2026-W44",
      "2026-W43",
      "2026-W42",
    ]);
    expect(recentWeekIds(localDate(2027, 1, 1, 9), 3)).toEqual([
      "2026-W53",
      "2026-W52",
      "2026-W51",
    ]);
  });

  it("月曜始まりの週初めを返す", () => {
    const monday = startOfIsoWeek(localDate(2026, 10, 28, 23, 30));
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(26);
    expect(monday.getHours()).toBe(0);
  });

  it("不正な週識別子はnull", () => {
    expect(parseWeekId("2026-W44")).toEqual({ week: 44, year: 2026 });
    expect(parseWeekId("2026-W54")).toBeNull();
    expect(parseWeekId("abc")).toBeNull();
  });
});
