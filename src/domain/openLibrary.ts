/**
 * Open Library API のURL生成とレスポンス変換。Obsidian API に依存しない純関数。
 */

import type { BookCandidate } from "./book";
import { AUTHOR_SEPARATOR } from "./book";

export const OPEN_LIBRARY_BASE = "https://openlibrary.org";
export const OPEN_LIBRARY_COVER_BASE = "https://covers.openlibrary.org";

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

function textListField(value: unknown, key: string): string[] {
  return asList(fieldOf(value, key))
    .map((item) => textOf(item))
    .filter((item) => item !== "");
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

/** Open Library の edition JSON に含まれる著者キー（名前が無いものだけ）。 */
export function openLibraryAuthorKeys(payload: unknown): string[] {
  const authors = asArray(fieldOf(payload, "authors"));
  const keys: string[] = [];
  for (const entry of authors) {
    if (textField(entry, "name") !== "") {
      continue;
    }
    const key = textField(entry, "key");
    if (/^\/authors\/[A-Za-z0-9]+$/u.test(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/** 著者ページのURL。想定外のキーは空文字（任意URLを組み立てない）。 */
export function openLibraryAuthorUrl(key: string): string {
  return /^\/authors\/[A-Za-z0-9]+$/u.test(key)
    ? `${OPEN_LIBRARY_BASE}${key}.json`
    : "";
}

export function openLibraryEditionUrl(isbnValue: string): string {
  return `${OPEN_LIBRARY_BASE}/isbn/${encodeURIComponent(
    normalizeIsbn(isbnValue)
  )}.json`;
}

/**
 * openBDで見つからない場合の表紙URL。
 * coverId があればID指定、無ければISBN指定でOpen Libraryに問い合わせる。
 */
export function openLibraryCoverUrl(
  isbnValue: string,
  coverId?: number | null
): string {
  if (coverId !== undefined && coverId !== null && coverId > 0) {
    return `${OPEN_LIBRARY_COVER_BASE}/b/id/${coverId}-L.jpg`;
  }
  const isbn = canonicalIsbn(isbnValue) || normalizeIsbn(isbnValue);
  return isbn === ""
    ? ""
    : `${OPEN_LIBRARY_COVER_BASE}/b/isbn/${encodeURIComponent(isbn)}-L.jpg`;
}

function openLibraryCoverId(payload: unknown): number | null {
  for (const cover of asArray(fieldOf(payload, "covers"))) {
    if (typeof cover === "number" && cover > 0) {
      return cover;
    }
  }
  return null;
}

/**
 * Open Library `/isbn/{isbn}.json` のレスポンスを書籍候補へ変換する。
 * 著者名はAPIに含まれないため、呼び出し側が解決した `authorNames` を渡す。
 */
export function bookCandidateFromOpenLibrary(
  payload: unknown,
  fallbackIsbn = "",
  authorNames: Record<string, string> = {}
): BookCandidate | null {
  const record = asObject(payload);
  if (!record) {
    return null;
  }
  const title = textField(record, "title");
  if (title === "") {
    return null;
  }

  const authors: string[] = [];
  for (const entry of asArray(record.authors)) {
    const name = textField(entry, "name");
    if (name !== "") {
      authors.push(name);
      continue;
    }
    const key = textField(entry, "key");
    const resolved = authorNames[key];
    if (resolved !== undefined && resolved.trim() !== "") {
      authors.push(resolved.trim());
    }
  }

  const isbnCandidates = [
    ...textListField(record, "isbn_13"),
    ...textListField(record, "isbn_10"),
    fallbackIsbn,
  ];
  const isbn =
    isbnCandidates
      .map((candidate) => isbnFromCandidate(candidate, fallbackIsbn))
      .find((candidate) => candidate !== "") ?? "";

  const subtitle = textField(record, "subtitle");
  const fullTitle = subtitle === "" ? title : `${title}: ${subtitle}`;

  return {
    authors,
    category: "",
    coverUrl: openLibraryCoverUrl(isbn, openLibraryCoverId(record)),
    isbn,
    published: textField(record, "publish_date"),
    publisher: textListField(record, "publishers").join(AUTHOR_SEPARATOR),
    series: textListField(record, "series").join(AUTHOR_SEPARATOR),
    source: "openlibrary",
    title: fullTitle,
    volume: "",
  };
}
