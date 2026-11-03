/**
 * 本棚（BOOK）の純関数。Obsidian API に依存しない。
 *
 * ISBNは数値としてパースせず、先頭ゼロを保った文字列として扱う。
 * 外部API（openBD / Open Library / カーリル）のレスポンスは `unknown` のまま受け取り、
 * ここで必要な項目だけを緩く読み取る。ネットワーク呼び出しは行わない。
 */

import { ASSETS_FOLDER, NOTES_FOLDER } from "../config";
import { buildFrontmatter, scanFrontmatter, yamlQuoted } from "./frontmatter";
import { isbnDuplicateKey, isValidIsbn, normalizeIsbn } from "./isbn";
import { detectEol, normalizeNewlines } from "./text";
import { isValidDateKey } from "./time";

export const BOOK_KIND = "book";

/** Vault 内の表紙画像の保存先（Assets配下）。 */
export const BOOK_COVERS_FOLDER = `${ASSETS_FOLDER}/Covers`;

/** 表紙として保存する画像の上限。 */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

/** 読書状態の正本となる値。 */
export const READING_STATUSES = ["tbr", "reading", "read"] as const;

export type ReadingStatus = (typeof READING_STATUSES)[number];

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  read: "読了",
  reading: "読書中",
  tbr: "積読",
};

/** 所有状態は自由記述だが、UIの選択肢としてこの値を使う。 */
export const BOOK_OWNERSHIPS = ["owned", "borrowed", "wishlist"] as const;

export type BookOwnership = (typeof BOOK_OWNERSHIPS)[number];

export const BOOK_OWNERSHIP_LABELS: Record<BookOwnership, string> = {
  borrowed: "借用",
  owned: "所有",
  wishlist: "欲しい",
};

/** 書籍ノートで使うProperties。既存のcamelCaseも読み取り時は許容する。 */
export const BOOK_PROPERTY_KEYS = [
  "book_isbn",
  "book_author",
  "book_publisher",
  "book_published",
  "book_category",
  "book_series",
  "book_cover",
  "reading_status",
  "book_ownership",
  "book_finished",
  "book_rating",
] as const;

/** 複数著者の区切り。frontmatterでは1つのテキストとして保存する。 */
export const AUTHOR_SEPARATOR = " / ";

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export type BookErrorCode =
  | "INVALID_ISBN"
  | "INVALID_TITLE"
  | "INVALID_READING_STATUS"
  | "INVALID_RATING"
  | "INVALID_DATE"
  | "BOOK_DUPLICATE"
  | "BOOK_FORMAT"
  | "BOOK_IO"
  | "CALIL_KEY_MISSING"
  | "CALIL_LIBRARY_MISSING";

/** UIがそのまま表示できる書籍エラー。 */
export class BookError extends Error {
  readonly code: BookErrorCode;
  readonly detail: string | undefined;

  constructor(
    code: BookErrorCode,
    message: string,
    detail?: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BookError";
    this.code = code;
    this.detail = detail;
  }
}

export function isBookError(error: unknown): error is BookError {
  return error instanceof BookError;
}

// ---------------------------------------------------------------------------
// 読書状態・評価・所有
// ---------------------------------------------------------------------------

export function isReadingStatus(value: string): value is ReadingStatus {
  return (READING_STATUSES as readonly string[]).includes(value);
}

const READING_STATUS_ALIASES: Record<string, ReadingStatus> = {
  read: "read",
  reading: "reading",
  tbr: "tbr",
  tsundoku: "tbr",
  unread: "tbr",
  よみたい: "tbr",
  完読: "read",
  未読: "tbr",
  積読: "tbr",
  読了: "read",
  読書中: "reading",
};

/** 表記ゆれ（旧データ・日本語ラベル）を吸収する。不明なら null。 */
export function parseReadingStatus(value: unknown): ReadingStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const key = value.normalize("NFKC").trim().toLowerCase();
  if (key === "") {
    return null;
  }
  if (isReadingStatus(key)) {
    return key;
  }
  return READING_STATUS_ALIASES[key] ?? null;
}

