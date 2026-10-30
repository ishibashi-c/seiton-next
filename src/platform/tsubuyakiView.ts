import { showToast } from "./ui/toast";
/**
 * つぶやきページ。全期間の一言メモを時刻順に読み、その場で書き足す。
 * 保存形式は従来の週次Markdown（kind: memo-log）のまま変えない。
 */

import type { TAbstractFile, WorkspaceLeaf } from "obsidian";
import { ItemView, MarkdownRenderer, setIcon, TFile } from "obsidian";
import { MEMOS_FOLDER, VIEW_TYPE_TSUBUYAKI } from "../config";
import { userMessageOf } from "../domain/errors";
import { clockOf } from "../domain/time";
import type {
  MemoListItem,
  MemoProblem,
  MemoService,
} from "../services/memoService";
import { showCardMenu } from "./cardMenu";
import { ConfirmModal } from "./confirmModal";
import { MemoCaptureModal } from "./memoCaptureModal";
import { PromoteMemoModal } from "./promoteMemoModal";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import { TsubuyakiComposer } from "./tsubuyaki/composer";
import { TsubuyakiEditor } from "./tsubuyaki/editor";
import {
  dayLabel,
  filterMemos,
  groupMemos,
  memoMeta,
  monthLabel,
  tagEntries,
  visibleMemos,
} from "./tsubuyaki/timeline";

const PAGE_SIZE = 60;
function localDateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(
    date.getMonth() + 1
  ).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function yesterdayKey(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localDateKey(date);
}

export class SeitonTsubuyakiView extends ItemView {
  private readonly memoService: MemoService;
  private items: MemoListItem[] = [];
  private problems: MemoProblem[] = [];
  private query = "";
  private activeTag = "";
  private showDeleted = false;
  private limit = PAGE_SIZE;
  private loading = true;
  private refreshing = false;
  private refreshAgain = false;
  private refreshTimer: number | null = null;
  private searchTimer: number | null = null;
  private composer: TsubuyakiComposer | null = null;
  private metaEl: HTMLElement | null = null;
  private tagChipsEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private problemsEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  private readonly editor: TsubuyakiEditor;

  constructor(leaf: WorkspaceLeaf, memoService: MemoService) {
    super(leaf);
    this.memoService = memoService;
    this.editor = new TsubuyakiEditor({
      memoService,
      onChanged: () => this.afterEditorChange(),
    });
  }

  override getViewType(): string {
    return VIEW_TYPE_TSUBUYAKI;
  }

  override getDisplayText(): string {
    return "つぶやき";
  }

  override getIcon(): string {
    return "message-square";
  }

  override async onOpen(): Promise<void> {
    this.composer = new TsubuyakiComposer({
      app: this.app,
      memoService: this.memoService,
      onSaved: async () => {
        await this.refresh();
        this.contentEl.scrollTo({ behavior: "smooth", top: 0 });
      },
    });
    const { body, header } = mountTabShell(this, {
      actions: [
        {
          kind: "text",
          label: "今日",
          onClick: () => this.scrollToToday(),
        },
        {
          ariaLabel: "表示の設定",
          icon: "more-horizontal",
          kind: "icon",
          label: "表示の設定",
          onClick: (button) => this.openHeaderMenu(button),
        },
      ],
      fab: {
        icon: "message-square-plus",
        label: "つぶやく",
        onClick: () => {
          new MemoCaptureModal(this.app, this.memoService, {
            onSaved: () => {
              void this.refresh();
            },
          }).open();
        },
      },
      rootClasses: ["seiton-home", "seiton-tsubuyaki"],
      subline: "",
      tab: "tsubuyaki",
      title: "つぶやき",
    });
    this.metaEl = header.sublineEl;
    body.addClass("seiton-tsubuyaki-content");
    this.renderCompose(body);
    this.renderToolbar(body);
    this.problemsEl = body.createDiv({ cls: "seiton-problems" });
    this.listEl = body.createDiv({ cls: "seiton-tsubuyaki-list" });

    this.registerVaultEvents();
    await this.refresh();
    finishTabShell(this, VIEW_TYPE_TSUBUYAKI);
  }

  override async onClose(): Promise<void> {
    this.editor.reset();
    closeTabShell(this, VIEW_TYPE_TSUBUYAKI);
    this.composer = null;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.contentEl.empty();
    this.items = [];
    this.listEl = null;
    this.tagChipsEl = null;
  }

