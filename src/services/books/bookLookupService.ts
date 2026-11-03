import { type BookCandidate, BookError } from "../../domain/book";
import { httpStatusHint } from "../../domain/errors";
import {
  BOOK_FIELDS,
  googleBooksCandidate,
  googleBooksSearchUrl,
} from "../../domain/googleBooks";
import { canonicalIsbn, isValidIsbn, normalizeIsbn } from "../../domain/isbn";
import { bookCandidateFromOpenBd, openBdLookupUrl } from "../../domain/openBd";
import {
  bookCandidateFromOpenLibrary,
  openLibraryAuthorKeys,
  openLibraryAuthorUrl,
  openLibraryEditionUrl,
} from "../../domain/openLibrary";
import { formatLocalIso } from "../../domain/time";
import type { HttpClient } from "../http";
import type { SeitonSettings } from "../settings";

export interface BookLookupAttempt {
  message: string;
  source: "googlebooks" | "openbd" | "openlibrary";
  status: "empty" | "error" | "ok";
}

export interface BookLookupResult {
  attempts: BookLookupAttempt[];
  candidate: BookCandidate | null;
  isbn: string;
  lookedUpAt: string;
}

export interface BookLookupOptions {
  getSettings?: () => Partial<SeitonSettings> | null | undefined;
  http: HttpClient;
  logError?: (context: string, error: unknown) => void;
  now?: () => Date;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function jsonText(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw.trim() : "";
}

export class BookLookupService {
  private readonly http: HttpClient;
  private readonly getSettings: () =>
    | Partial<SeitonSettings>
    | null
    | undefined;
  private readonly logError:
    | ((context: string, error: unknown) => void)
    | undefined;
  private readonly now: () => Date;

  constructor(options: BookLookupOptions) {
    this.http = options.http;
    this.getSettings = options.getSettings ?? (() => ({}));
    this.logError = options.logError;
    this.now = options.now ?? (() => new Date());
  }

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

    const google = await this.lookupGoogle(isbn, attempts);
    if (google) {
      return { attempts, candidate: google, isbn, lookedUpAt };
    }

    const openBd = await this.lookupOpenBd(isbn, attempts);
    if (openBd) {
      return { attempts, candidate: openBd, isbn, lookedUpAt };
    }

    const openLibrary = await this.lookupOpenLibrary(isbn, attempts);
    return { attempts, candidate: openLibrary, isbn, lookedUpAt };
  }

  private async lookupGoogle(
    isbn: string,
    attempts: BookLookupAttempt[]
  ): Promise<BookCandidate | null> {
    const apiKey = (this.getSettings?.()?.googleBooksApiKey ?? "").trim();
    if (apiKey === "") {
      return null;
    }
    try {
      const response = await this.http.get(
        googleBooksSearchUrl(`isbn:${isbn}`, apiKey, "JP", 5, BOOK_FIELDS)
      );
      if (response.status !== 200) {
        attempts.push({
          message: httpStatusHint(response.status),
          source: "googlebooks",
          status: "error",
        });
        return null;
      }
      const found = googleBooksCandidate(response.json, isbn);
      if (!found) {
        attempts.push({
          message: "登録がありませんでした",
          source: "googlebooks",
          status: "empty",
        });
        return null;
      }
      return {
        authors: found.authors,
        category: "",
        coverUrl: found.coverUrl,
        isbn,
        published: found.published,
        publisher: found.publisher,
        series: "",
        source: "googlebooks",
        title: found.title,
        volume: "",
      };
    } catch (error) {
      attempts.push({
        message: httpStatusHint(0),
        source: "googlebooks",
        status: "error",
      });
      this.logError?.("book.googleBooksLookup", error);
      return null;
    }
  }

  private async lookupOpenBd(
    isbn: string,
    attempts: BookLookupAttempt[]
  ): Promise<BookCandidate | null> {
    try {
      const response = await this.http.get(openBdLookupUrl(isbn));
      if (response.status !== 200) {
        attempts.push({
          message: httpStatusHint(response.status),
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
          message: httpStatusHint(response.status),
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
}
