import { showToast } from "./ui/toast";
/**
 * つぶやきページ。全期間の一言メモを時刻順に読み、その場で書き足す。
 * 保存形式は従来の週次Markdown（kind: memo-log）のまま変えない。
 */

import type { TAbstractFile, WorkspaceLeaf } from "obsidian";
import { ItemView, setIcon, TFile } from "obsidian";
import {
  MEMOS_FOLDER,
  NOTES_FOLDER,
  SYSTEM_FOLDER,
  VIEW_TYPE_TSUBUYAKI,
} from "../config";
import { userMessageOf } from "../domain/errors";
import { buildFrontmatter, yamlQuoted } from "../domain/frontmatter";
import { withPathSuffix } from "../domain/notes";
import { normalizeNewlines } from "../domain/text";
import { clockOf, dateKeyOf, formatLocalIso } from "../domain/time";
import type {
  MemoListItem,
  MemoProblem,
  MemoService,
} from "../services/memoService";
import { showCardMenu } from "./cardMenu";
import { ConfirmModal } from "./confirmModal";
import { MemoCaptureModal } from "./memoCaptureModal";
import { AppendToNoteModal, PromoteMemoModal } from "./promoteMemoModal";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import { CalendarPicker } from "./tsubuyaki/calendar";
import { TsubuyakiComposer } from "./tsubuyaki/composer";
import { TsubuyakiEditor } from "./tsubuyaki/editor";
import {
  dayLabel,
  filterMemos,
  groupMemos,
  type MemoPeriodFilter,
  type MemoSortOrder,
  type MemoStatusFilter,
  memoMeta,
  monthLabel,
  tagEntries,
  visibleMemos,
} from "./tsubuyaki/timeline";
import { createSelect, type SelectControl } from "./ui/select";

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
  private period: MemoPeriodFilter = "all";
  private selectedDate = "";
  private startDate = "";
  private endDate = "";
  private status: MemoStatusFilter = "all";
  private sortOrder: MemoSortOrder = "newest";
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
  private calendarPicker: CalendarPicker | null = null;
  private statusSelect: SelectControl | null = null;
  private sortSelect: SelectControl | null = null;
  private bulkPromoteButton: HTMLButtonElement | null = null;

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
    finishTabShell(this, VIEW_TYPE_TSUBUYAKI);
    void this.refresh();
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
    this.calendarPicker?.destroy();
    this.calendarPicker = null;
    this.statusSelect = null;
    this.sortSelect = null;
    this.bulkPromoteButton = null;
  }

  private renderCompose(parent: HTMLElement): void {
    this.composer?.render(parent);
  }

  private renderToolbar(parent: HTMLElement): void {
    const controls = parent.createDiv({ cls: "seiton-tsubuyaki-controls" });

    this.calendarPicker = new CalendarPicker({
      onChange: (sel) => {
        this.period = sel.period;
        this.selectedDate = sel.selectedDate;
        this.startDate = sel.startDate ?? "";
        this.endDate = sel.endDate ?? "";
        this.limit = PAGE_SIZE;
        this.renderTagChips();
        this.renderList();
      },
    });
    this.calendarPicker.mount(controls);
    this.calendarPicker.setMemoItems(this.items);

    this.statusSelect = createSelect({
      choices: [
        { label: "状態: すべて", value: "all" },
        { label: "未整理", value: "active" },
        { label: "ノート化済み", value: "promoted" },
        { label: "削除済み", value: "deleted" },
      ],
      onChange: (value) => {
        this.status = value as MemoStatusFilter;
        this.showDeleted = this.status === "deleted";
        this.limit = PAGE_SIZE;
        this.renderTagChips();
        this.renderList();
      },
      title: "状態",
      value: this.status,
    });
    this.statusSelect.element.addClass("seiton-tsubuyaki-select");
    this.statusSelect.element.addClass("is-quiet");
    controls.append(this.statusSelect.element);

    this.sortSelect = createSelect({
      choices: [
        { label: "新しい順", value: "newest" },
        { label: "古い順", value: "oldest" },
      ],
      onChange: (value) => {
        this.sortOrder = value as MemoSortOrder;
        this.limit = PAGE_SIZE;
        this.renderList();
      },
      title: "並び順",
      value: this.sortOrder,
    });
    this.sortSelect.element.addClass("seiton-tsubuyaki-select");
    this.sortSelect.element.addClass("is-quiet");
    controls.append(this.sortSelect.element);

    const tools = controls.createDiv({ cls: "seiton-tsubuyaki-tools" });
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

    const bulkBtn = tools.createEl("button", {
      attr: {
        "aria-label": "表示中のつぶやきをまとめて昇格",
        title: "表示中のつぶやきをまとめてノート化（最大20件）",
        type: "button",
      },
      cls: "seiton-bulk-promote-button is-quiet",
    });
    setIcon(
      bulkBtn.createSpan({ cls: "seiton-bulk-promote-icon" }),
      "folder-plus"
    );
    bulkBtn.createSpan({
      cls: "seiton-bulk-promote-label",
      text: "まとめ昇格",
    });
    bulkBtn.addEventListener("click", () => {
      this.openBulkPromote();
    });
    bulkBtn.style.display = "none";
    this.bulkPromoteButton = bulkBtn;

    const digestBtn = tools.createEl("button", {
      attr: {
        "aria-label": "直近7日間の振り返りノートを作成",
        title: "直近7日間の振り返りノートを作成",
        type: "button",
      },
      cls: "seiton-weekly-digest-button is-quiet",
    });
    setIcon(
      digestBtn.createSpan({ cls: "seiton-digest-icon" }),
      "calendar-check"
    );
    digestBtn.createSpan({ text: "週次まとめ" });
    digestBtn.addEventListener("click", () => {
      void this.generateWeeklyReview();
    });

    this.tagChipsEl = parent.createDiv({ cls: "seiton-tsubuyaki-tags" });
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
      this.calendarPicker?.setMemoItems(this.items);
      const topTags = tagEntries(this.items)
        .slice(0, 6)
        .map((e) => e.label);
      this.composer?.setRecentTags(topTags);
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
    const parts: string[] = [];
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
    const baseItems = filterMemos(this.items, {
      activeTag: "",
      endDate: this.endDate || undefined,
      period: this.period,
      query: "",
      selectedDate: this.selectedDate,
      showDeleted: this.showDeleted,
      startDate: this.startDate || undefined,
      status: this.status,
    });
    return tagEntries(baseItems);
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
    this.updateBulkPromoteButton();
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
      endDate: this.endDate || undefined,
      period: this.period,
      query: this.query,
      selectedDate: this.selectedDate,
      showDeleted: this.showDeleted,
      sort: this.sortOrder,
      startDate: this.startDate || undefined,
      status: this.status,
    });
  }

  private updateCount(filteredCount: number): void {
    if (!this.countEl) {
      return;
    }
    const total = this.visibleItems().length;
    const filtering =
      this.query.trim() !== "" ||
      this.activeTag !== "" ||
      this.period !== "all" ||
      this.selectedDate !== "" ||
      this.startDate !== "" ||
      this.endDate !== "" ||
      this.status !== "all";
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
    this.renderMemoBodyFast(body, entry.body);

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

  private renderMemoBodyFast(container: HTMLElement, rawText: string): void {
    const paragraphs = rawText.split(/\n{2,}/u);
    const tokenPattern =
      /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)）」』]+)|(^|[\s(（「『【、])#([\p{L}\p{N}_/-]+))/gu;

    for (const para of paragraphs) {
      const p = container.createEl("p");
      const lines = para.split("\n");
      lines.forEach((line, lineIdx) => {
        if (lineIdx > 0) {
          p.createEl("br");
        }
        let lastIndex = 0;
        for (const match of line.matchAll(tokenPattern)) {
          const matchIndex = match.index ?? 0;
          const full = match[0];
          const prefix = match[7] ?? "";
          const effectiveStart = matchIndex + prefix.length;

          if (effectiveStart > lastIndex) {
            p.appendText(line.slice(lastIndex, effectiveStart));
          }

          if (full.startsWith("`") && full.endsWith("`")) {
            p.createEl("code", { text: full.slice(1, -1) });
          } else if (full.startsWith("**") && full.endsWith("**")) {
            p.createEl("strong", { text: full.slice(2, -2) });
          } else if (match[2] !== undefined) {
            const target = match[2].trim();
            const label = (match[3] ?? target).trim();
            const link = p.createEl("a", {
              cls: "internal-link",
              text: label,
            });
            link.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              void this.app.workspace.openLinkText(target, "", false);
            });
          } else if (match[4] !== undefined && match[5] !== undefined) {
            const link = p.createEl("a", {
              attr: {
                href: match[5],
                rel: "noopener noreferrer",
                target: "_blank",
              },
              cls: "external-link",
              text: match[4],
            });
            link.addEventListener("click", (event) => event.stopPropagation());
          } else if (match[6] !== undefined) {
            const link = p.createEl("a", {
              attr: {
                href: match[6],
                rel: "noopener noreferrer",
                target: "_blank",
              },
              cls: "external-link",
              text: match[6],
            });
            link.addEventListener("click", (event) => event.stopPropagation());
          } else if (match[8] !== undefined) {
            const tagText = match[8];
            if (/[^\d]/u.test(tagText)) {
              const tagEl = p.createEl("a", {
                cls: "tag",
                text: `#${tagText}`,
              });
              tagEl.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const key = tagText.toLowerCase();
                this.activeTag = this.activeTag === key ? "" : key;
                this.limit = PAGE_SIZE;
                this.renderTagChips();
                this.renderList();
              });
            } else {
              p.appendText(`#${tagText}`);
            }
          }

          lastIndex = matchIndex + full.length;
        }
        if (lastIndex < line.length) {
          p.appendText(line.slice(lastIndex));
        }
      });
    }
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
      actions.push({
        label: "既存ノートへ追記",
        run: () => {
          new AppendToNoteModal(this.app, this.memoService, item, () => {
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
          this.status = this.showDeleted ? "deleted" : "all";
          this.statusSelect?.setValue(this.status);
          this.limit = PAGE_SIZE;
          void this.refresh();
        },
      },
      {
        label: "表示中をまとめ昇格",
        run: () => {
          this.openBulkPromote();
        },
      },
      {
        label: "週次まとめを作成",
        run: () => {
          void this.generateWeeklyReview();
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

  private updateBulkPromoteButton(): void {
    if (!this.bulkPromoteButton) {
      return;
    }
    const promotable = this.filteredItems()
      .filter((item) => item.entry.state !== "deleted")
      .slice(0, 20);
    if (promotable.length >= 2) {
      this.bulkPromoteButton.style.display = "";
      this.bulkPromoteButton.disabled = false;
      const label = this.bulkPromoteButton.querySelector(
        ".seiton-bulk-promote-label"
      );
      if (label) {
        label.textContent = `まとめ昇格 (${promotable.length})`;
      }
    } else {
      this.bulkPromoteButton.style.display = "none";
      this.bulkPromoteButton.disabled = true;
    }
  }

  private openBulkPromote(): void {
    const promotable = this.filteredItems()
      .filter((item) => item.entry.state !== "deleted")
      .slice(0, 20);
    if (promotable.length < 2) {
      showToast("まとめ昇格には2件以上のつぶやきが必要です。");
      return;
    }
    new PromoteMemoModal(this.app, this.memoService, promotable, (result) => {
      showToast("まとめノートを作成しました。");
      void this.refresh();
      if ("path" in result && typeof result.path === "string") {
        void this.openPath(result.path);
      } else if ("notePath" in result && typeof result.notePath === "string") {
        void this.openPath(result.notePath);
      }
    }).open();
  }

  private async generateWeeklyReview(): Promise<void> {
    try {
      showToast("週次振り返りノートを作成中…");
      const now = new Date();
      const todayKey = localDateKey(now);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
      const sevenDaysAgoTime = sevenDaysAgo.getTime();
      const sevenDaysAgoKey = localDateKey(sevenDaysAgo);

      // 1. 直近7日間のつぶやき一覧
      const recentMemos = this.items
        .filter((item) => {
          if (item.entry.state === "deleted") {
            return false;
          }
          const itemDateKey = dateKeyOf(item.entry.at);
          return itemDateKey >= sevenDaysAgoKey && itemDateKey <= todayKey;
        })
        .sort((a, b) => a.entry.at.localeCompare(b.entry.at));

      const memosByDay = new Map<string, MemoListItem[]>();
      for (const item of recentMemos) {
        const d = dateKeyOf(item.entry.at) || "日付不明";
        const list = memosByDay.get(d) ?? [];
        list.push(item);
        memosByDay.set(d, list);
      }

      let memoSection = "### つぶやき\n\n";
      if (memosByDay.size === 0) {
        memoSection += "直近7日間のつぶやきはありません。\n\n";
      } else {
        for (const [day, dayItems] of memosByDay.entries()) {
          memoSection += `#### ${day}\n\n`;
          for (const item of dayItems) {
            const time = clockOf(item.entry.at) || "--:--";
            const body = normalizeNewlines(item.entry.body).replace(
              /\n/gu,
              " "
            );
            memoSection += `- **${time}** ${body}\n`;
          }
          memoSection += "\n";
        }
      }

      // 2. 直近7日間に作成・更新されたノート＆Webクリップ一覧
      // 3. 読書中の本・読了の本
      const allFiles = this.app.vault
        .getMarkdownFiles()
        .filter((file) => !file.path.startsWith(`${SYSTEM_FOLDER}/`));

      const updatedNotes: { basename: string; path: string }[] = [];
      const webClips: { basename: string; path: string }[] = [];
      const booksReading: string[] = [];
      const booksFinished: string[] = [];

      for (const file of allFiles) {
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = (cache?.frontmatter ?? {}) as Record<
          string,
          unknown
        >;
        const kind = String(frontmatter.kind ?? frontmatter.type ?? "note");
        const mtime = file.stat.mtime;
        const createdStr = String(frontmatter.created ?? "");
        const createdTime = createdStr ? Date.parse(createdStr) : 0;
        const isRecent =
          mtime >= sevenDaysAgoTime ||
          (!Number.isNaN(createdTime) && createdTime >= sevenDaysAgoTime);

        const readingStatus = String(frontmatter.reading_status ?? "");
        const bookFinished = String(frontmatter.book_finished ?? "");
        const isBook = Boolean(frontmatter.book_isbn || readingStatus);

        if (isBook) {
          if (readingStatus === "reading") {
            booksReading.push(file.basename);
          } else if (
            readingStatus === "finished" ||
            (bookFinished && bookFinished >= sevenDaysAgoKey)
          ) {
            booksFinished.push(file.basename);
          }
        }

        if (isRecent) {
          if (kind === "webclip") {
            webClips.push({
              basename: file.basename,
              path: file.path,
            });
          } else if (kind !== "memo-log") {
            updatedNotes.push({ basename: file.basename, path: file.path });
          }
        }
      }

      let notesSection = "### ノート\n\n";
      if (updatedNotes.length === 0) {
        notesSection += "直近7日間に作成・更新されたノートはありません。\n\n";
      } else {
        for (const note of updatedNotes) {
          notesSection += `- [[${note.basename}]]\n`;
        }
        notesSection += "\n";
      }

      let webClipsSection = "### Webクリップ\n\n";
      if (webClips.length === 0) {
        webClipsSection += "直近7日間のWebクリップはありません。\n\n";
      } else {
        for (const clip of webClips) {
          webClipsSection += `- [[${clip.basename}]]\n`;
        }
        webClipsSection += "\n";
      }

      let booksSection = "### 読書\n\n";
      if (booksReading.length === 0 && booksFinished.length === 0) {
        booksSection += "読書記録はありません。\n\n";
      } else {
        if (booksReading.length > 0) {
          booksSection += "#### 読書中\n";
          for (const book of booksReading) {
            booksSection += `- [[${book}]]\n`;
          }
          booksSection += "\n";
        }
        if (booksFinished.length > 0) {
          booksSection += "#### 読了\n";
          for (const book of booksFinished) {
            booksSection += `- [[${book}]]\n`;
          }
          booksSection += "\n";
        }
      }

      const title = `週次振り返り ${todayKey}`;
      const baseNotePath = `${NOTES_FOLDER}/${title}.md`;
      let notePath = baseNotePath;
      let suffix = 1;
      while (this.app.vault.getAbstractFileByPath(notePath) !== null) {
        notePath = withPathSuffix(baseNotePath, String(suffix));
        suffix += 1;
      }

      const nowIso = formatLocalIso(now);
      const frontmatterText = buildFrontmatter(
        {
          created: yamlQuoted(nowIso),
          kind: "note",
          tags: "[週次レビュー]",
        },
        "\n"
      );

      const documentText = `${frontmatterText}\n# ${title}\n\n${memoSection}${notesSection}${webClipsSection}${booksSection}`;

      const existingNotesFolder =
        this.app.vault.getAbstractFileByPath(NOTES_FOLDER);
      if (!existingNotesFolder) {
        try {
          await this.app.vault.createFolder(NOTES_FOLDER);
        } catch {
          // 既に存在する場合は無視
        }
      }
      await this.app.vault.create(notePath, documentText);

      showToast("週次振り返りノートを作成しました。");
      await this.openPath(notePath);
    } catch (error) {
      showToast(userMessageOf(error));
    }
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
    }, 500);
  }
}
