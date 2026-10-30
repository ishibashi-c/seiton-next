/**
 * 旧Seitonデータの読み取り専用スキャンと、選択項目のコピー変換。
 *
 * - 元ファイルは変更・削除・移動しない。
 * - 変換は新しいファイルの作成、または週次メモへの追記だけを行う。
 * - 既存の新形式ファイルは上書きしない。
 * - 変換済みの記録を変換ログへ追記し、二重取り込みを避ける。
 */

import { MEMOS_FOLDER, MIGRATION_FOLDER, NOTES_FOLDER } from "../config";
import { SeitonError, toSeitonError, userMessageOf } from "../domain/errors";
import {
  bodyAfterFrontmatter,
  frontmatterField,
  scanFrontmatter,
} from "../domain/frontmatter";
import { isValidWeekId } from "../domain/isoWeek";
import {
  appendMemoEntry,
  assertMemoAppendable,
  createMemoLogDocument,
  parseMemoLog,
} from "../domain/memoLog";
import type {
  LegacyClassification,
  LegacyMemoEntry,
  MigrationCategory,
  MigrationEntryIdInput,
  MigrationLogRecord,
  MigrationResultStatus,
  NoteConversionPlan,
} from "../domain/migration";
import {
  appendMigrationLogRecords,
  classifyLegacyDocument,
  contentHash,
  findConvertedMigrationRecord,
  isbnsOf,
  MIGRATION_HASH_KEY,
  MIGRATION_SOURCE_KEY,
  mapLegacyProperties,
  migrationEntryId,
  normalizedBodyForCompare,
  parseLegacyMonthlyMemo,
  parseMigrationLog,
  planLegacyNoteConversion,
  resolveNoteTargetPath,
} from "../domain/migration";
import { sanitizeNoteTitle } from "../domain/notes";
import { formatLocalIso } from "../domain/time";
import { SerialQueue } from "./serialQueue";
import { dirname } from "./vaultPort";

/** Vaultの読み書きに必要な最小限。テストではメモリ実装を注入する。 */
export interface MigrationPort {
  create(path: string, data: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  exists(path: string): boolean;
  /** Vault内のMarkdownパスを列挙する。読み取り専用。 */
  listMarkdown(): Promise<string[]>;
  process(path: string, transform: (data: string) => string): Promise<string>;
  read(path: string): Promise<string>;
}

export interface MigrationServiceOptions {
  entryIdFor?: (input: MigrationEntryIdInput) => string;
  logError?: (context: string, error: unknown) => void;
  logPath?: string;
  memosFolder?: string;
  notesFolder?: string;
  now?: () => Date;
  port: MigrationPort;
}

export type MigrationTargetState =
  | "append"
  | "blocked"
  | "collision"
  | "new"
  | "none";

export interface MigrationCandidate {
  /** 変換ログに変換済みの記録がある */
  alreadyConverted: boolean;
  bookFieldCount: number;
  category: MigrationCategory;
  /** 月次メモの変換対象件数。通常ノートは1 */
  entryCount: number;
  hash: string;
  isbn: string[];
  kind: string;
  month: string;
  needsReview: boolean;
  path: string;
  /** 読み取り専用プレビュー（変換後にできる内容） */
  preview: string;
  reasons: string[];
  /** status: inbox のため、明示選択で review: true にできる */
  reviewSelectable: boolean;
  status: string;
  targetPaths: string[];
  targetState: MigrationTargetState;
  type: string;
  warnings: string[];
}

export interface MigrationProblem {
  message: string;
  path: string;
}

export interface MigrationScanSummary {
  alreadyNew: number;
  legacyMemo: number;
  legacyNote: number;
  scanned: number;
  unsupported: number;
}

export interface MigrationScanResult {
  candidates: MigrationCandidate[];
  logPath: string;
  problems: MigrationProblem[];
  scannedAt: string;
  summary: MigrationScanSummary;
}

export interface ConvertOptions {
  /**
   * 変換済みの元ファイルを再変換するか。
   * 既定は "skip"。内容が同じ場合は "convert" でもスキップする。
   */
  alreadyConverted?: "convert" | "skip";
  /**
   * status: inbox のノートを review: true へ入れる明示選択。
   * 旧 inbox は既定で review にしない。
   */
  reviewPaths?: string[];
}

export interface MigrationItemResult {
  category: MigrationCategory;
  entryCount: number;
  isbn: string[];
  message: string;
  sourceHash: string;
  sourcePath: string;
  status: MigrationResultStatus;
  targetPaths: string[];
}

export interface MigrationReportSummary {
  converted: number;
  failed: number;
  skipped: number;
}

export interface MigrationReport {
  convertedAt: string;
  logPath: string;
  /** 変換ログへ記録できなかった場合の説明。空なら成功 */
  logWriteError: string;
  results: MigrationItemResult[];
  summary: MigrationReportSummary;
}

interface CandidateInput {
  classification: LegacyClassification;
  content: string;
  ledger: MigrationLogRecord[];
  path: string;
  reserved: Set<string>;
  scannedAt: string;
}

interface ConvertContext {
  convertedAt: string;
  ledger: MigrationLogRecord[];
  mode: "convert" | "skip";
  reserved: Set<string>;
  reviewPaths: ReadonlySet<string>;
}

interface MemoTarget {
  /** 既存エントリのIDと本文 */
  existingIds: Map<string, string>;
  problem: string;
}

interface NoteTargetInput {
  hash: string;
  plan: NoteConversionPlan;
  reserved: Set<string>;
  sourcePath: string;
}

interface NoteTargetResolution {
  collision: boolean;
  /** 同じ元ファイルから既に作られているノート（検証して再利用する） */
  existingSameSource: string;
  path: string | null;
}

/** 追記してはいけない構造エラー。preflight で使う。 */
const FATAL_MEMO_DIAGNOSTICS: ReadonlySet<string> = new Set([
  "duplicate-entry",
  "frontmatter-missing",
  "frontmatter-unclosed",
]);

export const MIGRATION_LOG_PATH = `${MIGRATION_FOLDER}/migration-log.md`;

function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/u, "");
}

