import type { AcademicGrade, AcademicTerm } from "../services/settings";
import { buildFrontmatter, scanFrontmatter } from "./frontmatter";
import { normalizeLectureDate } from "./lectureDate";
import { normalizeNewlines } from "./text";

export interface ClassSessionEntry {
  cancelled?: boolean;
  course: string;
  date: string;
  dayOfWeek?: string;
  grade: AcademicGrade;
  note?: string;
  period?: string;
  round: number;
  term: AcademicTerm;
}

const VALID_GRADES = new Set<string>(["1年", "2年", "3年", "4年"]);
const VALID_TERMS = new Set<string>(["前期", "後期", "通年", "集中"]);
const ROUND_PATTERN = /^(?:第\s*)?(\d+)(?:\s*回)?$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function isCancelledNote(note: string): boolean {
  return note === "休" || note.includes("休講");
}

function parseRoundNumber(raw: string): number {
  const match = ROUND_PATTERN.exec(raw.trim());
  if (!match?.[1]) {
    return 0;
  }
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * `Seiton/System/ClassSchedule.md` の Markdown テーブルから開講日一覧を読む。
 */
export function parseClassScheduleMarkdown(text: string): ClassSessionEntry[] {
  const scan = scanFrontmatter(text);
  const body = normalizeNewlines(text.slice(scan.bodyStartOffset));
  const entries: ClassSessionEntry[] = [];

  for (const rawLine of body.split("\n")) {
    const trimmed = rawLine.trim();
    if (!(trimmed.startsWith("|") && trimmed.endsWith("|"))) {
      continue;
    }
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 5) {
      continue;
    }
    const [
      course = "",
      grade = "",
      term = "",
      roundRaw = "",
      dateRaw = "",
      dayOfWeek = "",
      period = "",
      note = "",
    ] = cells;

    if (
      !course ||
      course === "科目名" ||
      course.startsWith("---") ||
      !VALID_GRADES.has(grade) ||
      !VALID_TERMS.has(term)
    ) {
      continue;
    }

    const round = parseRoundNumber(roundRaw);
    const date = normalizeLectureDate(dateRaw);
    if (round <= 0 || !ISO_DATE_PATTERN.test(date)) {
      continue;
    }

    const cancelled = isCancelledNote(note);
    const entry: ClassSessionEntry = {
      course,
      date,
      grade: grade as AcademicGrade,
      round,
      term: term as AcademicTerm,
    };
    if (cancelled) {
      entry.cancelled = true;
    }
    if (dayOfWeek) {
      entry.dayOfWeek = dayOfWeek;
    }
    if (period) {
      entry.period = period;
    }
    if (note) {
      entry.note = note;
    }
    entries.push(entry);
  }

  return entries;
}

function formatNoteCell(entry: ClassSessionEntry): string {
  const raw = (entry.note ?? "").replace(/\|/gu, "｜").trim();
  if (!entry.cancelled) {
    return raw;
  }
  if (!raw) {
    return "休講";
  }
  return isCancelledNote(raw) ? raw : `${raw} 休講`;
}

/**
 * 開講日一覧を `Seiton/System/ClassSchedule.md` 用の Markdown に変換する。
 */
export function serializeClassScheduleMarkdown(
  entries: readonly ClassSessionEntry[]
): string {
  const frontmatter = buildFrontmatter({ kind: "class-schedule" }, "\n");
  const rows = entries.map((entry) => {
    const safeCourse = entry.course.replace(/\|/gu, "｜").trim();
    const safeDay = (entry.dayOfWeek ?? "").replace(/\|/gu, "｜").trim();
    const safePeriod = (entry.period ?? "").replace(/\|/gu, "｜").trim();
    const safeNote = formatNoteCell(entry);
    return `| ${safeCourse} | ${entry.grade} | ${entry.term} | ${entry.round} | ${entry.date} | ${safeDay} | ${safePeriod} | ${safeNote} |`;
  });

  const body = [
    "# 授業開講日カレンダー",
    "",
    "| 科目名 | 学年 | 学期 | 回 | 日付 | 曜日 | 時限 | 備考 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");

  return `${frontmatter}\n${body}`;
}

export function listCourseSessions(
  entries: readonly ClassSessionEntry[],
  course: string,
  term?: AcademicTerm
): ClassSessionEntry[] {
  const target = course.trim();
  if (!target) {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.course.trim() === target &&
        (term === undefined || entry.term === term)
    )
    .sort(
      (left, right) =>
        left.round - right.round || left.date.localeCompare(right.date)
    );
}

export function findSessionForDate(
  entries: readonly ClassSessionEntry[],
  course: string,
  date: string,
  term?: AcademicTerm
): ClassSessionEntry | null {
  const normalizedDate = normalizeLectureDate(date);
  if (!normalizedDate) {
    return null;
  }
  const matches = listCourseSessions(entries, course, term).filter(
    (entry) => entry.date === normalizedDate
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.find((entry) => !entry.cancelled) ?? matches[0] ?? null;
}

export function findSessionForRound(
  entries: readonly ClassSessionEntry[],
  course: string,
  round: number,
  term?: AcademicTerm
): ClassSessionEntry | null {
  if (!Number.isInteger(round) || round <= 0) {
    return null;
  }
  const matches = listCourseSessions(entries, course, term).filter(
    (entry) => entry.round === round
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.find((entry) => !entry.cancelled) ?? matches[0] ?? null;
}

export function resolveSuggestedSession(
  entries: readonly ClassSessionEntry[],
  course: string,
  today: string,
  term?: AcademicTerm
): ClassSessionEntry | null {
  const active = listCourseSessions(entries, course, term).filter(
    (entry) => !entry.cancelled
  );
  if (active.length === 0) {
    return null;
  }

  const normalizedToday = normalizeLectureDate(today);
  if (!normalizedToday) {
    return active[0] ?? null;
  }

  const exact = active.find((entry) => entry.date === normalizedToday);
  if (exact) {
    return exact;
  }

  const onOrBefore = active
    .filter((entry) => entry.date <= normalizedToday)
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) || right.round - left.round
    );
  if (onOrBefore[0]) {
    return onOrBefore[0];
  }

  const upcoming = [...active].sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.round - right.round
  );
  return upcoming[0] ?? null;
}
