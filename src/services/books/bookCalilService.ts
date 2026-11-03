import type { App } from "obsidian";
import { normalizePath, TFile, TFolder } from "obsidian";
import { BookError } from "../../domain/book";
import {
  CALIL_TIME_DEPENDENT_NOTICE,
  type CalilBranch,
  type CalilLibraryHit,
  type CalilLibraryInfo,
  calilBranchesFromLibraries,
  calilCheckUrl,
  calilContinuePending,
  calilLibrariesFromPayload,
  calilLibraryInfoFromPayload,
  calilLibraryUrl,
  calilSession,
  calilSessionUrl,
  parseCalilLibrarySelection,
  parseCalilPayload,
} from "../../domain/calil";
import type { CalilSummary } from "../../domain/calilStatus";
import { httpStatusHint } from "../../domain/errors";
import { canonicalIsbn, isValidIsbn, normalizeIsbn } from "../../domain/isbn";
import { formatLocalIso } from "../../domain/time";
import type { HttpClient } from "../http";
import type { PropertyService } from "../propertyService";
import type { SeitonSettings } from "../settings";
import type { VaultIndexService } from "../vaultIndex";

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

export interface BookCalilOptions {
  app: App;
  getSettings?: () => Partial<SeitonSettings> | null | undefined;
  http: HttpClient;
  index?: VaultIndexService | null;
  logError?: (context: string, error: unknown) => void;
  now?: () => Date;
  properties: PropertyService;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function bookIoError(
  message: string,
  error: unknown,
  detail?: string
): BookError {
  return new BookError("BOOK_IO", message, detail ?? messageOf(error), error);
}

export class BookCalilService {
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

  constructor(options: BookCalilOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings ?? (() => ({}));
    this.http = options.http;
    this.index = options.index ?? null;
    this.logError = options.logError;
    this.now = options.now ?? (() => new Date());
    this.properties = options.properties;
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

  async saveCalilState(
    path: string,
    isbn: string,
    summary: CalilSummary,
    branches: CalilBranch[]
  ): Promise<void> {
    await this.properties.update(path, {
      calil_checked: summary.checkedAt === "" ? null : summary.checkedAt,
      calil_hits: summary.hits,
      calil_library: summary.library === "" ? null : summary.library,
      calil_state: summary.state,
      calil_total: summary.total,
    });

    const folder = "Seiton/System/Calil";
    await this.ensureFolder(folder);
    const target = normalizePath(`${folder}/${isbn}.json`);
    const payload = `${JSON.stringify({ ...summary, branches }, null, 2)}\n`;
    const existing = this.app.vault.getAbstractFileByPath(target);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, payload);
    } else {
      await this.app.vault.create(target, payload);
    }
    this.index?.invalidate();
  }

  async readCalilDetail(isbn: string): Promise<CalilBranch[] | null> {
    const target = normalizePath(`Seiton/System/Calil/${isbn}.json`);
    const file = this.app.vault.getAbstractFileByPath(target);
    if (!(file instanceof TFile)) {
      return null;
    }
    try {
      const parsed = JSON.parse(await this.app.vault.read(file)) as {
        branches?: unknown;
      };
      return Array.isArray(parsed.branches)
        ? (parsed.branches as CalilBranch[])
        : null;
    } catch {
      return null;
    }
  }

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
          `カーリルの検索に失敗しました。${httpStatusHint(response.status)}。`
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
}
