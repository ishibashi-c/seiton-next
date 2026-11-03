/**
 * 本棚（BOOK）のObsidian連携サービス（Facade）。
 * ノート・frontmatter・表紙画像・外部API（openBD / Open Library / Google Books / カーリル）の
 * 実際の入出力を、専門サービスへ委譲して統括する。
 */

import type { App } from "obsidian";
import type { CalilBranch } from "../domain/calil";
import type { CalilSummary } from "../domain/calilStatus";
import {
  BookCalilService,
  type CalilSearchResult,
} from "./books/bookCalilService";
import {
  BookCoverService,
  type CoverFetchResult,
} from "./books/bookCoverService";
import {
  type BookLookupResult,
  BookLookupService,
} from "./books/bookLookupService";
import {
  type BookPatch,
  BookRepository,
  type CreateBookInput,
  type CreateBookResult,
} from "./books/bookRepository";
import { type HttpClient, ObsidianHttpClient } from "./http";
import { PropertyService } from "./propertyService";
import type { SeitonSettings } from "./settings";
import type { NoteRecord, VaultIndexService } from "./vaultIndex";

export type { CalilSearchResult } from "./books/bookCalilService";
export type { CoverFetchResult } from "./books/bookCoverService";
export type {
  BookLookupAttempt,
  BookLookupResult,
} from "./books/bookLookupService";
export type {
  BookPatch,
  CreateBookInput,
  CreateBookResult,
} from "./books/bookRepository";

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
  /** 表紙を取得できなかったときに、仮表紙を描く関数。 */
  renderPlaceholderCover?: (input: {
    author: string;
    title: string;
  }) => Promise<ArrayBuffer | null>;
}

export class BookService {
  private readonly lookupService: BookLookupService;
  private readonly coverService: BookCoverService;
  private readonly calilService: BookCalilService;
  private readonly repository: BookRepository;

  constructor(options: BookServiceOptions) {
    const http = options.http ?? new ObsidianHttpClient();
    const properties = options.properties ?? new PropertyService(options.app);

    this.lookupService = new BookLookupService({
      getSettings: options.getSettings,
      http,
      logError: options.logError,
      now: options.now,
    });

    this.coverService = new BookCoverService({
      app: options.app,
      getSettings: options.getSettings,
      http,
      logError: options.logError,
      renderPlaceholderCover: options.renderPlaceholderCover,
      updateBook: (path, patch) => this.repository.updateBook(path, patch),
    });

    this.calilService = new BookCalilService({
      app: options.app,
      getSettings: options.getSettings,
      http,
      index: options.index,
      logError: options.logError,
      now: options.now,
      properties,
    });

    this.repository = new BookRepository({
      app: options.app,
      fetchCover: (isbn, url, title) =>
        this.coverService.fetchCover(isbn, url, title),
      index: options.index,
      logError: options.logError,
      now: options.now,
      properties,
      writePlaceholderCover: (isbn, title, author) =>
        this.coverService.writePlaceholderCover(isbn, title, author),
    });
  }

  async listBooks(): Promise<NoteRecord[]> {
    return this.repository.listBooks();
  }

  async findDuplicateByIsbn(isbn: string): Promise<NoteRecord | null> {
    return this.repository.findDuplicateByIsbn(isbn);
  }

  async lookupIsbn(rawIsbn: string): Promise<BookLookupResult> {
    return this.lookupService.lookupIsbn(rawIsbn);
  }

  async createBook(input: CreateBookInput): Promise<CreateBookResult> {
    return this.repository.createBook(input);
  }

  async updateBook(path: string, patch: BookPatch): Promise<void> {
    return this.repository.updateBook(path, patch);
  }

  async saveCalilState(
    path: string,
    isbn: string,
    summary: CalilSummary,
    branches: CalilBranch[]
  ): Promise<void> {
    return this.calilService.saveCalilState(path, isbn, summary, branches);
  }

  async readCalilDetail(isbn: string): Promise<CalilBranch[] | null> {
    return this.calilService.readCalilDetail(isbn);
  }

  async applyPlaceholderCover(record: NoteRecord): Promise<boolean> {
    return this.coverService.applyPlaceholderCover(record);
  }

  async fetchCover(
    rawIsbn: string,
    sourceUrl?: string,
    title = ""
  ): Promise<CoverFetchResult> {
    return this.coverService.fetchCover(rawIsbn, sourceUrl, title);
  }

  async refreshCover(record: NoteRecord): Promise<CoverFetchResult> {
    return this.coverService.refreshCover(record);
  }

  async searchCalil(rawIsbn: string): Promise<CalilSearchResult> {
    return this.calilService.searchCalil(rawIsbn);
  }
}