function singleLine(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, " / ").trim();
}

export class MigrationService {
  private readonly entryIdFor: (input: MigrationEntryIdInput) => string;
  private readonly logError: (context: string, error: unknown) => void;
  private readonly logPathValue: string;
  private readonly memosFolder: string;
  private readonly notesFolder: string;
  private readonly now: () => Date;
  private readonly port: MigrationPort;
  private readonly queue = new SerialQueue();

  constructor(options: MigrationServiceOptions) {
    this.port = options.port;
    this.now = options.now ?? (() => new Date());
    this.notesFolder = options.notesFolder ?? NOTES_FOLDER;
    this.memosFolder = options.memosFolder ?? MEMOS_FOLDER;
    this.logPathValue = options.logPath ?? MIGRATION_LOG_PATH;
    this.entryIdFor = options.entryIdFor ?? migrationEntryId;
    this.logError = options.logError ?? (() => undefined);
  }

  /** 変換ログのVault内パス。 */
  logPath(): string {
    return this.logPathValue;
  }

  /** 週次ファイルのパス。 */
  weekPath(week: string): string {
    if (!isValidWeekId(week)) {
      throw new SeitonError("INVALID_WEEK", `週識別子「${week}」が不正です。`);
    }
    return `${this.memosFolder}/${week}.md`;
  }

  /**
   * 読み取り専用スキャン。候補一覧とプレビューを返し、書込みは一切しない。
   * 既に新形式のファイルと対象外のファイルは件数だけを数える。
   */
  async scan(): Promise<MigrationScanResult> {
    const scannedAt = formatLocalIso(this.now());
    const ledger = await this.readLedger();
    let paths: string[];
    try {
      paths = await this.listMarkdownPaths();
    } catch (error) {
      throw toSeitonError(error, "VaultのMarkdown一覧を取得できませんでした。");
    }
    const candidates: MigrationCandidate[] = [];
    const problems: MigrationProblem[] = [];
    const reserved = new Set<string>();
    const summary: MigrationScanSummary = {
      alreadyNew: 0,
      legacyMemo: 0,
      legacyNote: 0,
      scanned: 0,
      unsupported: 0,
    };

    for (const path of paths) {
      summary.scanned += 1;
      let content: string;
      try {
        content = await this.port.read(path);
      } catch (error) {
        this.logError("scan:read", error);
        problems.push({ message: userMessageOf(error), path });
        continue;
      }

      const classification = classifyLegacyDocument(content);
      if (classification.category === "already-new") {
        summary.alreadyNew += 1;
        continue;
      }
      if (classification.category === "unsupported") {
        summary.unsupported += 1;
        continue;
      }

      const candidate = await this.inspectCandidate({
        classification,
        content,
        ledger,
        path,
        reserved,
        scannedAt,
      });
      if (classification.category === "legacy-memo") {
        summary.legacyMemo += 1;
      } else {
        summary.legacyNote += 1;
      }
      candidates.push(candidate);
      for (const target of candidate.targetPaths) {
        reserved.add(target);
      }
    }

    return {
      candidates,
      logPath: this.logPathValue,
      problems,
      scannedAt,
      summary,
    };
  }

