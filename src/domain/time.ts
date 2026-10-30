/**
 * 記録日時は「記録した端末のローカル時刻 + オフセット」で保存する。
 * 表示時もオフセット付き文字列の日付・時刻部分を使い、別端末のタイムゾーンで
 * 日付がずれないようにする。
 */

const AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-10-26T09:32:00+09:00` 形式。ミリ秒は含めない。 */
export function formatLocalIso(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("有効な日付ではありません");
  }

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;

  return [
    `${String(date.getFullYear()).padStart(4, "0")}-${pad2(
      date.getMonth() + 1
    )}-${pad2(date.getDate())}`,
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
      date.getSeconds()
    )}`,
    `${sign}${pad2(offsetHours)}:${pad2(offsetRemainder)}`,
  ].join("");
}

/** 形と実在日付の両方を検証する。 */
export function isValidAt(value: string): boolean {
  const match = AT_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/** 記録日 `YYYY-MM-DD`。不正なら空文字。 */
export function dateKeyOf(at: string): string {
  return isValidAt(at) ? at.slice(0, 10) : "";
}

/** 記録時刻 `HH:mm`。不正なら空文字。 */
export function clockOf(at: string): string {
  return isValidAt(at) ? at.slice(11, 16) : "";
}

/** 日付キーが実在するか。 */
export function isValidDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/** 日付キーをローカルの正午 Date にする（表示用。時刻ずれを避ける）。 */
export function dateKeyToLocalDate(value: string): Date | null {
  if (!isValidDateKey(value)) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}
