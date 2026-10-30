/**
 * 本棚（BOOK）のサービス。VaultのMarkdownとPropertiesを正本とし、
 * 外部API（openBD / Open Library / カーリル）はユーザーの明示操作のときだけ呼ぶ。
 *
 * - 起動時一括取得はしない。
 * - 書誌取得に失敗しても、タイトルだけの手動登録は成立させる。
 * - ISBNは文字列のまま扱い、数値へパースしない。
 */

import type { App } from "obsidian";
import { normalizePath, TFile, TFolder } from "obsidian";
import { NOTES_FOLDER } from "../config";
import {
  AUTHOR_SEPARATOR,
  assertReadingStatus,
  BOOK_COVERS_FOLDER,
  BOOK_KIND,
  BOOK_PROPERTY_KEYS,
  type BookCandidate,
  type BookDraft,
  BookError,
  type BookLookupSource,
  bookCandidateFromOpenBd,
  bookCandidateFromOpenLibrary,
  bookCoverPath,
  bookInfoFromFrontmatter,
  bookNotePath,
  buildBookDocument,
  buildBookFrontmatterFields,
  CALIL_TIME_DEPENDENT_NOTICE,
  type CalilLibraryHit,
  calilCheckUrl,
  calilContinuePending,
  calilLibrariesFromPayload,
  calilSession,
  calilSessionUrl,
  canonicalIsbn,
  isbnDuplicateKey,
  isValidIsbn,
  MAX_COVER_BYTES,
  normalizeIsbn,
  openBdLookupUrl,
  openLibraryAuthorKeys,
  openLibraryAuthorUrl,
  openLibraryCoverUrl,
  openLibraryEditionUrl,
  parseAuthors,
  parseBookRating,
  parseCalilPayload,
} from "../domain/book";
import {
  type CalilBranch,
  type CalilLibraryInfo,
  calilBranchesFromLibraries,
  calilLibraryInfoFromPayload,
  calilLibraryUrl,
  parseCalilLibrarySelection,
} from "../domain/calil";
import { isSeitonError } from "../domain/errors";
import { bodyAfterFrontmatter, frontmatterField } from "../domain/frontmatter";
import {
  googleBooksCoverUrl,
  googleBooksSearchUrl,
} from "../domain/googleBooks";
import { createId } from "../domain/ids";
import { normalizeLink } from "../domain/links";
import { isAllowedRemoteUrl } from "../domain/network";
import { withPathSuffix } from "../domain/notes";
import { normalizeNewlines } from "../domain/text";
import { formatLocalIso, isValidDateKey } from "../domain/time";
import { type HttpClient, headerValue, ObsidianHttpClient } from "./http";
import { PropertyService, type PropertyValue } from "./propertyService";
import type { SeitonSettings } from "./settings";
import {
  allBooks,
  type NoteRecord,
  type VaultIndexService,
} from "./vaultIndex";

export interface BookServiceOptions {
  app: App;
  /** 設定は毎回読み直す（設定画面での変更を反映する）。 */
  getSettings?: () => Partial<SeitonSettings> | null | undefined;
  http?: HttpClient;
  /** 共有索引。渡された場合は listBooks で再利用する。 */
  index?: VaultIndexService;
  logError?: (context: string, error: unknown) => void;
  now?: () => Date;
  properties?: PropertyService;
}

export type BookLookupAttemptStatus = "ok" | "empty" | "error";

export interface BookLookupAttempt {
  message: string;
  source: BookLookupSource;
  status: BookLookupAttemptStatus;
}

export interface BookLookupResult {
  attempts: BookLookupAttempt[];
  candidate: BookCandidate | null;
  isbn: string;
  lookedUpAt: string;
}

const MIN_COVER_BYTES = 200;

export interface CoverFetchResult {
  bytes: number;
  downloaded: boolean;
  error: string | null;
  path: string;
}

export interface BookPatch {
  authors?: string | string[] | null;
  category?: string | null;
  cover?: string | null;
  finished?: string | null;
  isbn?: string | null;
  ownership?: string | null;
  published?: string | null;
  publisher?: string | null;
  rating?: number | string | null;
  readingStatus?: string | null;
  series?: string | null;
  title?: string;
}

