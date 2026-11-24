import { describe, expect, it } from "vitest";
import {
  classNotePreview,
  countUncheckedTasks,
  coursesForWeekday,
  currentPeriodOf,
  partitionCoursesForTimetable,
  timetableCellKey,
  weekdayLabelOf,
} from "../src/domain/classes";
import { scanFrontmatter } from "../src/domain/frontmatter";
import {
  buildNoteDocument,
  buildTemplateBody,
} from "../src/domain/noteTemplates";
import type { CourseRegistration } from "../src/services/settings";

function course(
  name: string,
  overrides: Partial<CourseRegistration> = {}
): CourseRegistration {
  return {
    grade: "1年",
    id: `c_${name}`,
    name,
    term: "後期",
    ...overrides,
  };
}

describe("classes domain", () => {
  it("weekdayLabelOf が日本語の曜日1文字を返す", () => {
    expect(weekdayLabelOf(new Date(2026, 10, 22, 10, 0))).toBe("日");
    expect(weekdayLabelOf(new Date(2026, 10, 23, 10, 0))).toBe("月");
    expect(weekdayLabelOf(new Date(2026, 10, 24, 10, 0))).toBe("火");
    expect(weekdayLabelOf(new Date(2026, 10, 28, 10, 0))).toBe("土");
  });

  it("currentPeriodOf が講義時間帯から現在の時限を判定する", () => {
    expect(currentPeriodOf(new Date(2026, 10, 24, 8, 59))).toBeNull();
    expect(currentPeriodOf(new Date(2026, 10, 24, 9, 0))).toBe("1限");
    expect(currentPeriodOf(new Date(2026, 10, 24, 10, 30))).toBe("1限");
    expect(currentPeriodOf(new Date(2026, 10, 24, 10, 35))).toBeNull();
    expect(currentPeriodOf(new Date(2026, 10, 24, 11, 0))).toBe("2限");
    expect(currentPeriodOf(new Date(2026, 10, 24, 13, 15))).toBe("3限");
    expect(currentPeriodOf(new Date(2026, 10, 24, 15, 0))).toBe("4限");
    expect(currentPeriodOf(new Date(2026, 10, 24, 16, 45))).toBe("5限");
    expect(currentPeriodOf(new Date(2026, 10, 24, 18, 30))).toBe("6限");
    expect(currentPeriodOf(new Date(2026, 10, 24, 20, 0))).toBeNull();
  });

  it("partitionCoursesForTimetable が時間割セルと時間外を分類し表示範囲を決める", () => {
    const basic = partitionCoursesForTimetable([
      course("デザイン史B", { dayOfWeek: "火", period: "2限" }),
      course("表象文化論", { dayOfWeek: "火", period: "2限" }),
      course("国際経済入門"),
      course("集中講義", { dayOfWeek: "集中" }),
    ]);

    expect(basic.visibleDays).toEqual(["月", "火", "水", "木", "金"]);
    expect(basic.visiblePeriods).toEqual(["1限", "2限", "3限", "4限", "5限"]);
    expect(
      basic.scheduled.get(timetableCellKey("火", "2限"))?.map((c) => c.name)
    ).toEqual(["デザイン史B", "表象文化論"]);
    expect(basic.unscheduled.map((c) => c.name)).toEqual([
      "国際経済入門",
      "集中講義",
    ]);

    const extended = partitionCoursesForTimetable([
      course("土曜演習", { dayOfWeek: "土", period: "6限" }),
    ]);
    expect(extended.visibleDays).toEqual(["月", "火", "水", "木", "金", "土"]);
    expect(extended.visiblePeriods).toEqual([
      "1限",
      "2限",
      "3限",
      "4限",
      "5限",
      "6限",
    ]);
  });

  it("coursesForWeekday が曜日別科目を時限順、オンデマンドを別枠で返す", () => {
    const result = coursesForWeekday(
      [
        course("経済学", { dayOfWeek: "火", period: "4限" }),
        course("表象文化論", { dayOfWeek: "火", period: "1限" }),
        course("水曜科目", { dayOfWeek: "水", period: "2限" }),
        course("オンデマンドA"),
        course("集中B", { dayOfWeek: "集中" }),
      ],
      "火"
    );

    expect(result.dayCourses.map((c) => c.name)).toEqual([
      "表象文化論",
      "経済学",
    ]);
    expect(result.ondemandCourses.map((c) => c.name)).toEqual([
      "オンデマンドA",
      "集中B",
    ]);
  });

  it("countUncheckedTasks がコードフェンス外の未完了タスクだけを数える", () => {
    const md = [
      "---",
      "kind: class",
      "---",
      "",
      "- [ ] レポート提出",
      "* [ ] 参考文献を読む",
      "- [x] 出席登録",
      "",
      "```markdown",
      "- [ ] コードブロック内の例",
      "```",
    ].join("\n");
    expect(countUncheckedTasks(md)).toBe(2);
  });

  it("授業テンプレートが空文字で、buildNoteDocument が白紙ノートを生成する", () => {
    expect(buildTemplateBody("class")).toBe("");
    const doc = buildNoteDocument({
      body: buildTemplateBody("class"),
      course: "デザイン史B",
      createdAt: "2026-11-24T10:00:00+09:00",
      grade: "1年",
      kind: "class",
      lectureDate: "2026-11-24",
      pinned: true,
      term: "後期",
      title: "2026-11-24 デザイン史B",
    });
    const scan = scanFrontmatter(doc);
    expect(scan.present).toBe(true);
    expect(scan.closed).toBe(true);
    expect(scan.fields.course).toBe("デザイン史B");
    expect(scan.fields.pinned).toBe("true");
    expect(doc.slice(scan.bodyStartOffset)).toBe("\n");
    expect(doc).not.toContain("# 2026-11-24 デザイン史B");
    expect(doc).not.toContain("## 授業メモ");
  });

  it("classNotePreview がH1や空の見出しを除いた複数行プレビューを返す", () => {
    const body = [
      "# 2026-11-10 表象文化論",
      "",
      "## 授業メモ",
      "一行目のメモです。",
      "二行目のメモです。",
      "",
      "## 要点",
      "",
      "## 課題",
    ].join("\n");
    expect(classNotePreview(body)).toBe(
      "一行目のメモです。\n二行目のメモです。"
    );
    expect(classNotePreview("\n\n")).toBe("");
  });
});