  /**
   * 選択した旧ファイルだけをコピーして新形式へ変換する。
   * 元ファイルは変更しない。既存の新形式ファイルは上書きしない。
   */
  async convert(
    paths: string[],
    options: ConvertOptions = {}
  ): Promise<MigrationReport> {
    return this.queue.run(this.logPathValue, () =>
      this.runConvert(paths, options)
    );
  }

  private async runConvert(
    paths: string[],
    options: ConvertOptions
  ): Promise<MigrationReport> {
    const convertedAt = formatLocalIso(this.now());
    const ledger = [...(await this.readLedger())];
    const unique = [
      ...new Set(paths.filter((path) => path.trim() !== "")),
    ].sort();
    const reviewPaths = new Set(options.reviewPaths ?? []);
    const results: MigrationItemResult[] = [];
    const reserved = new Set<string>();
    let logWriteError = "";

    for (const path of unique) {
      const outcome = await this.convertOne(path, {
        convertedAt,
        ledger,
        mode: options.alreadyConverted ?? "skip",
        reserved,
        reviewPaths,
      });
      results.push(outcome.item);
      for (const target of outcome.item.targetPaths) {
        reserved.add(target);
      }

      const record = this.recordOf(outcome.item, convertedAt, outcome.hash);
      try {
        await this.appendLogRecord(record);
        ledger.push(record);
      } catch (error) {
        this.logError("convert:appendLog", error);
        logWriteError = userMessageOf(error);
        outcome.item.message =
          `${outcome.item.message} 変換ログに記録できませんでした。`.trim();
      }
    }

    const summary: MigrationReportSummary = {
      converted: 0,
      failed: 0,
      skipped: 0,
    };
    for (const result of results) {
      summary[result.status] += 1;
    }

    return {
      convertedAt,
      logPath: this.logPathValue,
      logWriteError,
      results,
      summary,
    };
  }

  private async convertOne(
    path: string,
    context: ConvertContext
  ): Promise<{ hash: string; item: MigrationItemResult }> {
    if (!this.port.exists(path)) {
      return {
        hash: "",
        item: this.failedItem(
          path,
          "legacy-note",
          "元ファイルが見つかりませんでした。",
          ""
        ),
      };
    }

    let content: string;
    try {
      content = await this.port.read(path);
    } catch (error) {
      this.logError("convert:read", error);
      return {
        hash: "",
        item: this.failedItem(path, "legacy-note", userMessageOf(error), ""),
      };
    }

    const hash = contentHash(content);
    const classification = classifyLegacyDocument(content);
    if (
      classification.category !== "legacy-note" &&
      classification.category !== "legacy-memo"
    ) {
      return {
        hash,
        item: this.failedItem(
          path,
          classification.category,
          classification.reason === ""
            ? "旧形式の対象ではないため変換しません。"
            : classification.reason,
          hash
        ),
      };
    }

    const previous = findConvertedMigrationRecord(context.ledger, path);
    if (previous) {
      if (context.mode === "skip") {
        return {
          hash,
          item: this.skippedItem(
            path,
            classification.category,
            previous,
            "前回の変換記録があるためスキップしました。内容を変えて再変換するには「変換済みも再変換する」を有効にしてください。",
            hash
          ),
        };
      }
      if (previous.sourceHash === hash) {
        return {
          hash,
          item: this.skippedItem(
            path,
            classification.category,
            previous,
            "前回の変換から内容が変わっていないためスキップしました。",
            hash
          ),
        };
      }
    }

    if (classification.category === "legacy-memo") {
      return this.convertMemo(path, content, hash);
    }
    const review =
      context.reviewPaths.has(path) &&
      classification.status.trim().toLowerCase() === "inbox";
    return this.convertNote(path, content, hash, context, review);
  }

