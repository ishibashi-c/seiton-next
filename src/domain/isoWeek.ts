/**
 * ISO 8601 週番号（月曜始まり、木曜を含む年が週年）。
 * 端末のローカル日付を基準にする。UTC変換で日付だけを扱い、時刻・夏時間の影響を避ける。
 */

export interface IsoWeek {
  week: number;
  year: number;
}

export interface WeekRange {
  /** 日曜 23:59:59.999（ローカル） */
  end: Date;
  /** 月曜 00:00（ローカル） */
  start: Date;
}

const WEEK_ID_PATTERN = /^(\d{4})-W(\d{2})$/;
const DAY_IN_MS = 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** ローカル日付だけを UTC の日付として取り出す。 */
function localDateAsUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
}

/** その日付が属する ISO 週年・週番号。 */
export function isoWeekOf(date: Date): IsoWeek {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("有効な日付ではありません");
  }

  const target = localDateAsUtc(date);
  const dayOfWeek = target.getUTCDay() || 7; // 月=1 .. 日=7
  target.setUTCDate(target.getUTCDate() + 4 - dayOfWeek); // その週の木曜

  const year = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayOfWeek = firstThursday.getUTCDay() || 7;
  const firstMonday = new Date(Date.UTC(year, 0, 4 - (firstDayOfWeek - 1)));

  const week =
    Math.floor((target.getTime() - firstMonday.getTime()) / (7 * DAY_IN_MS)) +
    1;

  return { week, year };
}

/** `2026-W44` の形式にする。 */
export function formatWeekId(year: number, week: number): string {
  return `${String(year).padStart(4, "0")}-W${pad2(week)}`;
}

/** `2026-W44` を解析する。存在しない週（W54 など）は null。 */
export function parseWeekId(value: string): IsoWeek | null {
  const match = WEEK_ID_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(week) ||
    year < 1 ||
    year > 9999
  ) {
    return null;
  }
  if (week < 1 || week > isoWeeksInYear(year)) {
    return null;
  }
  return { week, year };
}

/** 週識別子として妥当か。 */
export function isValidWeekId(value: string): boolean {
  return parseWeekId(value) !== null;
}

/** その ISO 週年に存在する週数（52 または 53）。 */
export function isoWeeksInYear(year: number): number {
  return isoWeekOf(new Date(year, 11, 28)).week;
}

/** ローカル日付から `YYYY-Www` を作る。 */
export function weekIdOf(date: Date): string {
  const { year, week } = isoWeekOf(date);
  return formatWeekId(year, week);
}

/** その日付が属する週の月曜 00:00（ローカル）。 */
export function startOfIsoWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayOfWeek = start.getDay() || 7;
  start.setDate(start.getDate() - (dayOfWeek - 1));
  start.setHours(0, 0, 0, 0);
  return start;
}

/** ローカル日付の加減算。時刻は保持する。 */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/** 指定した週の月曜〜日曜。 */
export function weekRange(weekId: string): WeekRange | null {
  const parsed = parseWeekId(weekId);
  if (!parsed) {
    return null;
  }

  // その週の木曜（ISO週の基準日）を求め、月曜へ戻す。
  const januaryFourth = new Date(parsed.year, 0, 4);
  const januaryFourthDay = januaryFourth.getDay() || 7;
  const week1Monday = addDays(januaryFourth, -(januaryFourthDay - 1));
  const start = addDays(week1Monday, (parsed.week - 1) * 7);
  start.setHours(0, 0, 0, 0);
  const end = addDays(start, 6);
  end.setHours(23, 59, 59, 999);
  return { end, start };
}

/**
 * 現在の週から過去へ count 週分の識別子。重複は除く。
 * 年末年始でも週年が正しく変わる。
 */
export function recentWeekIds(now: Date, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) {
    return [];
  }
  const start = startOfIsoWeek(now);
  const ids: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    const id = weekIdOf(addDays(start, -7 * index));
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

/** 開発・テスト用に日付をまとめて作る。 */
export function localDate(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0
): Date {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}