/** 書き込み前の検証。不正なら BookError。 */
export function assertReadingStatus(value: unknown): ReadingStatus {
  const status = parseReadingStatus(value);
  if (status === null) {
    throw new BookError(
      "INVALID_READING_STATUS",
      "読書状態は tbr・reading・read のいずれかを指定してください",
      typeof value === "string" ? value : undefined
    );
  }
  return status;
}

/** 1〜5 の整数だけを評価として扱う。0 や空は「未評価」。 */
export function parseBookRating(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  }
  if (typeof value === "string" && /^[1-5]$/u.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

export function isBookOwnership(value: string): value is BookOwnership {
  return (BOOK_OWNERSHIPS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 書籍候補（外部APIのレスポンス変換）
// ---------------------------------------------------------------------------

export type BookLookupSource = "googlebooks" | "openbd" | "openlibrary";

export interface BookCandidate {
  authors: string[];
  category: string;
  coverUrl: string;
  isbn: string;
  published: string;
  publisher: string;
  series: string;
  source: BookLookupSource;
  title: string;
  volume: string;
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

/** frontmatterの著者（配列・区切り文字列）を配列へ戻す。 */
export function parseAuthors(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseAuthors(item));
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .normalize("NFKC")
    .split(/\s+\/\s+|／/u)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

// ---------------------------------------------------------------------------
// ISBNから重複判定キーを作る
// ---------------------------------------------------------------------------

export interface BookDuplicateKeyInput {
  authors?: string | string[] | null;
  isbn?: string | null;
  title?: string | null;
}

function duplicateText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * ISBNが正しければISBNで、無ければタイトル＋著者で重複キーを作る。
 * 同じ本はISBN-10 / ISBN-13 のどちらで登録しても一致する。
 */
export function bookDuplicateKey(input: BookDuplicateKeyInput): string {
  const isbnKey = isbnDuplicateKey(input.isbn ?? "");
  if (isbnKey !== "") {
    return isbnKey;
  }
  const title = duplicateText(input.title ?? "");
  if (title === "") {
    return "";
  }
  const author = duplicateText(parseAuthors(input.authors)[0] ?? "");
  return author === "" ? `title:${title}` : `title:${title}|${author}`;
}

// ---------------------------------------------------------------------------
// frontmatter・ファイル名・パス
// ---------------------------------------------------------------------------

export interface BookDraft {
  authors?: string | string[] | null;
  category?: string | null;
  cover?: string | null;
  created?: string | null;
  finished?: string | null;
  isbn?: string | null;
  ownership?: string | null;
  published?: string | null;
  publisher?: string | null;
  rating?: number | string | null;
  readingStatus?: string | null;
  series?: string | null;
  title: string;
}

export interface BookDocumentInput extends BookDraft {
  body?: string | null;
  eol?: string;
}

function optionalText(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : value.trim();
}

/**
 * 書籍ノートのfrontmatter値（YAMLへそのまま入る形）を作る。
 * `book_isbn` は先頭ゼロを失わないよう必ず引用する。
 */
export function buildBookFrontmatterFields(
  draft: BookDraft
): Record<string, string> {
  const title = optionalText(draft.title).replace(/\s+/gu, " ");
  if (title === "") {
    throw new BookError("INVALID_TITLE", "タイトルを入力してください");
  }

  const fields: Record<string, string> = {};
  fields.kind = BOOK_KIND;
  fields.title = yamlQuoted(title);

  const created = optionalText(draft.created);
  if (created !== "") {
    fields.created = yamlQuoted(created);
  }

  const rawIsbn = optionalText(draft.isbn);
  if (rawIsbn !== "") {
    const isbn = normalizeIsbn(rawIsbn);
    if (!isValidIsbn(isbn)) {
      throw new BookError(
        "INVALID_ISBN",
        "ISBNの形式が正しくありません。チェックディジットを確認してください。",
        rawIsbn
      );
    }
    fields.book_isbn = yamlQuoted(isbn);
  }

  const authors = parseAuthors(draft.authors);
  if (authors.length > 0) {
    fields.book_author = yamlQuoted(authors.join(AUTHOR_SEPARATOR));
  }

  const publisher = optionalText(draft.publisher);
  if (publisher !== "") {
    fields.book_publisher = yamlQuoted(publisher);
  }

  const published = optionalText(draft.published);
  if (published !== "") {
    fields.book_published = yamlQuoted(published);
  }

  const category = optionalText(draft.category);
  if (category !== "") {
    fields.book_category = yamlQuoted(category);
  }

  const series = optionalText(draft.series);
  if (series !== "") {
    fields.book_series = yamlQuoted(series);
  }

  const cover = optionalText(draft.cover);
  if (cover !== "") {
    fields.book_cover = yamlQuoted(cover);
  }

  const rawStatus = optionalText(draft.readingStatus);
  if (rawStatus !== "") {
    fields.reading_status = assertReadingStatus(rawStatus);
  }

  const ownership = optionalText(draft.ownership);
  if (ownership !== "") {
    fields.book_ownership = isBookOwnership(ownership)
      ? ownership
      : yamlQuoted(ownership);
  }

  const finished = optionalText(draft.finished);
  if (finished !== "") {
    if (!isValidDateKey(finished)) {
      throw new BookError(
        "INVALID_DATE",
        "読了日は YYYY-MM-DD 形式の実在する日付で入力してください。",
        finished
      );
    }
    fields.book_finished = yamlQuoted(finished);
  }

  const rawRating = draft.rating;
  if (rawRating !== null && rawRating !== undefined) {
    const ratingText = String(rawRating).trim();
    if (ratingText !== "" && ratingText !== "0") {
      const rating = parseBookRating(ratingText);
      if (rating === null) {
        throw new BookError(
          "INVALID_RATING",
          "評価は1〜5の整数で指定してください。",
          ratingText
        );
      }
      fields.book_rating = String(rating);
    }
  }

  return fields;
}

/** 本文の前後の空行だけを落とす。行頭のインデントは本文として保持する。 */
export function trimBookBody(value: string): string {
  return normalizeNewlines(value).replace(/^\n+/u, "").replace(/\s+$/u, "");
}

/** frontmatter＋本文。本文が空でもファイルとして成立させる。 */
export function buildBookDocument(input: BookDocumentInput): string {
  const eol = input.eol ?? "\n";
  const frontmatter = buildFrontmatter(buildBookFrontmatterFields(input), eol);
  const body = trimBookBody(input.body ?? "");
  const cover = (input.cover ?? "").trim();
  // 表紙はノートを開いたときに見えるよう、本文の先頭に1行だけ置く。
  const coverLine = cover === "" ? "" : `![[${cover}|240]]`;
  const combined = [coverLine, body]
    .filter((part) => part !== "")
    .join(eol + eol);
  if (combined === "") {
    return `${frontmatter}${eol}`;
  }
  const bodyWithEol = eol === "\n" ? combined : combined.replace(/\n/gu, eol);
  return `${frontmatter}${eol}${bodyWithEol}${eol}`;
}

/**
 * 既存の書籍ノートの本文だけを置き換える。frontmatter・未知のキーは保持する。
 * frontmatterが閉じていない場合は破壊を避けて例外にする。
 */
export function replaceBookBody(document: string, body: string): string {
  const scan = scanFrontmatter(document);
  if (!(scan.present && scan.closed)) {
    throw new BookError(
      "BOOK_FORMAT",
      "frontmatterが閉じていないため本文を更新できません。"
    );
  }
  const eol = detectEol(document);
  const head = document.slice(0, scan.bodyStartOffset);
  const normalizedBody = trimBookBody(body);
  if (normalizedBody === "") {
    return head;
  }
  const bodyWithEol =
    eol === "\n" ? normalizedBody : normalizedBody.replace(/\n/gu, eol);
  return `${head}${eol}${bodyWithEol}${eol}`;
}

function truncateCodePoints(value: string, length: number): string {
  return Array.from(value).slice(0, length).join("");
}

/** タイトルから安全なファイル名（拡張子なし）を作る。 */
export function bookFileName(title: string): string {
  const base = normalizeNewlines(title)
    .replace(/[\\/:*?"<>|#^[\]]/gu, "-")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, "");

  const truncated = truncateCodePoints(base, 80)
    .trim()
    .replace(/[.\s]+$/u, "");

  if (truncated === "") {
    return "無題の本";
  }
  if (WINDOWS_RESERVED.test(truncated)) {
    return `_${truncated}`;
  }
  return truncated;
}

/** `Seiton/Notes/{安全なファイル名}.md` */
export function bookNotePath(
  title: string,
  folder: string = NOTES_FOLDER
): string {
  const base = folder.replace(/[\\/]+$/u, "");
  return `${base}/${bookFileName(title)}.md`;
}

/** `Seiton/System/Assets/Covers/{正規化ISBN}.jpg`。ISBNが不正なら空文字。 */
export function bookCoverPath(
  isbnValue: string,
  coversFolder: string = BOOK_COVERS_FOLDER
): string {
  const isbn = normalizeIsbn(isbnValue);
  if (!isValidIsbn(isbn)) {
    return "";
  }
  return `${coversFolder.replace(/[\\/]+$/u, "")}/${isbn}.jpg`;
}

// ---------------------------------------------------------------------------
// 読み取り（frontmatter → 表示用の書誌）
// ---------------------------------------------------------------------------

export interface BookInfo {
  author: string;
  authors: string[];
  category: string;
  cover: string;
  finished: string;
  isbn: string;
  ownership: string;
  published: string;
  publisher: string;
  rating: number | null;
  readingStatus: ReadingStatus | "";
  series: string;
}

function firstValue(
  frontmatter: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (!Object.hasOwn(frontmatter, key)) {
      continue;
    }
    const value = frontmatter[key];
    if (value === null || value === undefined || value === "") {
      continue;
    }
    return value;
  }
  return undefined;
}

function firstText(
  frontmatter: Record<string, unknown>,
  keys: readonly string[]
): string {
  const value = firstValue(frontmatter, keys);
  if (Array.isArray(value)) {
    return value
      .map((item) => textOf(item))
      .filter(Boolean)
      .join(" / ");
  }
  return textOf(value);
}

/**
 * 書籍ノートの書誌を読む。`book_isbn` などのsnake_caseを優先し、
 * 旧データの camelCase も読めるようにする。値の検証は行わない。
 */
export function bookInfoFromFrontmatter(
  frontmatter: Record<string, unknown>
): BookInfo {
  const authorsValue = firstValue(frontmatter, [
    "book_author",
    "bookAuthor",
    "authors",
  ]);
  const authors = parseAuthors(authorsValue);
  const isbn = normalizeIsbn(
    firstText(frontmatter, ["book_isbn", "bookIsbn", "isbn"])
  );
  return {
    author: authors.join(AUTHOR_SEPARATOR),
    authors,
    category: firstText(frontmatter, ["book_category", "bookCategory"]),
    cover: firstText(frontmatter, ["book_cover", "bookCover"]),
    finished: firstText(frontmatter, ["book_finished", "bookFinished"]),
    isbn,
    ownership: firstText(frontmatter, ["book_ownership", "bookOwnership"]),
    published: firstText(frontmatter, ["book_published", "bookPublished"]),
    publisher: firstText(frontmatter, ["book_publisher", "bookPublisher"]),
    rating: parseBookRating(
      firstValue(frontmatter, ["book_rating", "bookRating"])
    ),
    readingStatus:
      parseReadingStatus(
        firstValue(frontmatter, ["reading_status", "readingStatus"])
      ) ?? "",
    series: firstText(frontmatter, ["book_series", "bookSeries"]),
  };
}