  private async convertNote(
    path: string,
    content: string,
    hash: string,
    context: ConvertContext,
    review: boolean
  ): Promise<{ hash: string; item: MigrationItemResult }> {
    const plan = planLegacyNoteConversion({
      content,
      convertedAt: context.convertedAt,
      review,
      sourceHash: hash,
      sourcePath: path,
    });
    if (!plan.ok) {
      return {
        hash,
        item: this.failedItem(path, "legacy-note", plan.reason, hash),
      };
    }

    const target = await this.resolveNoteTarget({
      hash,
      plan: plan.plan,
      reserved: context.reserved,
      sourcePath: path,
    });

    if (target.existingSameSource !== "") {
      const problem = await this.verifyNote(
        target.existingSameSource,
        path,
        plan.plan,
        content,
        hash
      );
      if (problem === "") {
        return {
          hash,
          item: {
            category: "legacy-note",
            entryCount: 1,
            isbn: plan.plan.isbn,
            message:
              "前回の変換で作成済みのノートを確認しました。再作成しません。",
            sourceHash: hash,
            sourcePath: path,
            status: "skipped",
            targetPaths: [target.existingSameSource],
          },
        };
      }
      return {
        hash,
        item: this.failedItem(
          path,
          "legacy-note",
          `既存の変換先ノートを検証できませんでした（${target.existingSameSource}: ${problem}）。手動で確認してください。`,
          hash,
          [target.existingSameSource]
        ),
      };
    }

    if (target.path === null) {
      return {
        hash,
        item: this.failedItem(
          path,
          "legacy-note",
          "空いている変換先パスが見つかりませんでした。",
          hash
        ),
      };
    }
    if (target.path === path) {
      return {
        hash,
        item: this.failedItem(
          path,
          "legacy-note",
          "変換先が元ファイルと同じパスのため中止しました。",
          hash
        ),
      };
    }

    try {
      await this.port.ensureFolder(dirname(target.path));
      await this.port.create(target.path, plan.plan.document);
    } catch (error) {
      this.logError("convertNote:create", error);
      return {
        hash,
        item: this.failedItem(
          path,
          "legacy-note",
          `新規ノートを作成できませんでした（${target.path}）。既存ファイルは上書きしていません。`,
          hash,
          [target.path]
        ),
      };
    }

    const problem = await this.verifyNote(
      target.path,
      path,
      plan.plan,
      content,
      hash
    );
    if (problem !== "") {
      return {
        hash,
        item: this.failedItem(
          path,
          "legacy-note",
          `新規ノートの検証に失敗しました（${target.path}: ${problem}）。作成済みのファイルを確認してください。`,
          hash,
          [target.path]
        ),
      };
    }

    return {
      hash,
      item: {
        category: "legacy-note",
        entryCount: 1,
        isbn: plan.plan.isbn,
        message: singleLine(plan.plan.warnings.join(" / ")),
        sourceHash: hash,
        sourcePath: path,
        status: "converted",
        targetPaths: [target.path],
      },
    };
  }

