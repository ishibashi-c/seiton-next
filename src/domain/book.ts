/**
 * 本棚（BOOK）の純関数。Obsidian API に依存しない。
 *
 * ISBNは数値としてパースせず、先頭ゼロを保った文字列として扱う。
 * 外部API（openBD / Open Library / カーリル）のレスポンスは `unknown` のまま受け取り、
 * ここで必要な項目だけを緩く読み取る。ネットワーク呼び出しは行わない。
 */

import { ASSETS_FOLDER, NOTES_FOLDER } from "../config";
import { buildFrontmatter, scanFrontmatter, yamlQuoted } from "./frontmatter";
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

export const OPEN_BD_BASE = "https://api.openbd.jp/v1/get";
export const OPEN_LIBRARY_BASE = "https://openlibrary.org";
export const OPEN_LIBRARY_COVER_BASE = "https://covers.openlibrary.org";
export const CALIL_CHECK_BASE = "https://api.calil.jp/check";

export const CALIL_TIME_DEPENDENT_NOTICE =
  "カーリルの蔵書状況は取得時点の情報です。時間依存データのため、最新の状況はカーリルで確認してください。";

/** 複数著者の区切り。frontmatterでは1つのテキストとして保存する。 */
export const AUTHOR_SEPARATOR = " / ";

const ISBN_SEPARATORS = /[\s\u00a0\u3000\-‐‑‒–—―ー−]/gu;
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
// ISBN（文字列のまま扱う）
// ---------------------------------------------------------------------------

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

export type BookLookupSource = "openbd" | "openlibrary";

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

/** 外部JSONの境界。`unknown` からオブジェクトだけを取り出す。 */
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

