import type { App } from "obsidian";
import { normalizePath, TFile, TFolder } from "obsidian";
import { NOTES_FOLDER } from "../../config";
import {
  BOOK_KIND,
  BOOK_PROPERTY_KEYS,
  type BookDraft,
  BookError,
  type BookInfo,
  bookInfoFromFrontmatter,
  bookNotePath,
  buildBookDocument,
  buildBookFrontmatterFields,
} from "../../domain/book";
import { bodyAfterFrontmatter } from "../../domain/frontmatter";
import { createId } from "../../domain/ids";
import { canonicalIsbn, isValidIsbn, normalizeIsbn } from "../../domain/isbn";
import { normalizeLink } from "../../domain/links";
import { withPathSuffix } from "../../domain/notes";
import { normalizeNewlines } from "../../domain/text";
import { formatLocalIso } from "../../domain/time";
import type { PropertyService, PropertyValue } from "../propertyService";
import {
  allBooks,
  type NoteRecord,
  type VaultIndexService,
} from "../vaultIndex";
import type { CoverFetchResult } from "./bookCoverService";

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

export interface BookRepositoryOptions {
  app: App;
  fetchCover: (
    rawIsbn: string,
    sourceUrl?: string,
    title?: string
  ) => Promise<CoverFetchResult>;
  index?: VaultIndexService | null;
  logError?: (context: string, error: unknown) => void;
  now?: () => Date;
  properties: PropertyService;
  writePlaceholderCover: (
    isbn: string,
    title: string,
    author: string
  ) => Promise<string>;
}

const SEARCH_TEXT_LIMIT = 20_000;
const EXCERPT_LIMIT = 180;

function bookIoError(
  message: string,
  error: unknown,
  detail?: string
): BookError {
  const msg = error instanceof Error ? error.message : String(error);
  return new BookError("BOOK_IO", message, detail ?? msg, error);
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

function sortBooks(records: NoteRecord[]): NoteRecord[] {
  return [...records].sort((left, right) => {
    const compared = left.title.localeCompare(right.title, "ja");
    return compared === 0 ? left.path.localeCompare(right.path) : compared;
  });
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

export class BookRepository {
  private readonly app: App;
  private readonly fetchCover: (
    rawIsbn: string,
    sourceUrl?: string,
    title?: string
  ) => Promise<CoverFetchResult>;
  private readonly index: VaultIndexService | null;
  private readonly logError:
    | ((context: string, error: unknown) => void)
    | undefined;
  private readonly now: () => Date;
  private readonly properties: PropertyService;
  private readonly writePlaceholderCover: (
    isbn: string,
    title: string,
    author: string
  ) => Promise<string>;

  constructor(options: BookRepositoryOptions) {
    this.app = options.app;
    this.fetchCover = options.fetchCover;
    this.index = options.index ?? null;
    this.logError = options.logError;
    this.now = options.now ?? (() => new Date());
    this.properties = options.properties;
    this.writePlaceholderCover = options.writePlaceholderCover;
  }

  async listBooks(): Promise<NoteRecord[]> {
    if (this.index) {
      const snap = await this.index.get();
      return sortBooks(allBooks(snap));
    }
    return sortBooks(await this.booksFromVault());
  }

  async findDuplicateByIsbn(isbn: string): Promise<NoteRecord | null> {
    const canonical = canonicalIsbn(isbn);
    if (canonical === "") {
      return null;
    }
    const books = await this.listBooks();
    for (const record of books) {
      const other = record.book.book_isbn ?? "";
      if (other !== "" && canonicalIsbn(other) === canonical) {
        return record;
      }
    }
    return null;
  }

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

    if (cover === "" && isbn !== "") {
      cover =
        (await this.writePlaceholderCover(
          isbn,
          input.title,
          Array.isArray(input.authors)
            ? input.authors.join(" / ")
            : (input.authors ?? "")
        )) || "";
    }

    const path = this.uniqueBookPath(input.title);
    const document = buildBookDocument({
      ...draft,
      body: input.body ?? "",
      cover: cover === "" ? null : cover,
    });

    try {
      await this.ensureFolder(NOTES_FOLDER);
      await this.app.vault.create(path, document);
    } catch (error) {
      throw bookIoError(`書籍ノートを作成できませんでした: ${path}`, error);
    }

    this.index?.invalidate();
    return {
      cover,
      coverError,
      isbn,
      path,
      title: input.title.trim(),
    };
  }

  async updateBook(path: string, patch: BookPatch): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new BookError(
        "BOOK_IO",
        `更新対象のノートが見つかりません: ${path}`
      );
    }

    const changes: Record<string, PropertyValue> = {};
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === "") {
        throw new BookError("INVALID_TITLE", "タイトルを入力してください");
      }
      changes.title = title;
    }
    if (patch.authors !== undefined) {
      const authors = Array.isArray(patch.authors)
        ? patch.authors.join(" / ")
        : (patch.authors ?? "");
      changes.book_author = authors.trim() === "" ? null : authors.trim();
    }
    assignOptionalText(changes, "book_publisher", patch.publisher);
    assignOptionalText(changes, "book_published", patch.published);
    assignOptionalText(changes, "book_category", patch.category);
    assignOptionalText(changes, "book_series", patch.series);
    assignOptionalText(changes, "book_cover", patch.cover);
    assignOptionalText(changes, "book_ownership", patch.ownership);

    if (patch.isbn !== undefined) {
      const raw = (patch.isbn ?? "").trim();
      if (raw === "") {
        changes.book_isbn = null;
      } else {
        const normalized = normalizeIsbn(raw);
        if (!isValidIsbn(normalized)) {
          throw new BookError(
            "INVALID_ISBN",
            "ISBNの形式が正しくありません。チェックディジットを確認してください。",
            raw
          );
        }
        changes.book_isbn = normalized;
      }
    }

    if (patch.readingStatus !== undefined) {
      const status = (patch.readingStatus ?? "").trim();
      changes.reading_status = status === "" ? null : status;
    }

    if (patch.finished !== undefined) {
      const finished = (patch.finished ?? "").trim();
      changes.book_finished = finished === "" ? null : finished;
    }

    if (patch.rating !== undefined) {
      changes.book_rating = patch.rating === null ? null : patch.rating;
    }

    await this.properties.update(path, changes);
    this.index?.invalidate();
  }

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
    const info: BookInfo = bookInfoFromFrontmatter(frontmatter);
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
        if (
          !(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)
        ) {
          throw error;
        }
      }
    }
  }
}