  private async convertMemo(
    path: string,
    content: string,
    hash: string
  ): Promise<{ hash: string; item: MigrationItemResult }> {
    const parsed = parseLegacyMonthlyMemo(content, {
      createEntryId: this.entryIdFor,
      sourcePath: path,
    });
    const fatal = parsed.diagnostics.find(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        FATAL_MEMO_DIAGNOSTICS.has(diagnostic.code)
    );
    if (fatal) {
      return {
        hash,
        item: this.failedItem(
          path,
          "legacy-memo",
          `月次メモを安全に変換できません（${fatal.line}行目: ${fatal.message}）。`,
          hash
        ),
      };
    }
    if (parsed.entries.length === 0) {
      return {
        hash,
        item: this.failedItem(
          path,
          "legacy-memo",
          "変換できるメモ行が見つかりませんでした。",
          hash
        ),
      };
    }

    const groups = new Map<string, LegacyMemoEntry[]>();
    for (const entry of parsed.entries) {
      const group = groups.get(entry.week) ?? [];
      group.push(entry);
      groups.set(entry.week, group);
    }
    const weeks = [...groups.keys()].sort();
    const targetPaths = weeks.map((week) => this.weekPath(week));
    const targets = new Map<string, MemoTarget>();

    for (const week of weeks) {
      const targetPath = this.weekPath(week);
      const target = await this.inspectMemoTarget(targetPath, week);
      if (target.problem !== "") {
        return {
          hash,
          item: this.failedItem(
            path,
            "legacy-memo",
            `週次ファイルを安全に追記できません（${targetPath}: ${target.problem}）。`,
            hash,
            targetPaths
          ),
        };
      }
      const entries = groups.get(week) ?? [];
      const conflict = entries.find((entry) => {
        const existingBody = target.existingIds.get(entry.id);
        return existingBody !== undefined && existingBody !== entry.body;
      });
      if (conflict) {
        return {
          hash,
          item: this.failedItem(
            path,
            "legacy-memo",
            `同じIDで本文の違うエントリが既にあります（${targetPath}）。上書きしません。`,
            hash,
            targetPaths
          ),
        };
      }
      targets.set(week, target);
    }

    const writtenWeeks: string[] = [];
    let writtenEntries = 0;
    try {
      for (const week of weeks) {
        const targetPath = this.weekPath(week);
        const target = targets.get(week);
        const entries = groups.get(week) ?? [];
        const missing = entries.filter(
          (entry) => !(target?.existingIds.has(entry.id) ?? false)
        );
        if (missing.length === 0) {
          continue;
        }
        if (this.port.exists(targetPath)) {
          await this.port.process(targetPath, (data) =>
            this.appendEntries(data, missing)
          );
        } else {
          await this.createMemoWeek(targetPath, week, missing);
        }
        writtenWeeks.push(week);
        writtenEntries += missing.length;
      }
    } catch (error) {
      this.logError("convertMemo:write", error);
      const partial =
        writtenWeeks.length > 0
          ? "追記済みの週は残っています。再実行すると未追記分だけ追加します。"
          : "";
      return {
        hash,
        item: this.failedItem(
          path,
          "legacy-memo",
          `週次ファイルへの追記に失敗しました。${partial}`,
          hash,
          targetPaths
        ),
      };
    }

    if (writtenEntries === 0) {
      return {
        hash,
        item: {
          category: "legacy-memo",
          entryCount: parsed.entries.length,
          isbn: [],
          message:
            "同じメモが既に週次ファイルへ取り込まれているため、追加しませんでした。",
          sourceHash: hash,
          sourcePath: path,
          status: "skipped",
          targetPaths,
        },
      };
    }

    for (const week of weeks) {
      const problem = await this.verifyMemoWeek(
        this.weekPath(week),
        week,
        groups.get(week) ?? []
      );
      if (problem !== "") {
        return {
          hash,
          item: this.failedItem(
            path,
            "legacy-memo",
            `週次ファイルの検証に失敗しました（${this.weekPath(
              week
            )}: ${problem}）。再実行すると未追記分だけ追加します。`,
            hash,
            targetPaths
          ),
        };
      }
    }

    const warnings = parsed.diagnostics
      .filter((diagnostic) => diagnostic.severity === "warning")
      .map((diagnostic) => `${diagnostic.line}行目: ${diagnostic.message}`);

    return {
      hash,
      item: {
        category: "legacy-memo",
        entryCount: parsed.entries.length,
        isbn: [],
        message: singleLine(warnings.join(" / ")),
        sourceHash: hash,
        sourcePath: path,
        status: "converted",
        targetPaths,
      },
    };
  }

  private async inspectCandidate(
    input: CandidateInput
  ): Promise<MigrationCandidate> {
    const mapping = mapLegacyProperties(scanFrontmatter(input.content).fields);
    const previous = findConvertedMigrationRecord(input.ledger, input.path);
    const hash = contentHash(input.content);
    const reasons: string[] = [];
    if (previous) {
      reasons.push(
        previous.sourceHash === hash
          ? "前回の変換で作成済みです。既定では再変換しません。"
          : "前回の変換後に内容が変わっています。再変換するには明示的に選択してください。"
      );
    }
    const isMonthly = input.classification.category === "legacy-memo";
    if (!isMonthly) {
      reasons.push(...mapping.reviewReasons);
    }

    const base: MigrationCandidate = {
      alreadyConverted: previous !== null,
      bookFieldCount: Object.keys(mapping.book).length,
      category: input.classification.category,
      entryCount: 0,
      hash,
      isbn: isbnsOf(mapping),
      kind: isMonthly ? "memo-log" : mapping.kind,
      month: mapping.month,
      needsReview: isMonthly ? false : mapping.needsReview,
      path: input.path,
      preview: input.content,
      reasons,
      reviewSelectable:
        !isMonthly && input.classification.status.toLowerCase() === "inbox",
      status: input.classification.status,
      targetPaths: [],
      targetState: "none",
      type: input.classification.type,
      warnings: [...mapping.warnings],
    };

    if (input.classification.category === "legacy-memo") {
      return this.inspectMemoCandidate(input, base);
    }
    return this.inspectNoteCandidate(input, base);
  }