function textField(value: unknown, key: string): string {
  return textOf(fieldOf(value, key));
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

function textListField(value: unknown, key: string): string[] {
  return asList(fieldOf(value, key))
    .map((item) => textOf(item))
    .filter((item) => item !== "");
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
  if (body === "") {
    return `${frontmatter}${eol}`;
  }
  const bodyWithEol = eol === "\n" ? body : body.replace(/\n/gu, eol);
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

// ---------------------------------------------------------------------------
// カーリル（時間依存データ）
// ---------------------------------------------------------------------------

/** JSONP（`callback({...});`）なら中身だけを取り出す。 */
export function stripJsonp(text: string): string {
  const trimmed = text.trim();
  const match = /^[A-Za-z_$][\w$.]*\s*\(([\s\S]*)\)\s*;?$/u.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/** カーリルの応答（JSON/JSONP）をパースする。解釈できなければ null。 */
export function parseCalilPayload(text: string): unknown {
  const body = stripJsonp(text);
  if (body === "") {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export interface CalilLibraryHit {
  /** 図書館名 → 貸出状態。 */
  availability: Record<string, string>;
  /** 設定した自治体・システムに一致するか。 */
  configured: boolean;
  reserveUrl: string;
  status: string;
  systemid: string;
  systemname: string;
}

/** カンマ区切りのsystemidを、前後の空白を落として正規化する。 */
export function normalizeCalilSystemIds(value: string): string {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(",");
}

function configuredMatch(
  systemid: string,
  systemname: string,
  configuredLibrary: string
): boolean {
  const targets = configuredLibrary
    .normalize("NFKC")
    .split(",")
    .map((part) => part.trim().split(":")[0]?.trim() ?? "")
    .filter((part) => part !== "");
  if (targets.length === 0) {
    return false;
  }
  const lowerSystemId = systemid.toLowerCase();
  return targets.some(
    (target) =>
      lowerSystemId === target.toLowerCase() ||
      (systemname !== "" && systemname.includes(target))
  );
}

function calilHit(
  entry: unknown,
  configuredLibrary: string
): CalilLibraryHit | null {
  const record = asObject(entry);
  if (!record) {
    return null;
  }
  const availability: Record<string, string> = {};
  for (const [name, value] of Object.entries(asObject(record.libkey) ?? {})) {
    if (typeof value === "string" && value.trim() !== "") {
      availability[name] = value;
    }
  }
  const systemid = textField(record, "systemid");
  const systemname = textField(record, "systemname") || systemid;
  if (
    systemid === "" &&
    systemname === "" &&
    Object.keys(availability).length === 0
  ) {
    return null;
  }
  return {
    availability,
    configured: configuredMatch(systemid, systemname, configuredLibrary),
    reserveUrl: textField(record, "reserveurl"),
    status: textField(record, "status"),
    systemid,
    systemname,
  };
}

/**
 * `books[isbn]` の値から図書館エントリを取り出す。
 * 実APIは `{ systemid: { status, libkey, reserveurl } }` の入れ子、
 * 旧形式は `{ status, libkey, systemid, ... }` の直下に置く。
 */
function calilBookEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asObject(value);
  if (!record) {
    return value === undefined || value === null ? [] : [value];
  }
  if (
    "systemid" in record ||
    "status" in record ||
    "libkey" in record ||
    "reserveurl" in record
  ) {
    return [record];
  }
  const entries: unknown[] = [];
  for (const [systemid, entry] of Object.entries(record)) {
    const nested = asObject(entry);
    if (!nested) {
      continue;
    }
    entries.push({
      ...nested,
      systemid: textField(nested, "systemid") || systemid,
    });
  }
  return entries;
}

/**
 * カーリル `/check` の応答から図書館ごとの状態を組み立てる。
 * `books` 形式と、ISBNをトップレベルに持つ旧形式の両方を受け付ける。
 * 同じシステムが重複した場合は最初の1件だけ残す。
 */
export function calilLibrariesFromPayload(
  payload: unknown,
  isbnValue: string,
  configuredLibrary = ""
): CalilLibraryHit[] {
  const root = asObject(payload);
  if (!root) {
    return [];
  }
  const normalized = normalizeIsbn(isbnValue);
  const canonical = canonicalIsbn(normalized);
  const matches = (key: string): boolean => {
    const keyIsbn = normalizeIsbn(key);
    if (keyIsbn === "") {
      return false;
    }
    return (
      keyIsbn === normalized ||
      keyIsbn === canonical ||
      (canonical !== "" && canonicalIsbn(keyIsbn) === canonical)
    );
  };

  const entries: unknown[] = [];
  const books = asObject(root.books);
  if (books) {
    for (const [key, value] of Object.entries(books)) {
      if (matches(key)) {
        entries.push(...calilBookEntries(value));
      }
    }
  }
  for (const [key, value] of Object.entries(root)) {
    if (matches(key)) {
      entries.push(...calilBookEntries(value));
    }
  }

  const hits = new Map<string, CalilLibraryHit>();
  for (const entry of entries) {
    const hit = calilHit(entry, configuredLibrary);
    if (!hit) {
      continue;
    }
    const mapKey = `${hit.systemid}\u0000${hit.systemname}`;
    if (!hits.has(mapKey)) {
      hits.set(mapKey, hit);
    }
  }

  return [...hits.values()].sort((left, right) => {
    if (left.configured !== right.configured) {
      return left.configured ? -1 : 1;
    }
    return left.systemname.localeCompare(right.systemname, "ja");
  });
}

export function calilContinuePending(payload: unknown): boolean {
  const value = fieldOf(payload, "continue");
  return value === 1 || value === "1";
}

export function calilSession(payload: unknown): string {
  return textField(payload, "session");
}

export function calilStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case "OK":
      return "蔵書あり";
    case "CACHE":
      return "蔵書あり";
    case "MAINTENANCE":
      return "メンテナンス中";
    case "ERROR":
      return "エラー";
    case "RUNNING":
      return "検索中";
    default:
      return status === "" ? "状態不明" : status;
  }
}

// ---------------------------------------------------------------------------
// 外部APIのURL（呼び出しはサービス層の明示操作だけ）
// ---------------------------------------------------------------------------

export function openBdLookupUrl(isbnValue: string): string {
  return `${OPEN_BD_BASE}?isbn=${encodeURIComponent(normalizeIsbn(isbnValue))}`;
}

export function openLibraryEditionUrl(isbnValue: string): string {
  return `${OPEN_LIBRARY_BASE}/isbn/${encodeURIComponent(
    normalizeIsbn(isbnValue)
  )}.json`;
}

export function calilCheckUrl(
  isbnValue: string,
  appKey: string,
  systemId: string
): string {
  const isbn = canonicalIsbn(isbnValue) || normalizeIsbn(isbnValue);
  const params = new URLSearchParams({
    appkey: appKey,
    callback: "no",
    format: "json",
    isbn,
    systemid: systemId,
  });
  return `${CALIL_CHECK_BASE}?${params.toString()}`;
}

/** カーリルの検索継続（ポーリング）用URL。 */
export function calilSessionUrl(session: string, appKey: string): string {
  const params = new URLSearchParams({
    appkey: appKey,
    callback: "no",
    format: "json",
    session,
  });
  return `${CALIL_CHECK_BASE}?${params.toString()}`;
}
