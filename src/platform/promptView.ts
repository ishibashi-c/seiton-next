/**
 * Prompt Workbench。指示を書き、コピーし、次の指示を書く。
 * AIへの送信は行わない。コピーと履歴保存は別の結果として表示する。
 */

import type { App, WorkspaceLeaf } from "obsidian";
import { ItemView, Menu, Modal } from "obsidian";
import { VIEW_TYPE_PROMPT } from "../config";
import { userMessageOf } from "../domain/errors";
import type {
  PromptService,
  PromptSessionSummary,
} from "../services/promptService";
import { PromptComposer } from "./prompt/composer";
import { PromptHistory } from "./prompt/history";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import { markSeitonModal } from "./ui/modal";
import { ButtonComponent, Setting, type TextComponent } from "./ui/setting";

/** クリップボードへコピーする。成功した場合だけ true。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Obsidian/Electronでnavigator.clipboardが使えない場合の退避。
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

class NewPromptSessionModal extends Modal {
  private readonly promptService: PromptService;
  private readonly onCreated: (session: PromptSessionSummary) => void;
  private readonly defaultProject: string;
  private title = "プロンプトセッション";
  private project: string;
  private statusEl: HTMLElement | null = null;
  private busy = false;

  constructor(
    app: App,
    promptService: PromptService,
    defaultProject: string,
    onCreated: (session: PromptSessionSummary) => void
  ) {
    super(app);
    this.promptService = promptService;
    this.defaultProject = defaultProject;
    this.project = defaultProject;
    this.onCreated = onCreated;
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.setTitle("新しいプロンプトセッション");
    this.contentEl.createEl("p", {
      cls: "seiton-prompt-hint",
      text: "1作業セッション = 1 Markdown。プロジェクトはセッション単位で関連付けます。",
    });

    new Setting(this.contentEl)
      .setName("セッション名")
      .addText((text: TextComponent) => {
        text.setValue(this.title).onChange((value) => {
          this.title = value;
        });
      });
    new Setting(this.contentEl)
      .setName("プロジェクト")
      .setDesc("任意。空欄なら関連付けません。")
      .addText((text: TextComponent) => {
        text.setValue(this.project).onChange((value) => {
          this.project = value;
        });
      });

    this.statusEl = this.contentEl.createDiv({
      cls: "seiton-modal-status",
    });
    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    new ButtonComponent(footer)
      .setButtonText("キャンセル")
      .onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText("作成")
      .setCta()
      .onClick(() => {
        void this.submit();
      });
  }

  private async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.setStatus("作成中…");
    try {
      const session = await this.promptService.createSession({
        project: this.project.trim() || this.defaultProject || null,
        title: this.title,
      });
      this.onCreated(session);
      this.close();
    } catch (error) {
      this.busy = false;
      this.setStatus(userMessageOf(error), true);
    }
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }
}

class PromptSessionPickerModal extends Modal {
  private readonly promptService: PromptService;
  private readonly currentPath: string | null;
  private readonly onSelect: (session: PromptSessionSummary) => void;

  constructor(
    app: App,
    promptService: PromptService,
    currentPath: string | null,
    onSelect: (session: PromptSessionSummary) => void
  ) {
    super(app);
    this.promptService = promptService;
    this.currentPath = currentPath;
    this.onSelect = onSelect;
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.setTitle("プロンプトセッション");
    const body = this.contentEl.createDiv({ cls: "seiton-session-picker" });
    body.setText("読み込み中…");
    void this.load(body);
  }

  private async load(container: HTMLElement): Promise<void> {
    container.empty();
    try {
      const { problems, sessions } = await this.promptService.listSessions();
      if (sessions.length === 0) {
        container.createEl("p", {
          cls: "seiton-empty",
          text: "セッションがありません。",
        });
        return;
      }
      for (const session of sessions) {
        const row = container.createEl("button", {
          cls: "seiton-session-row",
        });
        row.type = "button";
        if (session.path === this.currentPath) {
          row.addClass("is-current");
        }
        const head = row.createDiv({ cls: "seiton-session-row-head" });
        head.createSpan({
          cls: "seiton-session-row-title",
          text: session.title,
        });
        if (session.path === this.currentPath) {
          head.createSpan({
            cls: "seiton-session-row-now",
            text: "今ここ",
          });
        }
        row.createDiv({
          cls: "seiton-session-row-meta",
          text: `${sessionStamp(session.mtime)} · ${
            session.state === "open"
              ? "進行中"
              : session.state === "closed"
                ? "終了"
                : "状態不明"
          } · ${session.promptCount}件${
            session.project ? ` · ${session.project}` : ""
          }`,
        });
        const preview = session.draftPreview
          ? `下書き: ${session.draftPreview}`
          : session.lastPromptPreview
            ? `直前: ${session.lastPromptPreview}`
            : "";
        if (preview) {
          row.createDiv({
            cls: "seiton-session-row-draft",
            text: preview,
          });
        }
        row.addEventListener("click", () => {
          this.onSelect(session);
          this.close();
        });
      }
      if (problems.length > 0) {
        container.createEl("p", {
          cls: "seiton-problem-inline",
          text: `確認が必要なファイル: ${problems.length}件`,
        });
      }
    } catch (error) {
      container.createEl("p", {
        cls: "seiton-problem-inline",
        text: userMessageOf(error),
      });
    }
  }
}

export class PromptWorkbenchView extends ItemView {
  readonly promptService: PromptService;
  private session: PromptSessionSummary | null = null;
  private bodyEl: HTMLElement | null = null;
  private historyEl: HTMLElement | null = null;
  private history: PromptHistory | null = null;
  private composer: PromptComposer | null = null;
  private headerEl: HTMLElement | null = null;
  private isOpenSession = true;

  constructor(leaf: WorkspaceLeaf, promptService: PromptService) {
    super(leaf);
    this.promptService = promptService;
  }

  override getViewType(): string {
    return VIEW_TYPE_PROMPT;
  }

  override getDisplayText(): string {
    return "Prompt Workbench";
  }

  override getIcon(): string {
    return "message-square";
  }

  override async onOpen(): Promise<void> {
    this.renderShell();
    const latest = await this.promptService.latestSession();
    if (latest) {
      await this.openSession(latest.path);
    } else {
      this.renderEmpty();
    }
    finishTabShell(this, VIEW_TYPE_PROMPT);
  }

  /** プラグインから特定セッションを開く。 */
  async openPath(path: string | null): Promise<void> {
    if (path) {
      await this.openSession(path);
      return;
    }
    const latest = await this.promptService.latestSession();
    if (latest) {
      await this.openSession(latest.path);
    } else {
      this.renderEmpty();
    }
  }

  /** プラグインのコマンドから新規セッション画面を開く。 */
  newSession(): void {
    this.openNewSession();
  }

  private renderShell(): void {
    const { body, header } = mountTabShell(this, {
      fab: {
        icon: "plus",
        label: "新規セッション",
        onClick: () => this.openNewSession(),
      },
      rootClasses: ["seiton-prompt-root"],
      tab: "prompt",
      title: "Prompt",
    });
    header.header.addClass("seiton-prompt-header");
    this.headerEl = header.header;
    body.addClass("seiton-prompt-body");
    this.bodyEl = body;
    const composer = body.createDiv({ cls: "seiton-prompt-composer" });
    this.composer = new PromptComposer({
      copyToClipboard,
      getSession: () => this.session,
      isOpen: () => this.isOpenSession,
      onCopied: (path, status) => this.openSession(path, status),
      promptService: this.promptService,
    });
    this.composer.render(composer);
    const historyPane = body.createDiv({
      cls: "seiton-prompt-history-pane",
    });
    historyPane.createDiv({
      cls: "seiton-prompt-pane-label",
      text: "履歴",
    });
    this.historyEl = historyPane.createDiv({ cls: "seiton-prompt-history" });
    this.history = new PromptHistory({
      app: this.app,
      component: this,
      copy: (text, message) => this.copyText(text, message),
      copyClipboard: copyToClipboard,
      onNewSession: () => this.openNewSession(),
      onQuote: (body) => this.composer?.quote(body),
      onStatus: (message, kind) => this.setStatus(message, kind),
    });
    this.history.attach(this.historyEl);
  }

  private renderEmpty(): void {
    this.session = null;
    if (this.headerEl) {
      this.headerEl.empty();
      const heading = this.headerEl.createDiv({ cls: "seiton-page-heading" });
      heading.createEl("h1", {
        cls: "seiton-page-title",
        text: "セッションがありません",
      });
    }
    this.bodyEl?.addClass("is-empty-history");
    this.history?.renderEmpty();
    this.setComposerEnabled(false);
  }

  private async openSession(
    path: string,
    status?: { message: string; kind: "idle" | "success" | "error" }
  ): Promise<void> {
    try {
      const snapshot = await this.promptService.readSession(path);
      this.session = snapshot.summary;
      this.isOpenSession = snapshot.summary.state !== "closed";
      this.composer?.setValue(snapshot.parsed.draft?.body ?? "");
      this.renderHeader();
      this.history?.render(snapshot.parsed.prompts);
      this.bodyEl?.toggleClass(
        "is-empty-history",
        snapshot.parsed.prompts.length === 0
      );
      this.setComposerEnabled(this.isOpenSession);
      this.setStatus(
        status?.message ??
          (this.isOpenSession
            ? "下書きは自動保存されます"
            : "終了したセッションです"),
        status?.kind ?? "idle"
      );
    } catch (error) {
      this.setStatus(userMessageOf(error), "error");
    }
  }

  private renderHeader(): void {
    if (!this.headerEl || !this.session) {
      return;
    }
    this.headerEl.empty();
    const titleWrap = this.headerEl.createDiv({
      cls: "seiton-page-heading",
    });
    titleWrap.createEl("h1", {
      cls: "seiton-page-title",
      text: this.session.title,
    });
    titleWrap.createDiv({
      cls: "seiton-page-subline",
      text: [
        this.session.project ? `プロジェクト: ${this.session.project}` : null,
        this.session.state === "open" ? "進行中" : "終了",
        `${this.session.promptCount}件の履歴`,
      ]
        .filter(Boolean)
        .join(" · "),
    });

    const actions = this.headerEl.createDiv({ cls: "seiton-page-actions" });
    this.headerAction(actions, "新規", () => this.openNewSession());
    this.headerAction(actions, "一覧", () => this.openPicker());
    this.headerAction(actions, "履歴をコピー", () => {
      void this.exportHistory();
    });
    this.headerAction(actions, "選択をまとめる", () => {
      if (this.session) {
        this.history?.openHandoff(this.session);
      }
    });
    this.headerAction(
      actions,
      this.isOpenSession ? "セッションを終了" : "セッションを再開",
      () => {
        void this.toggleState();
      }
    );

    const more = actions.createEl("button", {
      attr: { "aria-label": "セッションの操作", type: "button" },
      cls: "seiton-prompt-more",
      text: "⋯",
    });
    more.addEventListener("click", (event) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("新規").onClick(() => this.openNewSession())
      );
      menu.addItem((item) =>
        item.setTitle("一覧").onClick(() => this.openPicker())
      );
      menu.addItem((item) =>
        item.setTitle("履歴をコピー").onClick(() => void this.exportHistory())
      );
      menu.addItem((item) =>
        item.setTitle("選択をまとめる").onClick(() => this.openHandoff())
      );
      menu.addItem((item) =>
        item
          .setTitle(
            this.isOpenSession ? "セッションを終了" : "セッションを再開"
          )
          .onClick(() => void this.toggleState())
      );
      menu.showAtMouseEvent(event);
    });
  }

  private headerAction(
    parent: HTMLElement,
    label: string,
    action: () => void
  ): void {
    const button = parent.createEl("button", {
      cls: "seiton-prompt-action",
      text: label,
    });
    button.type = "button";
    button.addEventListener("click", action);
  }

  private async exportHistory(): Promise<void> {
    if (!this.session) {
      return;
    }
    try {
      const text = await this.promptService.exportHistory(this.session.path);
      await this.copyText(text, "履歴をMarkdownとしてコピーしました。");
    } catch (error) {
      this.setStatus(userMessageOf(error), "error");
    }
  }

  private async toggleState(): Promise<void> {
    if (!this.session) {
      return;
    }
    const next = this.isOpenSession ? "closed" : "open";
    try {
      await this.promptService.setSessionState(this.session.path, next);
      await this.openSession(this.session.path);
    } catch (error) {
      this.setStatus(userMessageOf(error), "error");
    }
  }

  private openNewSession(): void {
    new NewPromptSessionModal(
      this.app,
      this.promptService,
      this.session?.project ?? "",
      (session) => {
        void this.openSession(session.path);
      }
    ).open();
  }

  private openPicker(): void {
    new PromptSessionPickerModal(
      this.app,
      this.promptService,
      this.session?.path ?? null,
      (session) => {
        void this.openSession(session.path);
      }
    ).open();
  }

  private setStatus(message: string, kind: "idle" | "success" | "error"): void {
    this.composer?.setStatus(message, kind);
  }

  private setComposerEnabled(enabled: boolean): void {
    this.composer?.setEnabled(enabled);
  }

  private openHandoff(): void {
    if (this.session) {
      this.history?.openHandoff(this.session);
    }
  }

  private async copyText(text: string, message: string): Promise<void> {
    const copied = await copyToClipboard(text);
    this.setStatus(
      copied ? message : "コピーに失敗しました。",
      copied ? "success" : "error"
    );
  }

  override async onClose(): Promise<void> {
    await this.composer?.flush();
    closeTabShell(this, VIEW_TYPE_PROMPT);
    this.historyEl = null;
    this.history = null;
    this.composer = null;
    this.headerEl = null;
  }
}

function sessionStamp(mtime: number): string {
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) {
    return "日時不明";
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${String(
    date.getHours()
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
