import type { App } from "obsidian";
import { normalizePath, TFile, TFolder } from "obsidian";
import {
  BOOK_COVERS_FOLDER,
  bookCoverPath,
  MAX_COVER_BYTES,
} from "../../domain/book";
import type { ImageStats } from "../../domain/coverQuality";
import {
  isLikelyPlaceholder,
  isPlaceholderHash,
} from "../../domain/coverQuality";
import { httpStatusHint } from "../../domain/errors";
import {
  googleBooksCoverUrl,
  googleBooksSearchUrl,
} from "../../domain/googleBooks";
import { isValidIsbn, normalizeIsbn } from "../../domain/isbn";
import { isAllowedRemoteUrl } from "../../domain/network";
import { openLibraryCoverUrl } from "../../domain/openLibrary";
import { type HttpClient, headerValue } from "../http";
import type { SeitonSettings } from "../settings";
import type { NoteRecord } from "../vaultIndex";

export interface CoverFetchResult {
  bytes: number;
  downloaded: boolean;
  error: string | null;
  path: string;
}

export interface BookCoverOptions {
  app: App;
  getSettings?: () => Partial<SeitonSettings> | null | undefined;
  http: HttpClient;
  logError?: (context: string, error: unknown) => void;
  renderPlaceholderCover?: (input: {
    author: string;
    title: string;
  }) => Promise<ArrayBuffer | null>;
  updateBook: (path: string, patch: { cover?: string | null }) => Promise<void>;
}

const MIN_COVER_BYTES = 500;
const COVER_PLACEHOLDER_ERROR =
  "表紙が見つかりませんでした（提供元の代替画像のため保存しません）。";

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function measureImageStats(
  buffer: ArrayBuffer
): Promise<ImageStats | null> {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    return null;
  }
  const url = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("decode failed"));
      element.src = url;
    });
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    let sum = 0;
    let sumSquares = 0;
    let saturation = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index] ?? 0;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luminance;
      sumSquares += luminance * luminance;
      saturation += max === 0 ? 0 : (max - min) / max;
      count += 1;
    }
    if (count === 0) {
      return null;
    }
    const mean = sum / count;
    return {
      saturation: saturation / count,
      stddev: Math.sqrt(Math.max(0, sumSquares / count - mean * mean)),
    };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class BookCoverService {
  private readonly app: App;
  private readonly getSettings: () =>
    | Partial<SeitonSettings>
    | null
    | undefined;
  private readonly http: HttpClient;
  private readonly logError:
    | ((context: string, error: unknown) => void)
    | undefined;
  private readonly renderPlaceholderCover:
    | ((input: {
        author: string;
        title: string;
      }) => Promise<ArrayBuffer | null>)
    | undefined;
  private readonly updateBookRecord: (
    path: string,
    patch: { cover?: string | null }
  ) => Promise<void>;

  constructor(options: BookCoverOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings ?? (() => ({}));
    this.http = options.http;
    this.logError = options.logError;
    this.renderPlaceholderCover = options.renderPlaceholderCover;
    this.updateBookRecord = options.updateBook;
  }

  async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (normalized === "" || normalized === "/") {
      return;
    }
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) {
      return;
    }
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      const file = this.app.vault.getAbstractFileByPath(current);
      if (!file) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async applyPlaceholderCover(record: NoteRecord): Promise<boolean> {
    const isbn = record.book.book_isbn ?? "";
    if (isbn === "") {
      return false;
    }
    const path = await this.writePlaceholderCover(
      isbn,
      record.title,
      record.book.book_author ?? ""
    );
    if (path === "") {
      return false;
    }
    await this.updateBookRecord(record.path, { cover: path });
    return true;
  }

  async writePlaceholderCover(
    isbn: string,
    title: string,
    author: string
  ): Promise<string> {
    if (!this.renderPlaceholderCover) {
      return "";
    }
    try {
      const bytes = await this.renderPlaceholderCover({ author, title });
      if (bytes === null) {
        return "";
      }
      const path = bookCoverPath(isbn);
      await this.ensureFolder(BOOK_COVERS_FOLDER);
      const target = normalizePath(path);
      const existing = this.app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, bytes);
      } else {
        await this.app.vault.createBinary(target, bytes);
      }
      return path;
    } catch (error) {
      this.logError?.("book.placeholderCover", error);
      return "";
    }
  }

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
          error: `表紙を取得できませんでした。${httpStatusHint(response.status)}。`,
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

      const buffer = response.arrayBuffer;
      if (isPlaceholderHash(await sha256Hex(buffer))) {
        return {
          bytes,
          downloaded: false,
          error: COVER_PLACEHOLDER_ERROR,
          path,
        };
      }
      const stats = await measureImageStats(buffer);
      if (stats && isLikelyPlaceholder(stats)) {
        return {
          bytes,
          downloaded: false,
          error: COVER_PLACEHOLDER_ERROR,
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

  async refreshCover(record: NoteRecord): Promise<CoverFetchResult> {
    const isbn = record.book.book_isbn ?? "";
    const result = await this.fetchCover(isbn, undefined, record.title);
    if (result.downloaded) {
      await this.updateBookRecord(record.path, { cover: result.path });
    }
    return result;
  }
}
