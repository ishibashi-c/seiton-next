const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})/u;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})/u;
const MONTH_DAY = /^(\d{2})(\d{2})_/u;

/** 既存の授業ノート名から講義日を読む。読めなければ空文字。 */
export function lectureDateFromBasename(
  basename: string,
  fallbackYear = new Date().getFullYear()
): string {
  let match = FULL_DATE.exec(basename);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  match = COMPACT_DATE.exec(basename);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  match = MONTH_DAY.exec(basename);
  if (match) {
    return `${fallbackYear}-${match[1]}-${match[2]}`;
  }
  return "";
}

/** frontmatterのlecture_dateをYYYY-MM-DDへ正規化する。 */
export function normalizeLectureDate(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (FULL_DATE.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return [
    String(parsed.getFullYear()).padStart(4, "0"),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0"),
  ].join("-");
}