export interface CreateBookInput {
  allowDuplicate?: boolean;
  authors?: string | string[] | null;
  body?: string | null;
  category?: string | null;
  coverUrl?: string | null;
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

export interface CreateBookResult {
  cover: string;
  coverError: string | null;
  isbn: string;
  path: string;
  title: string;
}

export interface CalilSearchResult {
  branches: CalilBranch[];
  configuredLibrary: string;
  continuePending: boolean;
  fetchedAt: string;
  isbn: string;
  libraries: CalilLibraryHit[];
  notice: string;
  session: string;
}

const SEARCH_TEXT_LIMIT = 20_000;
const EXCERPT_LIMIT = 180;

function bookIoError(
  message: string,
  error: unknown,
  detail?: string
): BookError {
  return new BookError("BOOK_IO", message, detail ?? messageOf(error), error);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "path" in item) {
          return String((item as { path?: unknown }).path ?? "");
        }
        return "";
      })
      .filter((item) => item !== "");
  }
  if (typeof value === "string") {
    return value
      .split(/[,、]/u)
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  return [];
}

function booleanOf(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function jsonText(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  return textOf((value as Record<string, unknown>)[key]).trim();
}

function sortBooks(records: NoteRecord[]): NoteRecord[] {
  return [...records].sort((left, right) => {
    const compared = left.title.localeCompare(right.title, "ja");
    return compared === 0 ? left.path.localeCompare(right.path) : compared;
  });
}

export class BookService {
  private readonly app: App;
  private readonly calilInfoCache = new Map<string, CalilLibraryInfo[]>();
  private readonly getSettings: () =>
    | Partial<SeitonSettings>
    | null
    | undefined;
  private readonly http: HttpClient;
  private readonly index: VaultIndexService | null;
  private readonly logError:
    | ((context: string, error: unknown) => void)
    | undefined;
  private readonly now: () => Date;
  private readonly properties: PropertyService;

  constructor(options: BookServiceOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings ?? (() => ({}));
    this.http = options.http ?? new ObsidianHttpClient();
    this.index = options.index ?? null;
    this.logError = options.logError;
    this.now = options.now ?? (() => new Date());
    this.properties = options.properties ?? new PropertyService(options.app);
  }

  // -------------------------------------------------------------------------
  // 一覧・重複
  // -------------------------------------------------------------------------

  /**
   * kind: book のノートをタイトル順で返す。
   * 共有索引があればそれを使い、無ければ metadataCache から列挙する。
   */
  async listBooks(): Promise<NoteRecord[]> {
    if (this.index) {
      return sortBooks(allBooks(await this.index.get()));
    }
    return sortBooks(await this.booksFromVault());
  }

  /** 正規化ISBNが一致する既存の書籍ノート。ISBN-10/13の違いも吸収する。 */
  async findDuplicateByIsbn(isbn: string): Promise<NoteRecord | null> {
    const wanted = isbnDuplicateKey(isbn);
    if (wanted === "") {
      return null;
    }
    for (const record of await this.listBooks()) {
      const info = bookInfoFromFrontmatter(record.frontmatter);
      if (isbnDuplicateKey(info.isbn) === wanted) {
        return record;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 書誌照会（明示操作のみ）
  // -------------------------------------------------------------------------

  /**
   * openBD を優先し、失敗・未登録なら Open Library へフォールバックする。
   * 通信・API障害は例外にせず attempts に残す（手動登録を妨げない）。
   */
  async lookupIsbn(rawIsbn: string): Promise<BookLookupResult> {
    const isbn = canonicalIsbn(rawIsbn) || normalizeIsbn(rawIsbn);
    if (!isValidIsbn(isbn)) {
      throw new BookError(
        "INVALID_ISBN",
        "ISBNの形式が正しくありません。チェックディジットを確認してください。",
        rawIsbn
      );
    }

    const attempts: BookLookupAttempt[] = [];
    const lookedUpAt = formatLocalIso(this.now());

    const openBd = await this.lookupOpenBd(isbn, attempts);
    if (openBd) {
      return { attempts, candidate: openBd, isbn, lookedUpAt };
    }

    const openLibrary = await this.lookupOpenLibrary(isbn, attempts);
    return { attempts, candidate: openLibrary, isbn, lookedUpAt };
  }

  private async lookupOpenBd(
    isbn: string,
    attempts: BookLookupAttempt[]
  ): Promise<BookCandidate | null> {
    try {
      const response = await this.http.get(openBdLookupUrl(isbn));
      if (response.status !== 200) {
        attempts.push({
          message: `HTTP ${response.status}`,
          source: "openbd",
          status: "error",
        });
        return null;
      }
      const candidate = bookCandidateFromOpenBd(response.json, isbn);
      if (candidate) {
        attempts.push({
          message: "openBDで書誌を取得しました",
          source: "openbd",
          status: "ok",
        });
        return candidate;
      }
      attempts.push({
        message: "openBDに登録がありませんでした",
        source: "openbd",
        status: "empty",
      });
      return null;
    } catch (error) {
      this.logError?.("book.lookupOpenBd", error);
      attempts.push({
        message: messageOf(error),
        source: "openbd",
        status: "error",
      });
      return null;
    }
  }

  private async lookupOpenLibrary(
    isbn: string,
    attempts: BookLookupAttempt[]
  ): Promise<BookCandidate | null> {
    try {
      const response = await this.http.get(openLibraryEditionUrl(isbn));
      if (response.status === 404) {
        attempts.push({
          message: "Open Libraryに登録がありませんでした",
          source: "openlibrary",
          status: "empty",
        });
        return null;
      }
      if (response.status !== 200) {
        attempts.push({
          message: `HTTP ${response.status}`,
          source: "openlibrary",
          status: "error",
        });
        return null;
      }
      const authorNames = await this.resolveOpenLibraryAuthors(response.json);
      const candidate = bookCandidateFromOpenLibrary(
        response.json,
        isbn,
        authorNames
      );
      if (candidate) {
        attempts.push({
          message: "Open Libraryで書誌を取得しました",
          source: "openlibrary",
          status: "ok",
        });
        return candidate;
      }
      attempts.push({
        message: "Open Libraryの書誌を解釈できませんでした",
        source: "openlibrary",
        status: "empty",
      });
      return null;
    } catch (error) {
      this.logError?.("book.lookupOpenLibrary", error);
      attempts.push({
        message: messageOf(error),
        source: "openlibrary",
        status: "error",
      });
      return null;
    }
  }

  /** 著者名は edition JSON に無いため、最大3件だけ補助取得する（失敗は無視）。 */
  private async resolveOpenLibraryAuthors(
    payload: unknown
  ): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    const keys = openLibraryAuthorKeys(payload).slice(0, 3);
    await Promise.all(
      keys.map(async (key) => {
        const url = openLibraryAuthorUrl(key);
        if (url === "") {
          return;
        }
        try {
          const response = await this.http.get(url);
          if (response.status !== 200) {
            return;
          }
          const name = jsonText(response.json, "name");
          if (name !== "") {
            names[key] = name;
          }
        } catch (error) {
          this.logError?.("book.resolveOpenLibraryAuthor", error);
        }
      })
    );
    return names;
  }

  // -------------------------------------------------------------------------
  // 作成・更新
  // -------------------------------------------------------------------------

  /**
   * Seiton/Notes に kind: book のMarkdownを作る。
   * 表紙の取得に失敗してもノート作成は成功として返す。
   */
  async createBook(input: CreateBookInput): Promise<CreateBookResult> {
    const rawIsbn = (input.isbn ?? "").trim();
    const isbn = rawIsbn === "" ? "" : normalizeIsbn(rawIsbn);
    if (rawIsbn !== "" && !isValidIsbn(isbn)) {
      throw new BookError(
        "INVALID_ISBN",
        "ISBNの形式が正しくありません。チェックディジットを確認してください。",
        rawIsbn
      );
    }

    const created = input.created?.trim() || formatLocalIso(this.now());
    const draft: BookDraft = {
      authors: input.authors,
      category: input.category,
      created,
      finished: input.finished,
      isbn,
      ownership: input.ownership,
      published: input.published,
      publisher: input.publisher,
      rating: input.rating,
      readingStatus: input.readingStatus,
      series: input.series,
      title: input.title,
    };
    // 通信の前にtitle・ISBN・状態・日付を検証する。
    buildBookFrontmatterFields(draft);

    if (isbn !== "" && input.allowDuplicate !== true) {
      const duplicate = await this.findDuplicateByIsbn(isbn);
      if (duplicate) {
        throw new BookError(
          "BOOK_DUPLICATE",
          `同じISBNの書籍が既にあります: ${duplicate.title}`,
          duplicate.path
        );
      }
    }

    let cover = "";
    let coverError: string | null = null;
    const coverUrl = (input.coverUrl ?? "").trim();
    if (coverUrl !== "") {
      if (isbn === "") {
        coverError = "ISBNがないため表紙を保存できませんでした。";
      } else {
        const fetched = await this.fetchCover(isbn, coverUrl, input.title);
        if (fetched.downloaded) {
          cover = fetched.path;
        } else {
          coverError = fetched.error;
        }
      }
    }

    const document = buildBookDocument({
      authors: input.authors,
      body: input.body,
      category: input.category,
      cover,
      created,
      finished: input.finished,
      isbn,
      ownership: input.ownership,
      published: input.published,
      publisher: input.publisher,
      rating: input.rating,
      readingStatus: input.readingStatus,
      series: input.series,
      title: input.title,
    });
    const path = this.uniqueBookPath(input.title);
    try {
      await this.ensureFolder(NOTES_FOLDER);
    } catch (error) {
      if (error instanceof BookError) {
        throw error;
      }
      throw bookIoError("保存先フォルダを作成できませんでした。", error);
    }

    try {
      await this.app.vault.create(path, document);
    } catch (error) {
      throw bookIoError("書籍ノートを作成できませんでした。", error);
    }
    this.index?.invalidate();

    return { cover, coverError, isbn, path, title: input.title.trim() };
  }

  /**
   * Propertiesを更新する。`null` / 空文字は削除、`undefined` は変更なし。
   * 書籍ノート（kind: book）以外は破壊しないよう拒否する。
   */
  async updateBook(path: string, patch: BookPatch): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new BookError("BOOK_IO", `書籍ノートがありません: ${path}`);
    }
    const content = await this.app.vault.cachedRead(file);
    if (frontmatterField(content, "kind") !== BOOK_KIND) {
      throw new BookError(
        "BOOK_IO",
        "書籍ノート（kind: book）ではないため更新しません。",
        path
      );
    }

    const changes: Record<string, PropertyValue> = {};

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === "") {
        throw new BookError("INVALID_TITLE", "タイトルを空にはできません。");
      }
      changes.title = title;
    }

    if (patch.isbn !== undefined) {
      const raw = (patch.isbn ?? "").trim();
      if (raw === "") {
        changes.book_isbn = null;
      } else {
        const isbn = normalizeIsbn(raw);
        if (!isValidIsbn(isbn)) {
          throw new BookError(
            "INVALID_ISBN",
            "ISBNの形式が正しくありません。",
            raw
          );
        }
        changes.book_isbn = isbn;
      }
    }

    if (patch.authors !== undefined) {
      const authors = parseAuthors(patch.authors);
      changes.book_author =
        authors.length === 0 ? null : authors.join(AUTHOR_SEPARATOR);
    }

    assignOptionalText(changes, "book_publisher", patch.publisher);
    assignOptionalText(changes, "book_published", patch.published);
    assignOptionalText(changes, "book_category", patch.category);
    assignOptionalText(changes, "book_series", patch.series);
    assignOptionalText(changes, "book_cover", patch.cover);
    assignOptionalText(changes, "book_ownership", patch.ownership);

    if (patch.readingStatus !== undefined) {
      const raw = (patch.readingStatus ?? "").trim();
      changes.reading_status = raw === "" ? null : assertReadingStatus(raw);
    }

    if (patch.finished !== undefined) {
      const raw = (patch.finished ?? "").trim();
      if (raw === "") {
        changes.book_finished = null;
      } else {
        if (!isValidDateKey(raw)) {
          throw new BookError(
            "INVALID_DATE",
            "読了日は YYYY-MM-DD 形式の実在する日付で入力してください。",
            raw
          );
        }
        changes.book_finished = raw;
      }
    }

    if (patch.rating !== undefined) {
      const raw = patch.rating === null ? "" : String(patch.rating).trim();
      if (raw === "" || raw === "0") {
        changes.book_rating = null;
      } else {
        const rating = parseBookRating(raw);
        if (rating === null) {
          throw new BookError(
            "INVALID_RATING",
            "評価は1〜5の整数で指定してください。",
            raw
          );
        }
        changes.book_rating = rating;
      }
    }

    if (Object.keys(changes).length === 0) {
      return;
    }

    try {
      await this.properties.update(path, changes);
    } catch (error) {
      if (isSeitonError(error)) {
        throw bookIoError(error.message, error, path);
      }
      throw bookIoError("書籍の更新に失敗しました。", error);
    }
    this.index?.invalidate();
  }

  // -------------------------------------------------------------------------
  // 表紙
  // -------------------------------------------------------------------------

  private async googleBooksCoverUrl(
    isbn: string,
    title: string
  ): Promise<string | null> {
    const apiKey = (this.getSettings?.()?.googleBooksApiKey ?? "").trim();
    if (apiKey === "") {
      return null;
    }
    const query = title.trim() === "" ? `isbn:${isbn}` : title.trim();
    try {
      const response = await this.http.get(googleBooksSearchUrl(query, apiKey));
      if (response.status !== 200) {
        return null;
      }
      return googleBooksCoverUrl(response.json, isbn);
    } catch (error) {
      this.logError?.("book.googleBooksCover", error);
      return null;
    }
  }

  /**
   * 表紙を `Seiton/System/Assets/Covers/{ISBN}.jpg` へ保存する。
   * 5MB上限・画像Content-Typeのみ。失敗は例外にせず結果で返す。
   */
  async fetchCover(
    rawIsbn: string,
    sourceUrl?: string,
    title = ""
  ): Promise<CoverFetchResult> {
    const isbn = normalizeIsbn(rawIsbn);
    const path = bookCoverPath(isbn);
    if (!isValidIsbn(isbn) || path === "") {
      return {
        bytes: 0,
        downloaded: false,
        error: "ISBNが不正なため表紙を保存できませんでした。",
        path: "",
      };
    }

    let url = (sourceUrl ?? "").trim();
    if (url === "") {
      const googleBooks = await this.googleBooksCoverUrl(isbn, title);
      url = googleBooks ?? openLibraryCoverUrl(isbn);
    }
    if (!isAllowedRemoteUrl(url)) {
      return {
        bytes: 0,
        downloaded: false,
        error: "表紙URLがhttp/httpsの外部URLではありません。",
        path,
      };
    }

    try {
      const response = await this.http.get(url);
      if (response.status !== 200) {
        return {
          bytes: 0,
          downloaded: false,
          error: `表紙を取得できませんでした（HTTP ${response.status}）。`,
          path,
        };
      }

      const contentType = headerValue(response.headers, "content-type");
      if (!contentType.toLowerCase().startsWith("image/")) {
        return {
          bytes: 0,
          downloaded: false,
          error: "表紙が画像ではありません（Content-Type）。",
          path,
        };
      }

      const declaredLength = Number.parseInt(
        headerValue(response.headers, "content-length"),
        10
      );
      if (Number.isFinite(declaredLength) && declaredLength > MAX_COVER_BYTES) {
        return {
          bytes: declaredLength,
          downloaded: false,
          error: "表紙画像が大きすぎます（5MB上限）。",
          path,
        };
      }

      const bytes = response.arrayBuffer.byteLength;
      if (bytes === 0) {
        return {
          bytes: 0,
          downloaded: false,
          error: "表紙画像が空でした。",
          path,
        };
      }
      if (bytes > MAX_COVER_BYTES) {
        return {
          bytes,
          downloaded: false,
          error: "表紙画像が大きすぎます（5MB上限）。",
          path,
        };
      }
      if (bytes < MIN_COVER_BYTES) {
        return {
          bytes,
          downloaded: false,
          error: "表紙画像が見つかりませんでした。",
          path,
        };
      }

      await this.ensureFolder(BOOK_COVERS_FOLDER);
      const existing = this.app.vault.getAbstractFileByPath(
        normalizePath(path)
      );
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, response.arrayBuffer);
      } else {
        await this.app.vault.createBinary(path, response.arrayBuffer);
      }
      return { bytes, downloaded: true, error: null, path };
    } catch (error) {
      this.logError?.("book.fetchCover", error);
      return {
        bytes: 0,
        downloaded: false,
        error: `表紙を保存できませんでした: ${messageOf(error)}`,
        path,
      };
    }
  }

  /** 既存の本の表紙を取得し直し、成功したらPropertiesを更新する。 */
  async refreshCover(record: NoteRecord): Promise<CoverFetchResult> {
    const isbn = record.book.book_isbn ?? "";
    const result = await this.fetchCover(isbn, undefined, record.title);
    if (result.downloaded) {
      await this.updateBook(record.path, { cover: result.path });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // カーリル
  // -------------------------------------------------------------------------

  private async calilLibraryInfo(
    systemid: string
  ): Promise<CalilLibraryInfo[]> {
    const cached = this.calilInfoCache.get(systemid);
    if (cached) {
      return cached;
    }
    const appKey = (this.getSettings()?.calilApiKey ?? "").trim();
    if (appKey === "") {
      return [];
    }
    try {
      const response = await this.http.get(calilLibraryUrl(systemid, appKey));
      if (response.status !== 200) {
        this.calilInfoCache.set(systemid, []);
        return [];
      }
      const infos = calilLibraryInfoFromPayload(
        parseCalilPayload(response.text)
      );
      this.calilInfoCache.set(systemid, infos);
      return infos;
    } catch (error) {
      this.logError?.("book.calilLibraryInfo", error);
      this.calilInfoCache.set(systemid, []);
      return [];
    }
  }

  /**
   * カーリルの蔵書検索。APIキー未設定は明確なエラーにする。
   * 結果は時間依存データとして取得日時と注意文を添えて返す。
   */
  async searchCalil(rawIsbn: string): Promise<CalilSearchResult> {
    const isbn = canonicalIsbn(rawIsbn) || normalizeIsbn(rawIsbn);
    if (!isValidIsbn(isbn)) {
      throw new BookError(
        "INVALID_ISBN",
        "ISBNの形式が正しくありません。",
        rawIsbn
      );
    }

    const settings = this.getSettings() ?? {};
    const appKey = (settings.calilApiKey ?? "").trim();
    if (appKey === "") {
      throw new BookError(
        "CALIL_KEY_MISSING",
        "カーリルのAPIキーが未設定です。設定画面で入力してください。"
      );
    }
    const selection = parseCalilLibrarySelection(settings.calilLibrary ?? "");
    const configuredLibrary = selection.display;
    if (selection.systems.length === 0) {
      throw new BookError(
        "CALIL_LIBRARY_MISSING",
        "カーリルの図書館ID（systemid）が未設定です。設定画面で入力してください。"
      );
    }

    let payload: unknown;
    try {
      let response = await this.http.get(
        calilCheckUrl(isbn, appKey, selection.systems.join(","))
      );
      if (response.status !== 200) {
        throw new BookError(
          "BOOK_IO",
          `カーリルの検索に失敗しました（HTTP ${response.status}）。`
        );
      }
      payload = parseCalilPayload(response.text);
      for (
        let attempt = 0;
        attempt < 10 &&
        calilContinuePending(payload) &&
        calilSession(payload) !== "";
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        response = await this.http.get(
          calilSessionUrl(calilSession(payload), appKey)
        );
        if (response.status !== 200) {
          break;
        }
        const next = parseCalilPayload(response.text);
        if (next === null) {
          break;
        }
        payload = next;
      }
    } catch (error) {
      if (error instanceof BookError) {
        throw error;
      }
      throw bookIoError("カーリルに接続できませんでした。", error);
    }

    if (payload === null) {
      throw new BookError("BOOK_IO", "カーリルの応答を解釈できませんでした。");
    }

    const libraries = calilLibrariesFromPayload(
      payload,
      isbn,
      configuredLibrary
    );
    const systemids = [
      ...new Set(libraries.map((library) => library.systemid)),
    ].filter((systemid) => systemid !== "");
    const infos = (
      await Promise.all(
        systemids.map((systemid) => this.calilLibraryInfo(systemid))
      )
    ).flat();

    return {
      branches: calilBranchesFromLibraries(
        libraries,
        infos,
        selection.branchIds
      ),
      configuredLibrary,
      continuePending: calilContinuePending(payload),
      fetchedAt: formatLocalIso(this.now()),
      isbn,
      libraries,
      notice: CALIL_TIME_DEPENDENT_NOTICE,
      session: calilSession(payload),
    };
  }

  // -------------------------------------------------------------------------
  // Vault列挙（索引なしでも単体で動く）
  // -------------------------------------------------------------------------

  private async booksFromVault(): Promise<NoteRecord[]> {
    const files: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.frontmatterOf(file).kind === BOOK_KIND) {
        files.push(file);
      }
    }
    const records = await Promise.all(
      files.map(async (file) => {
        const frontmatter = this.frontmatterOf(file);
        let content = "";
        try {
          content = await this.app.vault.cachedRead(file);
        } catch (error) {
          this.logError?.("book.listBooks.read", error);
        }
        return this.recordFromFile(file, frontmatter, content);
      })
    );
    return records;
  }

  private frontmatterOf(file: TFile): Record<string, unknown> {
    const cache = this.app.metadataCache.getFileCache(file);
    return (cache?.frontmatter as Record<string, unknown> | undefined) ?? {};
  }

  private recordFromFile(
    file: TFile,
    frontmatter: Record<string, unknown>,
    content: string
  ): NoteRecord {
    const info = bookInfoFromFrontmatter(frontmatter);
    const book: Record<string, string> = {};
    for (const key of BOOK_PROPERTY_KEYS) {
      const value = textOf(frontmatter[key]).trim();
      if (value !== "") {
        book[key] = value;
      }
    }

    const body = content === "" ? "" : bodyAfterFrontmatter(content);
    const plain = normalizeNewlines(body)
      .replace(/<!--[\s\S]*?-->/gu, "")
      .replace(/\s+/gu, " ")
      .trim();

    return {
      archived: booleanOf(frontmatter.archived),
      basename: file.basename,
      book,
      course: textOf(frontmatter.course),
      cover:
        info.cover || textOf(frontmatter.cover) || textOf(frontmatter.image),
      created: textOf(frontmatter.created),
      excerpt: plain.slice(0, EXCERPT_LIMIT),
      frontmatter,
      kind: BOOK_KIND,
      lists: listOf(frontmatter.lists),
      mtime: file.stat.mtime,
      path: file.path,
      pinned: booleanOf(frontmatter.pinned),
      projects: listOf(frontmatter.projects).map((item) => normalizeLink(item)),
      review: booleanOf(frontmatter.review),
      searchText: normalizeNewlines(body).slice(0, SEARCH_TEXT_LIMIT),
      source: textOf(frontmatter.source),
      tags: listOf(frontmatter.tags).map((tag) =>
        tag.replace(/^#/u, "").trim()
      ),
      title: textOf(frontmatter.title) || file.basename,
      type: "note",
    };
  }

  // -------------------------------------------------------------------------
  // パス・フォルダ
  // -------------------------------------------------------------------------

  private uniqueBookPath(title: string): string {
    const base = bookNotePath(title);
    if (!this.pathExists(base)) {
      return base;
    }
    for (let index = 2; index < 100; index += 1) {
      const candidate = withPathSuffix(base, String(index));
      if (!this.pathExists(candidate)) {
        return candidate;
      }
    }
    return withPathSuffix(base, createId("b").slice(-8).toLowerCase());
  }

  private pathExists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing) {
        if (existing instanceof TFolder) {
          continue;
        }
        throw new BookError(
          "BOOK_IO",
          `フォルダを作成できません（同名のファイルがあります）: ${current}`
        );
      }
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        // 同時作成との競合。フォルダができていれば成功として扱う。
        if (
          !(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)
        ) {
          throw error;
        }
      }
    }
  }
}

function assignOptionalText(
  changes: Record<string, PropertyValue>,
  key: string,
  value: string | null | undefined
): void {
  if (value === undefined) {
    return;
  }
  const text = value === null ? "" : value.trim();
  changes[key] = text === "" ? null : text;
}