  private async inspectNoteCandidate(
    input: CandidateInput,
    base: MigrationCandidate
  ): Promise<MigrationCandidate> {
    const plan = planLegacyNoteConversion({
      content: input.content,
      convertedAt: input.scannedAt,
      sourcePath: input.path,
    });
    if (!plan.ok) {
      return {
        ...base,
        reasons: [...base.reasons, plan.reason],
        targetState: "blocked",
      };
    }

    const target = await this.resolveNoteTarget({
      hash: base.hash,
      plan: plan.plan,
      reserved: input.reserved,
      sourcePath: input.path,
    });
    const existing = target.existingSameSource !== "";
    const reasons = [...base.reasons];
    if (existing) {
      reasons.push("同じ元ファイルから作成済みのノートがあります。");
    }
    if (target.path === null) {
      reasons.push("空いている変換先パスが見つかりませんでした。");
    }

    let targetState: MigrationTargetState = "new";
    if (target.path === null) {
      targetState = "blocked";
    } else if (existing) {
      targetState = "none";
    } else if (target.collision) {
      targetState = "collision";
    }

    return {
      ...base,
      alreadyConverted: base.alreadyConverted || existing,
      entryCount: 1,
      preview: plan.plan.document,
      reasons,
      targetPaths: existing
        ? [target.existingSameSource]
        : target.path
          ? [target.path]
          : [],
      targetState,
      warnings: [...base.warnings, ...plan.plan.warnings],
    };
  }

  private async inspectMemoCandidate(
    input: CandidateInput,
    base: MigrationCandidate
  ): Promise<MigrationCandidate> {
    const parsed = parseLegacyMonthlyMemo(input.content, {
      createEntryId: this.entryIdFor,
      sourcePath: input.path,
    });
    const targetPaths = parsed.weeks.map((week) => this.weekPath(week));
    const fatal = parsed.diagnostics.find(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        FATAL_MEMO_DIAGNOSTICS.has(diagnostic.code)
    );
    const reasons = [...base.reasons];
    const warnings = [...base.warnings];
    for (const diagnostic of parsed.diagnostics) {
      const message = `${diagnostic.line}行目: ${diagnostic.message}`;
      if (diagnostic.severity === "error") {
        reasons.push(message);
      } else {
        warnings.push(message);
      }
    }

    let blocked = fatal !== undefined || parsed.entries.length === 0;
    if (parsed.entries.length === 0 && !fatal) {
      reasons.push("変換できるメモ行が見つかりませんでした。");
    }
    let anyExisting = false;
    for (const week of parsed.weeks) {
      const target = await this.inspectMemoTarget(this.weekPath(week), week);
      if (target.problem !== "") {
        blocked = true;
        reasons.push(`${week}: ${target.problem}`);
      }
      if (target.existingIds.size > 0) {
        anyExisting = true;
      }
    }

    return {
      ...base,
      entryCount: parsed.entries.length,
      preview: this.memoPreview(input.path, parsed.entries, warnings, reasons),
      reasons,
      targetPaths,
      targetState: blocked ? "blocked" : anyExisting ? "append" : "new",
      warnings,
    };
  }

  private memoPreview(
    sourcePath: string,
    entries: LegacyMemoEntry[],
    warnings: string[],
    reasons: string[]
  ): string {
    const lines = [`### 変換プレビュー: ${sourcePath}`, ""];
    let currentWeek = "";
    for (const entry of entries) {
      if (entry.week !== currentWeek) {
        lines.push("", `## ${entry.week}`, "");
        currentWeek = entry.week;
      }
      const date = entry.at.slice(0, 10);
      const clock = entry.at.slice(11, 16);
      lines.push(`- ${date} ${clock}  ${entry.body.replace(/\n/gu, "\n  ")}`);
    }
    if (warnings.length > 0) {
      lines.push("", "### 警告", "");
      for (const warning of warnings) {
        lines.push(`- ${warning}`);
      }
    }
    if (reasons.length > 0) {
      lines.push("", "### 要確認", "");
      for (const reason of reasons) {
        lines.push(`- ${reason}`);
      }
    }
    return lines.join("\n");
  }

