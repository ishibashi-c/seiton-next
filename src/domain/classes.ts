import type { CourseRegistration } from "../services/settings";
import { normalizeNewlines } from "./text";

export const CLASS_WEEKDAYS = ["月", "火", "水", "木", "金", "土"] as const;
export const CLASS_PERIODS = [
  "1限",
  "2限",
  "3限",
  "4限",
  "5限",
  "6限",
  "7限",
] as const;

export type ClassWeekday = (typeof CLASS_WEEKDAYS)[number];
export type ClassPeriod = (typeof CLASS_PERIODS)[number];

const ALL_WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const PERIOD_WINDOWS: ReadonlyArray<{
  endMinutes: number;
  period: ClassPeriod;
  startMinutes: number;
}> = [
  { endMinutes: 10 * 60 + 30, period: "1限", startMinutes: 9 * 60 },
  { endMinutes: 12 * 60 + 10, period: "2限", startMinutes: 10 * 60 + 40 },
  { endMinutes: 14 * 60 + 30, period: "3限", startMinutes: 13 * 60 },
  { endMinutes: 16 * 60 + 10, period: "4限", startMinutes: 14 * 60 + 40 },
  { endMinutes: 17 * 60 + 50, period: "5限", startMinutes: 16 * 60 + 20 },
  { endMinutes: 19 * 60 + 30, period: "6限", startMinutes: 18 * 60 },
];

export interface TimetablePartition {
  scheduled: Map<string, CourseRegistration[]>;
  unscheduled: CourseRegistration[];
  visibleDays: ClassWeekday[];
  visiblePeriods: ClassPeriod[];
}

export interface WeekdayCoursePartition {
  dayCourses: CourseRegistration[];
  ondemandCourses: CourseRegistration[];
}

export function timetableCellKey(dayOfWeek: string, period: string): string {
  return `${dayOfWeek}:${period}`;
}

export function weekdayLabelOf(date: Date): string {
  return ALL_WEEKDAY_LABELS[date.getDay()] ?? "日";
}

export function currentPeriodOf(date: Date): string | null {
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const window of PERIOD_WINDOWS) {
    if (minutes >= window.startMinutes && minutes <= window.endMinutes) {
      return window.period;
    }
  }
  return null;
}

function periodSortRank(period: string | undefined): number {
  if (!period) {
    return CLASS_PERIODS.length;
  }
  const index = CLASS_PERIODS.indexOf(period as ClassPeriod);
  return index >= 0 ? index : CLASS_PERIODS.length;
}

export function partitionCoursesForTimetable(
  courses: readonly CourseRegistration[]
): TimetablePartition {
  const scheduled = new Map<string, CourseRegistration[]>();
  const unscheduled: CourseRegistration[] = [];
  let hasSaturday = false;
  let maxPeriodIndex = 4; // 最低 5限 まで表示

  for (const course of courses) {
    const day = course.dayOfWeek?.trim() ?? "";
    const period = course.period?.trim() ?? "";
    const isValidDay = (CLASS_WEEKDAYS as readonly string[]).includes(day);
    const periodIndex = CLASS_PERIODS.indexOf(period as ClassPeriod);
    if (isValidDay && periodIndex >= 0) {
      const key = timetableCellKey(day, period);
      const list = scheduled.get(key) ?? [];
      list.push(course);
      scheduled.set(key, list);
      if (day === "土") {
        hasSaturday = true;
      }
      if (periodIndex > maxPeriodIndex) {
        maxPeriodIndex = periodIndex;
      }
    } else {
      unscheduled.push(course);
    }
  }

  for (const list of scheduled.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }
  unscheduled.sort((a, b) => a.name.localeCompare(b.name, "ja"));

  const visibleDays: ClassWeekday[] = hasSaturday
    ? [...CLASS_WEEKDAYS]
    : ["月", "火", "水", "木", "金"];
  const visiblePeriods = CLASS_PERIODS.slice(0, maxPeriodIndex + 1);

  return {
    scheduled,
    unscheduled,
    visibleDays,
    visiblePeriods,
  };
}

export function coursesForWeekday(
  courses: readonly CourseRegistration[],
  weekday: string
): WeekdayCoursePartition {
  const dayCourses: CourseRegistration[] = [];
  const ondemandCourses: CourseRegistration[] = [];

  for (const course of courses) {
    const day = course.dayOfWeek?.trim() ?? "";
    if (day === weekday) {
      dayCourses.push(course);
    } else if (!day || !(CLASS_WEEKDAYS as readonly string[]).includes(day)) {
      ondemandCourses.push(course);
    }
  }

  dayCourses.sort((a, b) => {
    const diff = periodSortRank(a.period) - periodSortRank(b.period);
    return diff === 0 ? a.name.localeCompare(b.name, "ja") : diff;
  });
  ondemandCourses.sort((a, b) => a.name.localeCompare(b.name, "ja"));

  return { dayCourses, ondemandCourses };
}

export function countUncheckedTasks(markdown: string): number {
  const lines = normalizeNewlines(markdown).split("\n");
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/u.exec(trimmed);
    if (fenceMatch?.[1]) {
      const ch = fenceMatch[1][0] ?? "`";
      const len = fenceMatch[1].length;
      if (fenceChar === null) {
        fenceChar = ch;
        fenceLen = len;
        continue;
      }
      if (ch === fenceChar && len >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
        continue;
      }
    }
    if (fenceChar !== null) {
      continue;
    }
    if (/^\s*[-*]\s*\[ \](?:\s|$)/u.test(line)) {
      count += 1;
    }
  }

  return count;
}

export function classNotePreview(markdown: string, maxChars = 240): string {
  const withoutComments = normalizeNewlines(markdown).replace(
    /<!--[\s\S]*?-->/gu,
    ""
  );
  const keptLines: string[] = [];
  for (const rawLine of withoutComments.split("\n")) {
    const trimmed = rawLine.trim();
    if (/^#[ \t]+/u.test(trimmed)) {
      continue;
    }
    if (/^##[ \t]*(?:授業メモ|要点|課題)[ \t]*$/u.test(trimmed)) {
      continue;
    }
    if (trimmed === "") {
      if (keptLines.length > 0 && keptLines.at(-1) !== "") {
        keptLines.push("");
      }
      continue;
    }
    keptLines.push(trimmed.replace(/^#{1,6}[ \t]+/u, ""));
  }
  while (keptLines.at(-1) === "") {
    keptLines.pop();
  }
  const joined = keptLines.join("\n").trim();
  if (joined.length <= maxChars) {
    return joined;
  }
  return `${joined.slice(0, maxChars).trimEnd()}…`;
}
