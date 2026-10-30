/**
 * Prompt Workbench の保存サービス。
 * コピー（クリップボード）はUI、履歴追記と下書き保存はここが担う。
 */

import { PROMPTS_FOLDER } from "../config";
import { SeitonError, toSeitonError } from "../domain/errors";
import { frontmatterList } from "../domain/frontmatter";
import { createId as defaultCreateId } from "../domain/ids";
import { normalizeLink } from "../domain/links";
import { sanitizeNoteTitle } from "../domain/notes";
import type { ParsedPromptLog, PromptItem } from "../domain/promptLog";
import {
  appendPromptItem,
  createPromptSessionDocument,
  exportPromptHistory,
  isDuplicateOfLatest,
  parsePromptLog,
  promptHash,
  setPromptSessionState,
  updatePromptDraft,
} from "../domain/promptLog";
import { normalizeNewlines } from "../domain/text";
import { dateKeyOf, formatLocalIso } from "../domain/time";
import { SerialQueue } from "./serialQueue";
import type { VaultPort } from "./vaultPort";

export interface PromptServiceOptions {
  createId?: () => string;
  logError?: (context: string, error: unknown) => void;
  now?: () => Date;
  vault: VaultPort;
}

export type SessionState = "open" | "closed" | "unknown";

export interface PromptSessionSummary {
  createdAt: string;
  draftPreview: string;
  lastPromptPreview: string;
  mtime: number;
  path: string;
  project: string | null;
  promptCount: number;
  state: SessionState;
  title: string;
}

export interface PromptSessionSnapshot {
  content: string;
  parsed: ParsedPromptLog;
  path: string;
  summary: PromptSessionSummary;
}

export interface AppendPromptResult {
  duplicate: boolean;
  item: PromptItem | null;
}

export interface PromptSessionList {
  problems: Array<{ path: string; message: string }>;
  sessions: PromptSessionSummary[];
}

export interface CreatePromptSessionInput {
  project?: string | null;
  title: string;
}

function normalizeState(value: string): SessionState {
  if (value === "open" || value === "closed") {
    return value;
  }
  return "unknown";
}

function draftPreview(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 80);
}

export class PromptService {
  private readonly vault: VaultPort;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly queue = new SerialQueue();
  private readonly logError: (context: string, error: unknown) => void;