  private renderCompose(parent: HTMLElement): void {
    this.composer?.render(parent);
  }

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "seiton-tsubuyaki-toolbar" });
    this.tagChipsEl = toolbar.createDiv({ cls: "seiton-tsubuyaki-tags" });

    const tools = toolbar.createDiv({ cls: "seiton-tsubuyaki-tools" });
    const searchWrap = tools.createDiv({ cls: "seiton-tsubuyaki-search-wrap" });
    setIcon(
      searchWrap.createSpan({ cls: "seiton-tsubuyaki-search-icon" }),
      "search"
    );
    const search = searchWrap.createEl("input", {
      attr: {
        "aria-label": "つぶやきを検索",
        placeholder: "検索",
        type: "search",
      },
      cls: "seiton-tsubuyaki-search",
    });
    search.addEventListener("input", () => {
      if (this.searchTimer !== null) {
        window.clearTimeout(this.searchTimer);
      }
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null;
        this.query = search.value;
        this.limit = PAGE_SIZE;
        this.renderTagChips();
        this.renderList();
      }, 150);
    });

    this.countEl = tools.createSpan({ cls: "seiton-tsubuyaki-count" });
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const result = await this.memoService.listAll({ includeDeleted: true });
      this.items = result.items;
      this.problems = result.problems;
      this.loading = false;
      if (this.activeTag !== "" && !this.hasTag(this.activeTag)) {
        this.activeTag = "";
      }
      this.renderProblems();
      this.renderMeta();
      this.renderTagChips();
      this.renderList();
    } catch (error) {
      this.loading = false;
      this.composer?.setStatus(userMessageOf(error), "error");
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  private renderMeta(): void {
    if (!this.metaEl) {
      return;
    }
    const meta = memoMeta(this.items, this.showDeleted);
    if (meta.visible === 0 && meta.deleted === 0) {
      this.metaEl.setText("");
      return;
    }
    const parts = [`${meta.visible}件`];
    if (meta.deleted > 0 && !this.showDeleted) {
      parts.push(`削除済み${meta.deleted}件`);
    }
    if (meta.range !== "") {
      parts.push(meta.range);
    }
    this.metaEl.setText(parts.join(" · "));
  }

  private renderProblems(): void {
    const host = this.problemsEl;
    if (!host) {
      return;
    }
    host.empty();
    if (this.problems.length === 0) {
      return;
    }
    const details = host.createEl("details", {
      cls: "seiton-problem-details",
    });
    details.createEl("summary", {
      text: `確認が必要なファイルが ${this.problems.length} 件あります`,
    });
    const list = details.createEl("ul");
    for (const problem of this.problems.slice(0, 10)) {
      const item = list.createEl("li");
      item.createSpan({ cls: "seiton-problem-path", text: problem.path });
      item.createSpan({ text: problem.message });
    }
    if (this.problems.length > 10) {
      list.createEl("li", {
        text: `他 ${this.problems.length - 10} 件`,
      });
    }
  }

  private renderTagChips(): void {
    const host = this.tagChipsEl;
    if (!host) {
      return;
    }
    host.empty();
    const entries = this.tagEntries();
    if (entries.length === 0 && this.activeTag === "") {
      host.style.display = "none";
      return;
    }
    host.style.display = "";

    const all = host.createEl("button", {
      attr: { type: "button" },
      cls: `seiton-tsubuyaki-tag${this.activeTag === "" ? " is-active" : ""}`,
      text: "すべて",
    });
    all.addEventListener("click", () => {
      this.activeTag = "";
      this.limit = PAGE_SIZE;
      this.renderTagChips();
      this.renderList();
    });

    for (const entry of entries) {
      const chip = host.createEl("button", {
        attr: { type: "button" },
        cls: `seiton-tsubuyaki-tag${
          this.activeTag === entry.key ? " is-active" : ""
        }`,
        text: `#${entry.label}`,
      });
      chip.addEventListener("click", () => {
        this.activeTag = this.activeTag === entry.key ? "" : entry.key;
        this.limit = PAGE_SIZE;
        this.renderTagChips();
        this.renderList();
      });
    }
  }

  private tagEntries(): Array<{ count: number; key: string; label: string }> {
    return tagEntries(this.visibleItems());
  }

  private hasTag(key: string): boolean {
    return this.tagEntries().some((entry) => entry.key === key);
  }

  private renderList(): void {
    const host = this.listEl;
    if (!host) {
      return;
    }
    const top = this.contentEl.scrollTop;
    host.empty();

    if (this.loading) {
      host.createDiv({ cls: "seiton-empty", text: "読み込み中…" });
      return;
    }

    const filtered = this.filteredItems();
    this.updateCount(filtered.length);
    if (filtered.length === 0) {
      const message =
        this.visibleItems().length === 0
          ? this.items.length > 0
            ? "削除済みのつぶやきだけがあります。右上の「⋯」から表示できます。"
            : "まだつぶやきがありません。上の欄から最初の1件を保存できます。"
          : this.query.trim() === ""
            ? "このタグのつぶやきはありません。"
            : `「${this.query.trim()}」に一致するつぶやきはありません。`;
      host.createDiv({ cls: "seiton-empty", text: message });
      this.contentEl.scrollTop = top;
      return;
    }

    for (const month of groupMemos(filtered, this.limit)) {
      const monthSection = host.createEl("section", {
        cls: "seiton-tsubuyaki-month",
      });
      const monthHead = monthSection.createDiv({
        cls: "seiton-tsubuyaki-month-head",
      });
      monthHead.createEl("h2", { text: monthLabel(month.key) });
      monthHead.createSpan({
        cls: "seiton-tsubuyaki-month-count",
        text: `${month.count}件`,
      });

      for (const day of month.days) {
        const daySection = monthSection.createEl("section", {
          cls: "seiton-tsubuyaki-day",
        });
        daySection.dataset.day = day.key;
        const dayHead = daySection.createDiv({
          cls: "seiton-tsubuyaki-day-head",
        });
        dayHead.createEl("h3", { text: dayLabel(day.key) });
        const today = localDateKey(new Date());
        if (day.key === today) {
          dayHead.createSpan({
            cls: "seiton-tsubuyaki-day-badge",
            text: "今日",
          });
        } else if (day.key === yesterdayKey()) {
          dayHead.createSpan({
            cls: "seiton-tsubuyaki-day-badge",
            text: "昨日",
          });
        }
        dayHead.createSpan({
          cls: "seiton-tsubuyaki-day-count",
          text: `${day.count}件`,
        });
        for (const item of day.items) {
          this.renderRow(daySection, item);
        }
      }
    }

    if (filtered.length > this.limit) {
      const footer = host.createDiv({ cls: "seiton-tsubuyaki-footer" });
      const more = footer.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-more-button",
        text: `さらに読み込む（${this.limit} / ${filtered.length}）`,
      });
      more.addEventListener("click", () => {
        this.limit += PAGE_SIZE;
        this.renderList();
      });
    }

    this.contentEl.scrollTop = top;
  }

  private visibleItems(): MemoListItem[] {
    return visibleMemos(this.items, this.showDeleted);
  }

  private filteredItems(): MemoListItem[] {
    return filterMemos(this.items, {
      activeTag: this.activeTag,
      query: this.query,
      showDeleted: this.showDeleted,
    });
  }

  private updateCount(filteredCount: number): void {
    if (!this.countEl) {
      return;
    }
    const total = this.visibleItems().length;
    const filtering = this.query.trim() !== "" || this.activeTag !== "";
    this.countEl.setText(
      filtering ? `${filteredCount}件 / ${total}件` : `${total}件`
    );
  }

  private renderRow(parent: HTMLElement, item: MemoListItem): void {
    if (this.editor.isEditing(item.entry.id)) {
      this.editor.render(parent, item);
      return;
    }
    const entry = item.entry;
    const row = parent.createDiv({ cls: "seiton-tsubuyaki-row" });
    row.dataset.id = entry.id;
    if (entry.state === "deleted") {
      row.addClass("is-deleted");
    }

    const time = row.createEl("time", {
      cls: "seiton-tsubuyaki-time",
      text: clockOf(entry.at) || "--:--",
    });
    time.setAttribute("datetime", entry.at);
    time.title = `ID: ${entry.id}`;

    const main = row.createDiv({ cls: "seiton-tsubuyaki-main" });
    const body = main.createDiv({
      cls: "seiton-tsubuyaki-body markdown-rendered",
    });
    void MarkdownRenderer.render(
      this.app,
      entry.body,
      body,
      item.path,
      this
    ).catch(() => {
      body.setText(entry.body);
    });

    if (entry.promotedTo) {
      const linkText = `[[${entry.promotedTo.replace(/\.md$/u, "")}]]`;
      if (!entry.body.includes(linkText)) {
        const promoted = main.createDiv({
          cls: "seiton-tsubuyaki-promoted",
        });
        promoted.createSpan({ text: "独立ノート:" });
        const link = promoted.createEl("a", {
          cls: "internal-link",
          text: entry.promotedTo.replace(/\.md$/u, ""),
        });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.openPath(entry.promotedTo ?? "");
        });
      }
    }

    if (entry.state !== "active") {
      const meta = main.createDiv({ cls: "seiton-tsubuyaki-badges" });
      if (entry.state === "deleted") {
        meta.createSpan({
          cls: "seiton-badge is-deleted",
          text: "削除済み",
        });
      } else if (entry.state === "promoted") {
        meta.createSpan({
          cls: "seiton-badge is-promoted",
          text: "ノート化済み",
        });
      } else {
        meta.createSpan({
          cls: "seiton-badge is-unknown",
          text: "状態不明",
        });
      }
    }

    const more = main.createEl("button", {
      attr: { "aria-label": "つぶやきの操作", type: "button" },
      cls: "seiton-tsubuyaki-more",
    });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      showCardMenu(more, this.actionsFor(item));
    });

    row.addEventListener("click", (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("a,button,input,textarea")
      ) {
        return;
      }
      if ((window.getSelection()?.toString() ?? "") !== "") {
        return;
      }
      this.startEdit(item.entry.id);
    });
  }

  private actionsFor(item: MemoListItem) {
    const actions: Array<{
      danger?: boolean;
      label: string;
      run: () => void;
    }> = [
      {
        label: "編集",
        run: () => this.startEdit(item.entry.id),
      },
    ];
    if (item.entry.state !== "deleted") {
      actions.push({
        label: "ノート化",
        run: () => {
          new PromoteMemoModal(this.app, this.memoService, item, () => {
            void this.refresh();
          }).open();
        },
      });
    }
    actions.push({
      label: "週ファイルを開く",
      run: () => {
        void this.openPath(item.path);
      },
    });
    actions.push({
      label: "コピー",
      run: () => {
        void this.copyBody(item);
      },
    });
    if (item.entry.state === "deleted") {
      actions.push({
        label: "復元",
        run: () => {
          void this.restore(item);
        },
      });
    } else {
      actions.push({
        danger: true,
        label: "削除",
        run: () => this.confirmDelete(item),
      });
    }
    return actions;
  }

  private startEdit(id: string): void {
    if (!this.editor.begin(id)) {
      this.composer?.setStatus(
        "編集中です。保存かキャンセルをしてください。",
        "error"
      );
      return;
    }
    const top = this.contentEl.scrollTop;
    this.renderList();
    this.contentEl.scrollTop = top;
    this.editor.focus();
  }

  private afterEditorChange(): void {
    const top = this.contentEl.scrollTop;
    this.renderList();
    this.contentEl.scrollTop = top;
  }

  private confirmDelete(item: MemoListItem): void {
    new ConfirmModal(this.app, {
      confirmingLabel: "削除",
      message:
        "このつぶやきを削除します。週ファイルには削除済みとして残ります。",
      onConfirm: async () => {
        await this.memoService.setMemoDeleted(item.week, item.entry.id, true);
        showToast("削除しました。");
        await this.refresh();
      },
      title: "つぶやきを削除",
    }).open();
  }

  private async restore(item: MemoListItem): Promise<void> {
    try {
      await this.memoService.setMemoDeleted(item.week, item.entry.id, false);
      showToast("復元しました。");
      await this.refresh();
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  private async copyBody(item: MemoListItem): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.entry.body);
      showToast("本文をコピーしました。");
    } catch {
      showToast("コピーできませんでした。");
    }
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    showToast("ファイルが見つかりません。");
  }

  private scrollToToday(): void {
    const key = localDateKey(new Date());
    const target =
      this.listEl?.querySelector<HTMLElement>(`[data-day="${key}"]`) ?? null;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    this.composer?.focus();
    this.composer?.setStatus("今日のつぶやきはまだありません。", "idle");
  }

  private openHeaderMenu(anchor: HTMLElement): void {
    showCardMenu(anchor, [
      {
        label: this.showDeleted ? "削除済みを隠す" : "削除済みも表示",
        run: () => {
          this.showDeleted = !this.showDeleted;
          this.limit = PAGE_SIZE;
          void this.refresh();
        },
      },
      {
        label: "最新の状態に更新",
        run: () => {
          void this.refresh();
        },
      },
    ]);
  }

  private registerVaultEvents(): void {
    const onFileChange = (file: TAbstractFile): void => {
      if (this.touchesMemo(file)) {
        this.scheduleRefresh();
      }
    };
    this.registerEvent(this.app.vault.on("create", onFileChange));
    this.registerEvent(this.app.vault.on("delete", onFileChange));
    this.registerEvent(this.app.vault.on("modify", onFileChange));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.touchesMemo(file) || oldPath.startsWith(`${MEMOS_FOLDER}/`)) {
          this.scheduleRefresh();
        }
      })
    );
  }

  private touchesMemo(file: TAbstractFile): boolean {
    return (
      file.path.startsWith(`${MEMOS_FOLDER}/`) ||
      this.items.some((item) => item.path === file.path)
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 250);
  }
}