  private async resolveNoteTarget(
    input: NoteTargetInput
  ): Promise<NoteTargetResolution> {
    const basename = basenameOf(input.sourcePath);
    const base = `${this.notesFolder}/${sanitizeNoteTitle(basename)}.md`;
    const occupied = (candidate: string): boolean =>
      input.reserved.has(candidate) || this.port.exists(candidate);

    if (this.port.exists(base)) {
      try {
        const existing = await this.port.read(base);
        const owner = frontmatterField(existing, MIGRATION_SOURCE_KEY);
        const storedHash = frontmatterField(existing, MIGRATION_HASH_KEY);
        if (owner === input.sourcePath && storedHash === input.hash) {
          return {
            collision: false,
            existingSameSource: base,
            path: base,
          };
        }
      } catch (error) {
        this.logError("resolveNoteTarget:read", error);
      }
    }

    const path = resolveNoteTargetPath({
      basename,
      exists: occupied,
      notesFolder: this.notesFolder,
      sourcePath: input.sourcePath,
    });
    return {
      collision: path !== null && path !== base,
      existingSameSource: "",
      path,
    };
  }

  private async inspectMemoTarget(
    path: string,
    week: string
  ): Promise<MemoTarget> {
    if (!this.port.exists(path)) {
      return { existingIds: new Map(), problem: "" };
    }
    let content: string;
    try {
      content = await this.port.read(path);
    } catch (error) {
      this.logError("inspectMemoTarget:read", error);
      return {
        existingIds: new Map(),
        problem: "読み込めませんでした。",
      };
    }
    if (content.trim() === "") {
      return {
        existingIds: new Map(),
        problem: "空のファイルがあるため追記できません。",
      };
    }

    const parsed = parseMemoLog(content);
    if (parsed.frontmatter.fields.kind !== "memo-log") {
      return {
        existingIds: new Map(),
        problem: `Seitonの週次メモではありません（kind: ${
          parsed.frontmatter.fields.kind ?? "なし"
        }）。`,
      };
    }
    if (parsed.frontmatter.fields.week !== week) {
      return {
        existingIds: new Map(),
        problem: `week（${parsed.frontmatter.fields.week ?? "なし"}）が ${
          week
        } と一致しません。`,
      };
    }
    try {
      assertMemoAppendable(parsed);
    } catch (error) {
      return {
        existingIds: new Map(),
        problem: userMessageOf(error),
      };
    }

    const existingIds = new Map<string, string>();
    for (const entry of parsed.entries) {
      existingIds.set(entry.id, entry.body);
    }
    return { existingIds, problem: "" };
  }

  private appendEntries(content: string, entries: LegacyMemoEntry[]): string {
    let output = content;
    for (const entry of entries) {
      output = appendMemoEntry(output, {
        at: entry.at,
        body: entry.body,
        id: entry.id,
      });
    }
    return output;
  }

  private async createMemoWeek(
    path: string,
    week: string,
    entries: LegacyMemoEntry[]
  ): Promise<void> {
    const first = entries[0];
    if (!first) {
      return;
    }
    await this.port.ensureFolder(this.memosFolder);
    const document = this.appendEntries(
      createMemoLogDocument(week, first.at),
      entries
    );
    try {
      await this.port.create(path, document);
    } catch (error) {
      if (!this.port.exists(path)) {
        throw error;
      }
      await this.port.process(path, (data) =>
        this.appendEntries(data, entries)
      );
    }
  }

  private async verifyNote(
    targetPath: string,
    sourcePath: string,
    plan: NoteConversionPlan,
    sourceContent: string,
    hash: string
  ): Promise<string> {
    let created: string;
    try {
      created = await this.port.read(targetPath);
    } catch (error) {
      this.logError("verifyNote:read", error);
      return "作成したノートを読み戻せませんでした。";
    }
    const scan = scanFrontmatter(created);
    if (!(scan.present && scan.closed)) {
      return "frontmatter を確認できませんでした。";
    }
    const kind = scan.fields.kind ?? "";
    if (kind !== plan.kind) {
      return `kind が一致しません（${kind === "" ? "なし" : kind}）。`;
    }
    if ((scan.fields[MIGRATION_SOURCE_KEY] ?? "") !== sourcePath) {
      return "移行元の記録が一致しません。";
    }
    if ((scan.fields[MIGRATION_HASH_KEY] ?? "") !== hash) {
      return "元ハッシュが一致しません。";
    }
    const rawIsbn = scan.fields.book_isbn ?? "";
    const actualIsbn = rawIsbn === "" ? [] : [rawIsbn];
    if (actualIsbn.join("\u0000") !== plan.isbn.join("\u0000")) {
      return "ISBN が一致しません。";
    }
    if (
      plan.book.book_cover !== undefined &&
      (scan.fields.book_cover ?? "") !== plan.book.book_cover
    ) {
      return "表紙のパスが一致しません。";
    }
    if (plan.archived && scan.fields.archived !== "true") {
      return "archived が引き継がれていません。";
    }
    if (plan.review && scan.fields.review !== "true") {
      return "review が引き継がれていません。";
    }
    const sourceBody = normalizedBodyForCompare(
      bodyAfterFrontmatter(sourceContent)
    );
    const targetBody = normalizedBodyForCompare(bodyAfterFrontmatter(created));
    if (sourceBody !== targetBody) {
      return "本文が元ファイルと一致しません。";
    }
    return "";
  }

