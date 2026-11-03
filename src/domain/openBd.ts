/**
 * openBD API のURL生成とレスポンス変換。Obsidian API に依存しない純関数。
 */

import type { BookCandidate } from "./book";

export const OPEN_BD_BASE = "https://api.openbd.jp/v1/get";

import { canonicalIsbn, isValidIsbn, normalizeIsbn } from "./isbn";

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}

function fieldOf(value: unknown, key: string): unknown {
  return asObject(value)?.[key];
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function textField(value: unknown, key: string): string {
  return textOf(fieldOf(value, key));
}

/** openBDの `summary.author` は空白区切り。ONIXのContributorがあればそちらを優先する。 */
function openBdAuthors(
  record: Record<string, unknown>,
  summary: Record<string, unknown>
): string[] {
  const contributors = asList(
    fieldOf(fieldOf(record.onix, "DescriptiveDetail"), "Contributor")
  );
  const names = contributors
    .map((entry) => textField(fieldOf(entry, "PersonName"), "content"))
    .filter((name) => name !== "");
  if (names.length > 0) {
    return names;
  }
  return textField(summary, "author")
    .split(/[\s\u3000]+/u)
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** openBDのONIXにSubjectがあればカテゴリの手がかりにする（無いことが多い）。 */
function openBdCategory(record: Record<string, unknown>): string {
  const subjects = asList(
    fieldOf(fieldOf(record.onix, "DescriptiveDetail"), "Subject")
  );
  for (const subject of subjects) {
    const heading = textField(subject, "SubjectHeadingText");
    if (heading !== "") {
      return heading;
    }
    const code = textField(subject, "SubjectCode");
    if (code !== "") {
      return code;
    }
  }
  return "";
}

function isbnFromCandidate(raw: string, fallback: string): string {
  const canonical = canonicalIsbn(raw);
  if (canonical !== "") {
    return canonical;
  }
  const normalized = normalizeIsbn(raw);
  if (isValidIsbn(normalized)) {
    return normalized;
  }
  return canonicalIsbn(fallback) || normalizeIsbn(fallback);
}

export function openBdLookupUrl(isbnValue: string): string {
  return `${OPEN_BD_BASE}?isbn=${encodeURIComponent(normalizeIsbn(isbnValue))}`;
}

/**
 * openBD `/v1/get` のレスポンスから最初の有効な書籍候補を作る。
 * 未登録ISBNでは `[null]` が返るため null を返す。
 */
export function bookCandidateFromOpenBd(
  payload: unknown,
  fallbackIsbn = ""
): BookCandidate | null {
  for (const entry of asArray(payload)) {
    const record = asObject(entry);
    const summary = asObject(fieldOf(record, "summary"));
    if (!(record && summary)) {
      continue;
    }
    const title = textField(summary, "title");
    if (title === "") {
      continue;
    }
    return {
      authors: openBdAuthors(record, summary),
      category: openBdCategory(record),
      coverUrl: textField(summary, "cover"),
      isbn: isbnFromCandidate(textField(summary, "isbn"), fallbackIsbn),
      published: textField(summary, "pubdate"),
      publisher: textField(summary, "publisher"),
      series: textField(summary, "series"),
      source: "openbd",
      title,
      volume: textField(summary, "volume"),
    };
  }
  return null;
}
