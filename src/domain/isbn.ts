/**
 * ISBN（文字列のまま扱う純関数）。Obsidian API に依存しない。
 */

export const ISBN_SEPARATORS = /[\s\u00a0\u3000\-‐‑‒–—―ー−]/gu;

/**
 * ハイフン・空白・全角文字・ISBNラベルを除去する。
 * 数字と末尾のX以外が残る場合は空文字（形式外）を返す。
 * 桁数やチェックディジットの検証は isValidIsbn 系で行う。
 */
export function normalizeIsbn(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  const withoutLabel = normalized.replace(
    /^isbn(?:-?1[03])?(?:\s*[::]?\s*)/iu,
    ""
  );
  const stripped = withoutLabel.replace(ISBN_SEPARATORS, "").toUpperCase();
  if (stripped === "" || !/^\d*X?$/u.test(stripped)) {
    return "";
  }
  return stripped;
}

/** ISBN-10 のチェックディジット。不正な入力を渡した場合は空文字。 */
export function isbn10CheckDigit(first9: string): string {
  if (!/^\d{9}$/u.test(first9)) {
    return "";
  }
  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    sum += (10 - index) * Number(first9[index]);
  }
  const remainder = (11 - (sum % 11)) % 11;
  return remainder === 10 ? "X" : String(remainder);
}

/** ISBN-13 のチェックディジット。不正な入力を渡した場合は空文字。 */
export function isbn13CheckDigit(first12: string): string {
  if (!/^\d{12}$/u.test(first12)) {
    return "";
  }
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(first12[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

/** ハイフン付き・全角・ラベル付きの入力も受け付ける。 */
export function isValidIsbn10(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (!/^\d{9}[\dX]$/u.test(isbn)) {
    return false;
  }
  return isbn10CheckDigit(isbn.slice(0, 9)) === isbn.slice(9);
}

/** 書籍のISBN-13は 978 / 979 で始まるものだけを受理する。 */
export function isValidIsbn13(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (!/^97[89]\d{10}$/u.test(isbn)) {
    return false;
  }
  return isbn13CheckDigit(isbn.slice(0, 12)) === isbn.slice(12);
}

export function isValidIsbn(value: string): boolean {
  return isValidIsbn10(value) || isValidIsbn13(value);
}

/** ISBN-10 を ISBN-13 へ変換する。不正なら空文字。 */
export function isbn10ToIsbn13(value: string): string {
  const isbn = normalizeIsbn(value);
  if (!isValidIsbn10(isbn)) {
    return "";
  }
  const first12 = `978${isbn.slice(0, 9)}`;
  return `${first12}${isbn13CheckDigit(first12)}`;
}

/** 978 始まりの ISBN-13 だけを ISBN-10 へ変換する。979 は変換不可。 */
export function isbn13ToIsbn10(value: string): string {
  const isbn = normalizeIsbn(value);
  if (!(isValidIsbn13(isbn) && isbn.startsWith("978"))) {
    return "";
  }
  const first9 = isbn.slice(3, 12);
  return `${first9}${isbn10CheckDigit(first9)}`;
}

/** 重複判定に使う正規形。ISBN-10 は対応する ISBN-13 に寄せる。 */
export function canonicalIsbn(value: string): string {
  const isbn = normalizeIsbn(value);
  if (isValidIsbn13(isbn)) {
    return isbn;
  }
  if (isValidIsbn10(isbn)) {
    return isbn10ToIsbn13(isbn);
  }
  return "";
}

/** 同じ本を ISBN-10 / ISBN-13 のどちらで登録しても同じキーになる。 */
export function isbnDuplicateKey(value: string): string {
  const canonical = canonicalIsbn(value);
  return canonical === "" ? "" : `isbn:${canonical}`;
}
