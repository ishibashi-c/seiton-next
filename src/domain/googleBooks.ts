const GOOGLE_BOOKS_API = "https://www.googleapis.com/books/v1/volumes";

/** 表紙だけを取るときのフィールド。レスポンスを小さく保つ。 */
const COVER_FIELDS = "items(volumeInfo(industryIdentifiers,imageLinks))";

/** 書誌も取るときのフィールド。 */
export const BOOK_FIELDS =
  "items(volumeInfo(title,authors,publisher,publishedDate,industryIdentifiers,imageLinks))";

/** Google Booksの検索URL。 */
export function googleBooksSearchUrl(
  query: string,
  apiKey: string,
  country = "JP",
  maxResults = 10,
  fields = COVER_FIELDS
): string {
  const params = new URLSearchParams({
    country,
    fields,
    key: apiKey.trim(),
    maxResults: String(maxResults),
    q: query,
  });
  return `${GOOGLE_BOOKS_API}?${params.toString()}`;
}

function imageLink(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const raw = value.trim().startsWith("//")
    ? `https:${value.trim()}`
    : value.trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.protocol = "https:";
    return url.toString();
  } catch {
    return null;
  }
}

function isbnDigits(value: string): string {
  return value.replace(/[^0-9Xx]/gu, "").toUpperCase();
}

function itemMatchesIsbn(item: unknown, isbn: string): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const volumeInfo = (item as { volumeInfo?: unknown }).volumeInfo;
  if (!volumeInfo || typeof volumeInfo !== "object") {
    return false;
  }
  const identifiers = (volumeInfo as { industryIdentifiers?: unknown })
    .industryIdentifiers;
  if (!Array.isArray(identifiers)) {
    return false;
  }
  const expected = isbnDigits(isbn);
  return identifiers.some((identifier) => {
    if (!identifier || typeof identifier !== "object") {
      return false;
    }
    const value = (identifier as { identifier?: unknown }).identifier;
    return typeof value === "string" && isbnDigits(value) === expected;
  });
}

/** 検索結果からISBNに一致する表紙URLを選ぶ。 */
export function googleBooksCoverUrl(
  payload: unknown,
  isbn?: string
): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  for (const item of items) {
    if (isbn && !itemMatchesIsbn(item, isbn)) {
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const volumeInfo = (item as { volumeInfo?: unknown }).volumeInfo;
    if (!volumeInfo || typeof volumeInfo !== "object") {
      continue;
    }
    const links = (volumeInfo as { imageLinks?: unknown }).imageLinks;
    if (!links || typeof links !== "object") {
      continue;
    }
    const record = links as Record<string, unknown>;
    const url =
      imageLink(record.extraLarge) ??
      imageLink(record.large) ??
      imageLink(record.medium) ??
      imageLink(record.thumbnail) ??
      imageLink(record.smallThumbnail);
    if (url) {
      return url;
    }
  }
  return null;
}

export interface GoogleBookCandidate {
  authors: string[];
  coverUrl: string;
  published: string;
  publisher: string;
  title: string;
}

/**
 * 検索結果から、ISBNが一致する最初の1件を書誌として取り出す。
 * 一致するものが無ければ null（ISBNが違う本を登録しないため）。
 */
export function googleBooksCandidate(
  payload: unknown,
  isbn: string
): GoogleBookCandidate | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  for (const item of items) {
    if (!itemMatchesIsbn(item, isbn)) {
      continue;
    }
    const volumeInfo = (item as { volumeInfo?: unknown }).volumeInfo;
    if (!volumeInfo || typeof volumeInfo !== "object") {
      continue;
    }
    const info = volumeInfo as Record<string, unknown>;
    const title = typeof info.title === "string" ? info.title.trim() : "";
    if (title === "") {
      continue;
    }
    const authors = Array.isArray(info.authors)
      ? info.authors
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value !== "")
      : [];
    const links = info.imageLinks;
    const coverUrl =
      links && typeof links === "object"
        ? (imageLink((links as Record<string, unknown>).large) ??
          imageLink((links as Record<string, unknown>).medium) ??
          imageLink((links as Record<string, unknown>).thumbnail) ??
          "")
        : "";
    return {
      authors,
      coverUrl,
      published:
        typeof info.publishedDate === "string" ? info.publishedDate.trim() : "",
      publisher:
        typeof info.publisher === "string" ? info.publisher.trim() : "",
      title,
    };
  }
  return null;
}
