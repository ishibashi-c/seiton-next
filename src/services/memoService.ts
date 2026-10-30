/**
 * 一言メモの保存・取得・編集・ソフト削除・昇格を担う唯一のサービス。
 * PCのホーム、コマンド、モバイルクイックアクションはすべてこのクラスを呼ぶ。
 */

import { MEMOS_FOLDER, memoFilePath, NOTES_FOLDER } from "../config";
import { SeitonError, toSeitonError } from "../domain/errors";
import { bodyAfterFrontmatter, frontmatterField } from "../domain/frontmatter";
import { createMemoId as defaultCreateMemoId } from "../domain/ids";
import { isValidWeekId, weekIdOf } from "../domain/isoWeek";
import type { MemoEntry, MemoState } from "../domain/memoLog";
import {
  appendMemoEntry,
  assertMemoMutable,
  compareMemoEntriesNewestFirst,
  createMemoLogDocument,
  findMemoEntry,
  isMemoVisible,
  parseMemoLog,
  updateMemoEntry,
} from "../domain/memoLog";
import {
  appendPromotionLink,
  buildPromotedNoteDocument,
  isPromotableKind,
  promotedNotePath,
  stripMarkdownExtension,
  titleFromMemoBody,
  withPathSuffix,
} from "../domain/notes";
import { normalizeNewlines } from "../domain/text";
import { dateKeyOf, formatLocalIso } from "../domain/time";
import { SerialQueue } from "./serialQueue";
import type { VaultPort } from "./vaultPort";

export interface MemoServiceOptions {
  createMemoId?: () => string;
  logError?: (context: string, error: unknown) => void;
  now?: () => Date;
  vault: VaultPort;
}

export interface AddMemoResult {
  at: string;
  body: string;
  id: string;
  path: string;
  week: string;
}

export interface MemoListItem {
  entry: MemoEntry;
  path: string;
  week: string;
}

export interface MemoProblem {
  message: string;
  path: string;
}

export interface RecentMemoResult {
  items: MemoListItem[];
  problems: MemoProblem[];
}

export interface PromoteMemoInput {
  id: string;
  kind: string;
  title: string;
  week: string;
}