  private async verifyMemoWeek(
    targetPath: string,
    week: string,
    expected: LegacyMemoEntry[]
  ): Promise<string> {
    let content: string;
    try {
      content = await this.port.read(targetPath);
    } catch (error) {
      this.logError("verifyMemoWeek:read", error);
      return "週次ファイルを読み戻せませんでした。";
    }
    const parsed = parseMemoLog(content);
    if (parsed.frontmatter.fields.week !== week) {
      return "week が一致しません。";
    }
    const duplicate = parsed.diagnostics.find(
      (diagnostic) => diagnostic.code === "duplicate-id"
    );
    if (duplicate) {
      return "IDが重複しています。";
    }
    const byId = new Map(parsed.entries.map((entry) => [entry.id, entry]));
    for (const entry of expected) {
      const actual = byId.get(entry.id);
      if (!actual) {
        return `ID ${entry.id} のエントリがありません。`;
      }
      if (actual.body !== entry.body) {
        return `ID ${entry.id} の本文が一致しません。`;
      }
      if (actual.at !== entry.at) {
        return `ID ${entry.id} の日時が一致しません。`;
      }
    }
    return "";
  }

  private recordOf(
    item: MigrationItemResult,
    convertedAt: string,
    hash: string
  ): MigrationLogRecord {
    return {
      convertedAt,
      entryCount: item.entryCount,
      isbn: item.isbn,
      message: item.message,
      result: item.status,
      sourceHash: hash === "" ? item.sourceHash : hash,
      sourcePath: item.sourcePath,
      targetPaths: item.targetPaths,
    };
  }

  private failedItem(
    sourcePath: string,
    category: MigrationCategory,
    message: string,
    hash: string,
    targetPaths: string[] = []
  ): MigrationItemResult {
    return {
      category,
      entryCount: 0,
      isbn: [],
      message,
      sourceHash: hash,
      sourcePath,
      status: "failed",
      targetPaths,
    };
  }

  private skippedItem(
    sourcePath: string,
    category: MigrationCategory,
    previous: MigrationLogRecord,
    message: string,
    hash: string
  ): MigrationItemResult {
    return {
      category,
      entryCount: previous.entryCount,
      isbn: previous.isbn,
      message,
      sourceHash: hash,
      sourcePath,
      status: "skipped",
      targetPaths: previous.targetPaths,
    };
  }

  private async listMarkdownPaths(): Promise<string[]> {
    const paths = await this.port.listMarkdown();
    const unique = new Set<string>();
    for (const path of paths) {
      const normalized = path.replace(/^\/+/u, "");
      if (normalized.endsWith(".md")) {
        unique.add(normalized);
      }
    }
    return [...unique].sort();
  }

  private async readLedger(): Promise<MigrationLogRecord[]> {
    try {
      if (!this.port.exists(this.logPathValue)) {
        return [];
      }
      return parseMigrationLog(await this.port.read(this.logPathValue));
    } catch (error) {
      this.logError("readLedger", error);
      return [];
    }
  }

  private async appendLogRecord(record: MigrationLogRecord): Promise<void> {
    if (this.port.exists(this.logPathValue)) {
      await this.port.process(this.logPathValue, (data) =>
        appendMigrationLogRecords(data, [record])
      );
      return;
    }

    await this.port.ensureFolder(dirname(this.logPathValue));
    try {
      await this.port.create(
        this.logPathValue,
        appendMigrationLogRecords("", [record], {
          headerAt: record.convertedAt,
        })
      );
    } catch (error) {
      if (!this.port.exists(this.logPathValue)) {
        throw error;
      }
      await this.port.process(this.logPathValue, (data) =>
        appendMigrationLogRecords(data, [record])
      );
    }
  }
}
