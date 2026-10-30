import { canonicalIsbn, isValidIsbn, normalizeIsbn } from "./book";

export interface IsbnParseResult {
  duplicates: string[];
  invalid: string[];
  valid: string[];
}

/**
 * 複数行・カンマ区切りのISBNを正規化し、重複を除いて返す。
 * 無効な値は元の文字列のまま invalid に残し、呼び出し側が表示できるようにする。
 */
export function parseIsbnList(text: string): IsbnParseResult {
  const valid: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/[\s,;、]+/u)) {
    const value = raw.trim();
    if (value === "") {
      continue;
    }
    const isbn = canonicalIsbn(value) || normalizeIsbn(value);
    if (!isValidIsbn(isbn)) {
      invalid.push(value);
      continue;
    }
    if (seen.has(isbn)) {
      duplicates.push(isbn);
      continue;
    }
    seen.add(isbn);
    valid.push(isbn);
  }

  return { duplicates, invalid, valid };
}