export interface PromoteMemoResult {
  alreadyPromoted: boolean;
  link: string;
  notePath: string;
  reusedExisting: boolean;
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export class MemoService {
  private readonly vault: VaultPort;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly queue = new SerialQueue();
  private readonly logError: (context: string, error: unknown) => void;

  constructor(options: MemoServiceOptions) {
    this.vault = options.vault;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createMemoId ?? (() => defaultCreateMemoId());
    this.logError = options.logError ?? (() => undefined);
  }

  /** 現在のISO週の保存先（存在しなくてもよい）。 */
  currentWeekPath(): string {
    return memoFilePath(weekIdOf(this.now()));
  }

  weekPath(week: string): string {
    if (!isValidWeekId(week)) {
      throw new SeitonError("INVALID_WEEK", `週識別子「${week}」が不正です。`);
    }
    return memoFilePath(week);
  }

  /**
   * 端末内のVaultへ1件保存する。
   * 成功は「ローカル保存の完了」であり、Dropbox同期の完了ではない。
   */
  async addMemo(text: string): Promise<AddMemoResult> {
    const body = normalizeNewlines(text);
    if (body.trim() === "") {
      throw new SeitonError(
        "EMPTY_MEMO",
        "空のメモは保存しません。何か入力してください。"
      );
    }

    const now = this.now();
    const week = weekIdOf(now);
    const at = formatLocalIso(now);
    const id = this.createId();
    const path = memoFilePath(week);

    return this.queue.run(path, async () => {
      try {
        await this.ensureMemoFile(week, at, path);
        const updated = await this.vault.process(path, (data) => {
          if (data.trim() === "") {
            return appendMemoEntry(createMemoLogDocument(week, at), {
              at,
              body,
              id,
            });
          }
          this.assertMemoFile(data, week, path);
          return appendMemoEntry(data, { at, body, id });
        });

        this.verifyEntry(updated, week, id, body, { state: "active" });
        return { at, body, id, path, week };
      } catch (error) {
        this.logError("addMemo", error);
        throw toSeitonError(
          error,
          "保存に失敗しました。入力内容は残っているので、もう一度試してください。"
        );
      }
    });
  }

  /**
   * 保存先フォルダの週ファイルをすべて列挙し、新しい順に返す。
   * 現在週に依存せず、窓の外の週も読める。
   */
  async listAll(
    options: { includeDeleted?: boolean } = {}
  ): Promise<RecentMemoResult> {
    const includeDeleted = options.includeDeleted ?? false;
    const paths = await this.vault.listMarkdown(MEMOS_FOLDER);
    const items: MemoListItem[] = [];
    const problems: MemoProblem[] = [];

    const perFile = await Promise.all(
      paths.map(async (path) => {
        const localProblems: MemoProblem[] = [];
        const localItems: MemoListItem[] = [];
        try {
          const data = await this.vault.read(path);
          const parsed = parseMemoLog(data);
          const kind = parsed.frontmatter.fields.kind;
          if (kind !== "memo-log") {
            localProblems.push({
              message:
                "Seitonの週次メモではありません（kind: memo-log がありません）。",
              path,
            });
            return { items: localItems, problems: localProblems };
          }

          const fileWeek = parsed.frontmatter.fields.week ?? "";
          const nameWeek = path
            .slice(path.lastIndexOf("/") + 1)
            .replace(/\.md$/u, "");
          if (!isValidWeekId(fileWeek)) {
            localProblems.push({
              message: "week プロパティが週識別子として不正です。",
              path,
            });
            return { items: localItems, problems: localProblems };
          }
          if (fileWeek !== nameWeek) {
            localProblems.push({
              message: `week（${fileWeek}）がファイル名（${nameWeek}）と一致しません。`,
              path,
            });
            return { items: localItems, problems: localProblems };
          }

          const firstError = parsed.diagnostics.find(
            (diagnostic) => diagnostic.severity === "error"
          );
          if (firstError) {
            localProblems.push({
              message: `${firstError.line}行目: ${firstError.message}`,
              path,
            });
          }

          for (const entry of parsed.entries) {
            localItems.push({ entry, path, week: fileWeek });
          }
          return { items: localItems, problems: localProblems };
        } catch (error) {
          this.logError("listAll", error);
          localProblems.push({
            message:
              error instanceof Error
                ? error.message
                : "週次メモを読み込めませんでした。",
            path,
          });
          return { items: localItems, problems: localProblems };
        }
      })
    );

    for (const fileResult of perFile) {
      items.push(...fileResult.items);
      problems.push(...fileResult.problems);
    }

    const visible = includeDeleted
      ? items
      : items.filter((item) => isMemoVisible(item.entry));

    visible.sort((left, right) =>
      compareMemoEntriesNewestFirst(left.entry, right.entry)
    );

    return { items: visible, problems };
  }

  /** 1件の本文を更新する。他の項目の文字列は変更しない。 */
  async updateMemoBody(
    week: string,
    id: string,
    text: string
  ): Promise<MemoEntry> {
    const body = normalizeNewlines(text);
    if (body.trim() === "") {
      throw new SeitonError(
        "EMPTY_MEMO",
        "空の本文には更新できません。削除する場合は「削除」を使ってください。"
      );
    }
    const path = this.weekPath(week);

    return this.queue.run(path, async () => {
      try {
        const updated = await this.vault.process(path, (data) => {
          this.assertMemoFile(data, week, path);
          return updateMemoEntry(data, id, { body });
        });
        return this.verifyEntry(updated, week, id, body);
      } catch (error) {
        this.logError("updateMemoBody", error);
        throw toSeitonError(
          error,
          "メモの更新に失敗しました。元の内容は残っています。"
        );
      }
    });
  }

  /** ソフト削除 / 復元。本文は消さない。 */
  async setMemoDeleted(
    week: string,
    id: string,
    deleted: boolean
  ): Promise<MemoEntry> {
    const path = this.weekPath(week);
    const timestamp = formatLocalIso(this.now());

    return this.queue.run(path, async () => {
      try {
        let expectedState: MemoState = deleted ? "deleted" : "active";
        const updated = await this.vault.process(path, (data) => {
          this.assertMemoFile(data, week, path);
          const parsed = parseMemoLog(data);
          assertMemoMutable(parsed);
          const entry = findMemoEntry(parsed, id);
          expectedState = deleted
            ? "deleted"
            : entry.promotedTo
              ? "promoted"
              : "active";
          return updateMemoEntry(data, id, {
            deletedAt: deleted ? timestamp : null,
            state: expectedState,
          });
        });
        return this.verifyEntry(updated, week, id, undefined, {
          state: expectedState,
        });
      } catch (error) {
        this.logError("setMemoDeleted", error);
        throw toSeitonError(error, "メモの削除状態を更新できませんでした。");
      }
    });
  }

  /**
   * 一言メモを独立ノートへ昇格する。
   * 1) ノート作成・検証 → 2) 週次メモに state=promoted とリンクを追記。
   * 2が失敗しても元メモは残り、再試行では同じIDのノートを再利用する。
   */
  async promoteMemo(input: PromoteMemoInput): Promise<PromoteMemoResult> {
    if (!isPromotableKind(input.kind)) {
      throw new SeitonError(
        "MEMO_FORMAT",
        "昇格先の種類が不正です。idea / note などを選んでください。"
      );
    }

    const path = this.weekPath(input.week);
    const title = trimmedOrUndefined(input.title);

    return this.queue.run(path, async () => {
      try {
        const current = await this.readDocument(path, input.week);
        const parsed = parseMemoLog(current);
        assertMemoMutable(parsed);
        const entry = findMemoEntry(parsed, input.id);

        if (entry.state === "deleted") {
          throw new SeitonError(
            "MEMO_STATE",
            "削除済みのメモは昇格できません。先に復元してください。"
          );
        }

        if (
          entry.state === "promoted" &&
          entry.promotedTo &&
          this.vault.exists(entry.promotedTo)
        ) {
          const note = await this.vault.read(entry.promotedTo);
          this.assertNoteOwnership(note, entry.id, entry.promotedTo);
          return {
            alreadyPromoted: true,
            link: `[[${stripMarkdownExtension(entry.promotedTo)}]]`,
            notePath: entry.promotedTo,
            reusedExisting: true,
          };
        }

        const noteTitle = title ?? titleFromMemoBody(entry.body);
        const notePath =
          entry.promotedTo ??
          (await this.resolvePromotedNotePath(entry, noteTitle));
        let reusedExisting = false;
        let createdNow = false;

        if (this.vault.exists(notePath)) {
          const existing = await this.vault.read(notePath);
          this.assertNoteOwnership(existing, entry.id, notePath);
          reusedExisting = true;
        } else {
          await this.createPromotedNote(
            notePath,
            input.kind,
            entry,
            formatLocalIso(this.now())
          );
          createdNow = true;
        }

        const noteContent = await this.vault.read(notePath);
        this.assertNoteOwnership(noteContent, entry.id, notePath);
        if (createdNow) {
          this.assertNoteBody(noteContent, entry.body, notePath);
        }

        const link = `[[${stripMarkdownExtension(notePath)}]]`;

        if (entry.state === "promoted" && entry.promotedTo === notePath) {
          return {
            alreadyPromoted: true,
            link,
            notePath,
            reusedExisting: true,
          };
        }

        const bodyWithLink = appendPromotionLink(entry.body, link);
        const updated = await this.vault.process(path, (data) => {
          this.assertMemoFile(data, input.week, path);
          return updateMemoEntry(data, input.id, {
            body: bodyWithLink,
            deletedAt: null,
            promotedTo: notePath,
            state: "promoted",
          });
        });

        this.verifyEntry(updated, input.week, input.id, bodyWithLink, {
          promotedTo: notePath,
          state: "promoted",
        });

        return {
          alreadyPromoted: false,
          link,
          notePath,
          reusedExisting,
        };
      } catch (error) {
        this.logError("promoteMemo", error);
        throw toSeitonError(
          error,
          "独立ノートへの昇格に失敗しました。元のメモは残っています。"
        );
      }
    });
  }

  /** 編集画面などで最新の1件を読み直す。 */
  async readEntry(
    week: string,
    id: string
  ): Promise<{ entry: MemoEntry; path: string; week: string }> {
    const path = this.weekPath(week);
    const data = await this.readDocument(path, week);
    const parsed = parseMemoLog(data);
    return { entry: findMemoEntry(parsed, id), path, week };
  }

  private async ensureMemoFile(
    week: string,
    at: string,
    path: string
  ): Promise<void> {
    if (this.vault.exists(path)) {
      return;
    }
    await this.vault.ensureFolder(MEMOS_FOLDER);
    try {
      await this.vault.create(path, createMemoLogDocument(week, at));
    } catch (error) {
      if (!this.vault.exists(path)) {
        throw error;
      }
    }
  }

  private async readDocument(path: string, week: string): Promise<string> {
    if (!this.vault.exists(path)) {
      throw new SeitonError(
        "MEMO_NOT_FOUND",
        "週次メモのファイルが見つかりませんでした。"
      );
    }
    const data = await this.vault.read(path);
    this.assertMemoFile(data, week, path);
    return data;
  }

  /**
   * 保存先がSeitonの週次メモであることを確認する。
   * 未知のファイルを上書きしないための門番。
   */
  private assertMemoFile(data: string, week: string, path: string): void {
    if (data.trim() === "") {
      return;
    }

    const parsed = parseMemoLog(data);
    if (!(parsed.frontmatter.present && parsed.frontmatter.closed)) {
      throw new SeitonError(
        "FOREIGN_FILE",
        `${path} の frontmatter を確認できないため、上書きを中止しました。`
      );
    }

    const kind = parsed.frontmatter.fields.kind;
    if (kind !== "memo-log") {
      throw new SeitonError(
        "FOREIGN_FILE",
        `${path} はSeitonの週次メモではありません（kind: ${kind ?? "なし"}）。上書きを中止しました。`
      );
    }

    const fileWeek = parsed.frontmatter.fields.week;
    if (fileWeek === undefined || fileWeek === "") {
      throw new SeitonError(
        "MEMO_FORMAT",
        `${path} に week プロパティがありません。上書きを中止しました。`
      );
    }
    if (fileWeek !== week) {
      throw new SeitonError(
        "MEMO_FORMAT",
        `${path} の week（${fileWeek}）が保存先（${week}）と一致しません。上書きを中止しました。`
      );
    }
  }

  /**
   * 書き込み後の読み戻し検証。件数・ID・本文・状態を確認する。
   * 失敗しても既にファイルへ書かれている可能性があるため、UIは「確認してください」と表示する。
   */
  private verifyEntry(
    data: string,
    week: string,
    id: string,
    body: string | undefined,
    options: { state?: MemoState; promotedTo?: string | null } = {}
  ): MemoEntry {
    const parsed = parseMemoLog(data);
    if (parsed.frontmatter.fields.week !== week) {
      throw new SeitonError(
        "MEMO_FORMAT",
        "保存後の確認に失敗しました。週次ファイルの week を確認してください。"
      );
    }
    const matches = parsed.entries.filter((entry) => entry.id === id);
    if (matches.length !== 1) {
      throw new SeitonError(
        "MEMO_FORMAT",
        `保存後の確認に失敗しました（IDの件数: ${matches.length}）。週次ファイルを開いて内容を確認してください。`
      );
    }
    const entry = matches[0];
    if (!entry) {
      throw new SeitonError(
        "MEMO_FORMAT",
        "保存後の確認に失敗しました。週次ファイルを開いて内容を確認してください。"
      );
    }
    if (body !== undefined && entry.body !== body) {
      throw new SeitonError(
        "MEMO_FORMAT",
        "保存後の本文確認に失敗しました。週次ファイルを開いて内容を確認してください。"
      );
    }
    if (options.state !== undefined && entry.state !== options.state) {
      throw new SeitonError(
        "MEMO_FORMAT",
        "保存後の状態確認に失敗しました。週次ファイルを開いて内容を確認してください。"
      );
    }
    if (
      options.promotedTo !== undefined &&
      entry.promotedTo !== options.promotedTo
    ) {
      throw new SeitonError(
        "MEMO_FORMAT",
        "保存後の昇格リンク確認に失敗しました。週次ファイルを開いて内容を確認してください。"
      );
    }
    return entry;
  }

  private async resolvePromotedNotePath(
    entry: MemoEntry,
    title: string
  ): Promise<string> {
    const date = dateKeyOf(entry.at) || "undated";
    const base = promotedNotePath(date, title);
    const candidates = [
      base,
      withPathSuffix(base, entry.id.slice(2, 10)),
      withPathSuffix(base, entry.id.slice(2, 18)),
    ];

    for (const candidate of candidates) {
      if (!this.vault.exists(candidate)) {
        return candidate;
      }
      const existing = await this.vault.read(candidate);
      if (frontmatterField(existing, "seiton_memo_id") === entry.id) {
        return candidate;
      }
    }

    throw new SeitonError(
      "PROMOTION_CONFLICT",
      "同じ名前のノートが既にあります。タイトルを変えるか、既存ノートを確認してください。"
    );
  }

  private async createPromotedNote(
    notePath: string,
    kind: string,
    entry: MemoEntry,
    created: string
  ): Promise<void> {
    if (!isPromotableKind(kind)) {
      throw new SeitonError("MEMO_FORMAT", "昇格先の種類が不正です。");
    }
    await this.vault.ensureFolder(NOTES_FOLDER);
    const content = buildPromotedNoteDocument({
      body: entry.body,
      created,
      kind,
      memoId: entry.id,
    });
    try {
      await this.vault.create(notePath, content);
    } catch (error) {
      if (!this.vault.exists(notePath)) {
        throw error;
      }
    }
  }

  private assertNoteOwnership(
    note: string,
    memoId: string,
    path: string
  ): void {
    const owner = frontmatterField(note, "seiton_memo_id");
    if (owner !== memoId) {
      throw new SeitonError(
        "PROMOTION_CONFLICT",
        `昇格先の候補「${path}」に別のノートがあります。上書きしませんでした。`
      );
    }
  }

  private assertNoteBody(note: string, body: string, path: string): void {
    const actual = bodyAfterFrontmatter(note);
    const expected = body.endsWith("\n") ? body : `${body}\n`;
    if (actual !== body && actual !== expected) {
      throw new SeitonError(
        "PROMOTION_VERIFY_FAILED",
        `独立ノート「${path}」の本文確認に失敗しました。元のメモは残っています。`
      );
    }
  }
}
