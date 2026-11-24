import { describe, expect, it } from "vitest";
import {
  type ClassSessionEntry,
  findSessionForDate,
  findSessionForRound,
  listCourseSessions,
  parseClassScheduleMarkdown,
  resolveSuggestedSession,
  serializeClassScheduleMarkdown,
} from "../src/domain/classSchedule";

const SAMPLE_ENTRIES: ClassSessionEntry[] = [
  {
    cancelled: true,
    course: "英語A",
    date: "2026-09-16",
    dayOfWeek: "水",
    grade: "1年",
    note: "休講",
    period: "1限",
    round: 1,
    term: "後期",
  },
  {
    course: "英語A",
    date: "2026-09-30",
    dayOfWeek: "水",
    grade: "1年",
    period: "1限",
    round: 2,
    term: "後期",
  },
  {
    course: "英語A",
    date: "2026-10-07",
    dayOfWeek: "水",
    grade: "1年",
    period: "1限",
    round: 3,
    term: "後期",
  },
  {
    course: "デザイン演習",
    date: "2026-05-12",
    dayOfWeek: "火",
    grade: "1年",
    period: "3限",
    round: 5,
    term: "前期",
  },
  {
    course: "英語A",
    date: "2026-04-08",
    dayOfWeek: "水",
    grade: "1年",
    period: "1限",
    round: 1,
    term: "前期",
  },
];

describe("classSchedule domain", () => {
  it("serialize と parseClassScheduleMarkdown が開講日カレンダーを往復変換する", () => {
    const markdown = serializeClassScheduleMarkdown(SAMPLE_ENTRIES);
    expect(markdown).toContain("kind: class-schedule");
    expect(markdown).toContain("# 授業開講日カレンダー");

    const parsed = parseClassScheduleMarkdown(markdown);
    expect(parsed).toEqual(SAMPLE_ENTRIES);
  });

  it("備考が 休 や 休講 の行を cancelled: true として読む", () => {
    const raw = [
      "| 科目名 | 学年 | 学期 | 回 | 日付 | 曜日 | 時限 | 備考 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 現代文論 | 1年 | 前期 | 2 | 2026-04-14 | 火 | 3限 | 休 |",
      "| 現代文論 | 1年 | 前期 | 3 | 2026-04-21 | 火 | 3限 | 休講振替 |",
      "| 現代文論 | 1年 | 前期 | 4 | 2026-04-28 | 火 | 3限 |  |",
    ].join("\n");
    const parsed = parseClassScheduleMarkdown(raw);
    expect(parsed[0]?.cancelled).toBe(true);
    expect(parsed[1]?.cancelled).toBe(true);
    expect(parsed[2]?.cancelled).toBeUndefined();
  });

  it("listCourseSessions が科目・学期で絞り込み回数順に並べる", () => {
    const sessions = listCourseSessions(SAMPLE_ENTRIES, "英語A", "後期");
    expect(sessions.map((s) => s.round)).toEqual([1, 2, 3]);
    expect(
      listCourseSessions(SAMPLE_ENTRIES, "英語A", "前期").map((s) => s.date)
    ).toEqual(["2026-04-08"]);
  });

  it("findSessionForDate と findSessionForRound が正しい回・日付を引く", () => {
    expect(
      findSessionForDate(SAMPLE_ENTRIES, "英語A", "2026-09-30", "後期")?.round
    ).toBe(2);
    expect(findSessionForRound(SAMPLE_ENTRIES, "英語A", 3, "後期")?.date).toBe(
      "2026-10-07"
    );
    expect(
      findSessionForDate(SAMPLE_ENTRIES, "英語A", "2026-12-31", "後期")
    ).toBeNull();
  });

  it("resolveSuggestedSession が今日一致・直近開講日・初回予定日を適切に返す", () => {
    // 休講日の翌日は、次の未休講回（2回）を返す
    expect(
      resolveSuggestedSession(SAMPLE_ENTRIES, "英語A", "2026-09-17", "後期")
        ?.round
    ).toBe(2);
    // 開講日当日はその回を返す
    expect(
      resolveSuggestedSession(SAMPLE_ENTRIES, "英語A", "2026-09-30", "後期")
        ?.round
    ).toBe(2);
    // 開講日以降は直近の過去の実施回を返す
    expect(
      resolveSuggestedSession(SAMPLE_ENTRIES, "英語A", "2026-10-05", "後期")
        ?.round
    ).toBe(2);
    expect(
      resolveSuggestedSession(SAMPLE_ENTRIES, "英語A", "2026-10-14", "後期")
        ?.round
    ).toBe(3);
  });
});