  constructor(options: PromptServiceOptions) {
    this.vault = options.vault;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => defaultCreateId("p"));
    this.logError = options.logError ?? (() => undefined);
  }

  /** 新規セッションを1つ作る。タイトルはファイル名にだけ使い、本文の正本にしない。 */
  async createSession(
    input: CreatePromptSessionInput
  ): Promise<PromptSessionSummary> {
    const title = input.title.trim() || "プロンプトセッション";
    const project = input.project?.trim() || null;
    const now = this.now();
    const date = dateKeyOf(formatLocalIso(now)) || "undated";
    const base = `${PROMPTS_FOLDER}/${date}-${sanitizeNoteTitle(title)}`;
    const createdAt = formatLocalIso(now);

    await this.vault.ensureFolder(PROMPTS_FOLDER);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const path =
        attempt === 0
          ? `${base}.md`
          : `${base}-${this.createId().slice(2, 10)}.md`;
      if (this.vault.exists(path)) {
        continue;
      }
      try {
        await this.vault.create(
          path,
          createPromptSessionDocument({ createdAt, project, title })
        );
        const snapshot = await this.readSession(path);
        return snapshot.summary;
      } catch (error) {
        lastError = error;
        if (!this.vault.exists(path)) {
          throw toSeitonError(
            error,
            "プロンプトセッションの作成に失敗しました。"
          );
        }
      }
    }

    throw toSeitonError(
      lastError,
      "同名のプロンプトセッションが多く、作成できませんでした。"
    );
  }

  /** コピーした指示を、確定版スナップショットとして履歴へ追記する。 */
  async appendCopiedPrompt(
    path: string,
    body: string
  ): Promise<AppendPromptResult> {
    const normalized = normalizeNewlines(body);
    if (normalized.trim() === "") {
      throw new SeitonError(
        "EMPTY_MEMO",
        "空の指示はコピー履歴に保存しません。"
      );
    }
    this.assertSessionPath(path);

    return this.queue.run(path, async () => {
      try {
        const current = await this.readDocument(path);
        const parsed = parsePromptLog(current);
        this.assertSessionDocument(parsed, path);
        if (isDuplicateOfLatest(parsed, normalized)) {
          return { duplicate: true, item: null };
        }

        const id = this.createId();
        const at = formatLocalIso(this.now());
        const hash = promptHash(normalized);
        let expectedBody = normalized;

        const updated = await this.vault.process(path, (data) => {
          const latest = parsePromptLog(data);
          this.assertSessionDocument(latest, path);
          if (isDuplicateOfLatest(latest, normalized)) {
            expectedBody = latest.prompts.at(-1)?.body ?? normalized;
            return data;
          }
          return appendPromptItem(data, { at, body: normalized, hash, id });
        });

        const result = parsePromptLog(updated);
        this.assertSessionDocument(result, path);
        const item = result.prompts.find((prompt) => prompt.id === id);
        if (!item) {
          if (isDuplicateOfLatest(result, expectedBody)) {
            return { duplicate: true, item: null };
          }
          throw new SeitonError(
            "MEMO_FORMAT",
            "コピー履歴の保存後の確認に失敗しました。"
          );
        }
        if (item.body !== normalized) {
          throw new SeitonError(
            "MEMO_FORMAT",
            "コピー履歴の本文確認に失敗しました。"
          );
        }
        return { duplicate: false, item };
      } catch (error) {
        this.logError("appendCopiedPrompt", error);
        throw toSeitonError(
          error,
          "コピー履歴の保存に失敗しました。下書きは残っています。"
        );
      }
    });
  }

  /** 下書きを保存する。空文字も許可する。 */
  async saveDraft(path: string, text: string): Promise<void> {
    const body = normalizeNewlines(text);
    this.assertSessionPath(path);

    return this.queue.run(path, async () => {
      try {
        const current = await this.readDocument(path);
        const parsed = parsePromptLog(current);
        this.assertSessionDocument(parsed, path);
        if ((parsed.draft?.body ?? "") === body) {
          return;
        }

        const updated = await this.vault.process(path, (data) => {
          const latest = parsePromptLog(data);
          this.assertSessionDocument(latest, path);
          return updatePromptDraft(data, body);
        });
        const verified = parsePromptLog(updated);
        if ((verified.draft?.body ?? "") !== body) {
          throw new SeitonError(
            "MEMO_FORMAT",
            "下書きの保存後の確認に失敗しました。"
          );
        }
      } catch (error) {
        this.logError("saveDraft", error);
        throw toSeitonError(
          error,
          "下書きの保存に失敗しました。入力内容は残っています。"
        );
      }
    });
  }

  async setSessionState(path: string, state: "open" | "closed"): Promise<void> {
    this.assertSessionPath(path);
    return this.queue.run(path, async () => {
      try {
        const current = await this.readDocument(path);
        const parsed = parsePromptLog(current);
        this.assertSessionDocument(parsed, path);
        if (parsed.frontmatter.fields.session_state === state) {
          return;
        }
        const updated = await this.vault.process(path, (data) =>
          setPromptSessionState(data, state)
        );
        const verified = parsePromptLog(updated);
        if (verified.frontmatter.fields.session_state !== state) {
          throw new SeitonError(
            "MEMO_FORMAT",
            "セッション状態の保存後の確認に失敗しました。"
          );
        }
      } catch (error) {
        this.logError("setSessionState", error);
        throw toSeitonError(error, "セッション状態を更新できませんでした。");
      }
    });
  }

  async readSession(path: string): Promise<PromptSessionSnapshot> {
    this.assertSessionPath(path);
    const content = await this.readDocument(path);
    const parsed = parsePromptLog(content);
    this.assertSessionDocument(parsed, path);
    return {
      content,
      parsed,
      path,
      summary: this.summaryOf(path, content, parsed),
    };
  }

  async listSessions(): Promise<PromptSessionList> {
    const paths = await this.vault.listMarkdown(PROMPTS_FOLDER);
    const sessions: PromptSessionSummary[] = [];
    const problems: Array<{ path: string; message: string }> = [];

    const results = await Promise.all(
      paths.map(async (path) => {
        try {
          const content = await this.vault.read(path);
          const parsed = parsePromptLog(content);
          const kind = parsed.frontmatter.fields.kind;
          if (kind !== "prompt-session") {
            return {
              problem: {
                message: "kind: prompt-session ではありません。",
                path,
              },
              session: null,
            };
          }
          return {
            problem: null,
            session: this.summaryOf(path, content, parsed),
          };
        } catch (error) {
          return {
            problem: {
              message:
                error instanceof Error
                  ? error.message
                  : "セッションを読み込めませんでした。",
              path,
            },
            session: null,
          };
        }
      })
    );

    for (const result of results) {
      if (result.session) {
        sessions.push(result.session);
      }
      if (result.problem) {
        problems.push(result.problem);
      }
    }

    sessions.sort((left, right) => right.mtime - left.mtime);
    return { problems, sessions };
  }

  async latestSession(project?: string): Promise<PromptSessionSummary | null> {
    const { sessions } = await this.listSessions();
    if (project) {
      return (
        sessions.find(
          (session) =>
            session.project !== null &&
            normalizeLink(session.project) === normalizeLink(project)
        ) ?? null
      );
    }
    return sessions[0] ?? null;
  }

  async exportHistory(path: string): Promise<string> {
    const snapshot = await this.readSession(path);
    const heading = snapshot.summary.title;
    return `# ${heading}\n\n${exportPromptHistory(snapshot.parsed).trim()}\n`;
  }

  private summaryOf(
    path: string,
    content: string,
    parsed: ParsedPromptLog
  ): PromptSessionSummary {
    const project = frontmatterList(content, "projects")[0] ?? null;
    const displayProject =
      project === null
        ? null
        : project
            .replace(/^\[\[|\]\]$/gu, "")
            .replace(/\.md$/u, "")
            .trim() || null;
    return {
      createdAt: parsed.frontmatter.fields.created ?? "",
      draftPreview: draftPreview(parsed.draft?.body ?? ""),
      lastPromptPreview: draftPreview(parsed.prompts.at(-1)?.body ?? ""),
      mtime: this.vault.mtime(path),
      path,
      project: displayProject,
      promptCount: parsed.prompts.length,
      state: normalizeState(parsed.frontmatter.fields.session_state ?? ""),
      title:
        parsed.title || path.split("/").pop()?.replace(/\.md$/u, "") || "無題",
    };
  }

  private assertSessionPath(path: string): void {
    if (!path.startsWith(`${PROMPTS_FOLDER}/`) || !path.endsWith(".md")) {
      throw new SeitonError(
        "MEMO_NOT_FOUND",
        "プロンプトセッションの保存先が不正です。"
      );
    }
  }

  private assertSessionDocument(parsed: ParsedPromptLog, path: string): void {
    if (
      !(parsed.frontmatter.present && parsed.frontmatter.closed) ||
      parsed.frontmatter.fields.kind !== "prompt-session"
    ) {
      throw new SeitonError(
        "FOREIGN_FILE",
        `${path} はSeitonのプロンプトセッションではありません。上書きを中止しました。`
      );
    }
  }

  private async readDocument(path: string): Promise<string> {
    if (!this.vault.exists(path)) {
      throw new SeitonError(
        "MEMO_NOT_FOUND",
        "プロンプトセッションのファイルが見つかりません。"
      );
    }
    return this.vault.read(path);
  }
}
