import { type App, Modal, setIcon } from "obsidian";
import type { VaultIndex } from "../../services/vaultIndex";
import { allCourses, allLists, allTags } from "../../services/vaultIndex";
import {
  type LibraryFilter,
  type LibraryQueryState,
  OTHER_KINDS,
  queryHits,
} from "./query";

export interface FilterModalState {
  course: string;
  kind: LibraryFilter;
  list: string;
  project: string;
  status: "all" | "review" | "pinned" | "archived";
  tag: string;
}

export const KIND_ITEMS: Array<{ id: LibraryFilter; label: string }> = [
  { id: "all", label: "すべて" },
  { id: "memo", label: "メモ" },
  { id: "class", label: "授業" },
  { id: "webclip", label: "Web" },
  { id: "book", label: "本" },
  { id: "other", label: "ノート" },
  { id: "prompt", label: "プロンプト" },
  { id: "idea", label: "アイデア" },
  { id: "article", label: "記事" },
];

export const STATUS_ITEMS: Array<{
  id: "all" | "review" | "pinned" | "archived";
  label: string;
}> = [
  { id: "all", label: "指定なし" },
  { id: "pinned", label: "ピン" },
  { id: "review", label: "整理トレイ" },
  { id: "archived", label: "アーカイブ" },
];

export class LibraryFilterModal extends Modal {
  private readonly index: VaultIndex;
  private state: FilterModalState;
  private readonly onApply: (nextState: FilterModalState) => void;
  private applyBtn: HTMLButtonElement | null = null;
  private tagContainer: HTMLElement | null = null;
  private tagQuery = "";

  constructor(
    app: App,
    index: VaultIndex,
    initialState: FilterModalState,
    onApply: (nextState: FilterModalState) => void
  ) {
    super(app);
    this.index = index;
    this.state = { ...initialState };
    this.onApply = onApply;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("seiton-modal", "seiton-filter-modal");
    contentEl.empty();

    // 1. ヘッダー
    const header = contentEl.createDiv({ cls: "seiton-filter-modal-header" });
    header.createEl("h2", {
      cls: "seiton-filter-modal-title",
      text: "ライブラリの絞り込み",
    });

    const resetBtn = header.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action seiton-filter-reset-btn",
      text: "リセット",
    });
    resetBtn.addEventListener("click", () => {
      this.state = {
        course: "",
        kind: "all",
        list: "",
        project: "",
        status: "all",
        tag: "",
      };
      this.renderAll();
    });

    // 2. スクロール領域
    const body = contentEl.createDiv({ cls: "seiton-filter-modal-body" });

    // セクション: 種類
    this.renderKindSection(body);

    // セクション: 状態
    this.renderStatusSection(body);

    // セクション: タグ
    this.renderTagSection(body);

    // セクション: プロジェクト & 科目 & リスト
    this.renderMetadataSection(body);

    // 3. フッター
    const footer = contentEl.createDiv({ cls: "seiton-filter-modal-footer" });
    const cancelBtn = footer.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-filter-cancel-btn",
      text: "キャンセル",
    });
    cancelBtn.addEventListener("click", () => this.close());

    this.applyBtn = footer.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-primary-button seiton-filter-apply-btn",
      text: "絞り込む",
    });
    this.applyBtn.addEventListener("click", () => {
      this.onApply(this.state);
      this.close();
    });

    this.updateApplyButtonCount();
  }

  private renderKindSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "seiton-filter-section" });
    section.createEl("h3", { text: "種類" });
    const grid = section.createDiv({ cls: "seiton-filter-pill-grid" });

    const activeNotes = this.index.notes.filter((note) => !note.archived);
    const kindCounts: Record<LibraryFilter, number> = {
      all:
        activeNotes.length +
        this.index.memos.filter((memo) => memo.state !== "deleted").length +
        this.index.prompts.length,
      archived: this.index.notes.filter((note) => note.archived).length,
      article: activeNotes.filter((note) => note.kind === "article").length,
      book: activeNotes.filter((note) => note.kind === "book").length,
      class: activeNotes.filter((note) => note.kind === "class").length,
      idea: activeNotes.filter((note) => note.kind === "idea").length,
      memo: this.index.memos.filter((memo) => memo.state !== "deleted").length,
      other: activeNotes.filter((note) => OTHER_KINDS.includes(note.kind))
        .length,
      pinned: this.index.notes.filter((note) => note.pinned && !note.archived)
        .length,
      prompt: this.index.prompts.length,
      review: this.index.notes.filter((note) => note.review && !note.archived)
        .length,
      webclip: activeNotes.filter((note) => note.kind === "webclip").length,
    };

    for (const item of KIND_ITEMS) {
      const isSelected = this.state.kind === item.id;
      const count = kindCounts[item.id] ?? 0;
      const btn = grid.createEl("button", {
        attr: {
          "aria-pressed": isSelected ? "true" : "false",
          type: "button",
        },
        cls: `seiton-filter-pill${isSelected ? " is-active" : ""}`,
      });
      btn.createSpan({ cls: "seiton-pill-label", text: item.label });
      btn.createSpan({ cls: "seiton-pill-count", text: String(count) });
      btn.addEventListener("click", () => {
        this.state.kind = item.id;
        this.renderAll();
      });
    }
  }

  private renderStatusSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "seiton-filter-section" });
    section.createEl("h3", { text: "整理状態" });
    const grid = section.createDiv({ cls: "seiton-filter-pill-grid" });

    const counts: Record<"all" | "review" | "pinned" | "archived", number> = {
      all: this.index.notes.length,
      archived: this.index.notes.filter((n) => n.archived).length,
      pinned: this.index.notes.filter((n) => n.pinned && !n.archived).length,
      review: this.index.notes.filter((n) => n.review && !n.archived).length,
    };

    for (const item of STATUS_ITEMS) {
      const isSelected = this.state.status === item.id;
      const btn = grid.createEl("button", {
        attr: {
          "aria-pressed": isSelected ? "true" : "false",
          type: "button",
        },
        cls: `seiton-filter-pill${isSelected ? " is-active" : ""}`,
      });
      btn.createSpan({ cls: "seiton-pill-label", text: item.label });
      if (item.id !== "all") {
        btn.createSpan({
          cls: "seiton-pill-count",
          text: String(counts[item.id]),
        });
      }
      btn.addEventListener("click", () => {
        this.state.status = item.id;
        this.renderAll();
      });
    }
  }

  private renderTagSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "seiton-filter-section" });
    const head = section.createDiv({ cls: "seiton-filter-section-head" });
    head.createEl("h3", { text: "タグ" });

    // タグ検索インプット
    const searchWrap = head.createDiv({ cls: "seiton-filter-search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "seiton-search-icon" });
    setIcon(searchIcon, "search");
    const input = searchWrap.createEl("input", {
      attr: {
        placeholder: "タグを絞り込み...",
        type: "text",
      },
      cls: "seiton-filter-search-input",
    });
    input.value = this.tagQuery;
    input.addEventListener("input", () => {
      this.tagQuery = input.value.trim().toLowerCase();
      this.renderTags();
    });

    this.tagContainer = section.createDiv({ cls: "seiton-filter-tags-grid" });
    this.renderTags();
  }

  private renderTags(): void {
    if (!this.tagContainer) {
      return;
    }
    this.tagContainer.empty();

    // タグごとの件数を集計
    const tagCountMap = new Map<string, number>();
    for (const note of this.index.notes) {
      if (note.archived && this.state.status !== "archived") {
        continue;
      }
      for (const t of note.tags) {
        tagCountMap.set(t, (tagCountMap.get(t) ?? 0) + 1);
      }
    }

    const allTagList = allTags(this.index);
    const filteredTags = allTagList.filter((t) =>
      this.tagQuery ? t.toLowerCase().includes(this.tagQuery) : true
    );

    // 件数順にソート
    filteredTags.sort(
      (a, b) => (tagCountMap.get(b) ?? 0) - (tagCountMap.get(a) ?? 0)
    );

    if (filteredTags.length === 0) {
      this.tagContainer.createDiv({
        cls: "seiton-filter-empty-text",
        text: "一致するタグがありません",
      });
      return;
    }

    // 「タグなし / すべて」解除ボタン
    if (this.state.tag) {
      const clearBtn = this.tagContainer.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-filter-chip is-clear",
      });
      clearBtn.createSpan({ text: "タグ指定を解除" });
      const xIcon = clearBtn.createSpan({ cls: "seiton-chip-remove" });
      setIcon(xIcon, "x");
      clearBtn.addEventListener("click", () => {
        this.state.tag = "";
        this.renderAll();
      });
    }

    for (const tag of filteredTags) {
      const isSelected = this.state.tag === tag;
      const count = tagCountMap.get(tag) ?? 0;
      const chip = this.tagContainer.createEl("button", {
        attr: {
          "aria-pressed": isSelected ? "true" : "false",
          type: "button",
        },
        cls: `seiton-filter-chip${isSelected ? " is-active" : ""}`,
      });
      chip.createSpan({ cls: "seiton-chip-text", text: `#${tag}` });
      chip.createSpan({ cls: "seiton-chip-count", text: String(count) });
      chip.addEventListener("click", () => {
        this.state.tag = isSelected ? "" : tag;
        this.renderAll();
      });
    }
  }

  private renderMetadataSection(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "seiton-filter-section" });
    const row = section.createDiv({ cls: "seiton-filter-row" });

    // プロジェクト
    const projectCol = row.createDiv({ cls: "seiton-filter-col" });
    projectCol.createEl("h3", { text: "プロジェクト" });
    const projectSelect = projectCol.createEl("select", {
      cls: "seiton-filter-select",
    });
    projectSelect.createEl("option", { text: "指定なし", value: "" });

    const projects = [
      ...new Set(
        this.index.notes
          .filter((note) => note.kind === "project")
          .map((note) => note.title)
      ),
    ].sort((a, b) => a.localeCompare(b, "ja"));

    for (const p of projects) {
      const opt = projectSelect.createEl("option", { text: p, value: p });
      if (this.state.project === p) {
        opt.selected = true;
      }
    }
    projectSelect.addEventListener("change", () => {
      this.state.project = projectSelect.value;
      this.renderAll();
    });

    // 科目
    const courseCol = row.createDiv({ cls: "seiton-filter-col" });
    courseCol.createEl("h3", { text: "科目" });
    const courseSelect = courseCol.createEl("select", {
      cls: "seiton-filter-select",
    });
    courseSelect.createEl("option", { text: "指定なし", value: "" });
    for (const c of allCourses(this.index)) {
      const opt = courseSelect.createEl("option", { text: c, value: c });
      if (this.state.course === c) {
        opt.selected = true;
      }
    }
    courseSelect.addEventListener("change", () => {
      this.state.course = courseSelect.value;
      this.renderAll();
    });

    // リスト
    const lists = allLists(this.index);
    if (lists.length > 0) {
      const listCol = row.createDiv({ cls: "seiton-filter-col" });
      listCol.createEl("h3", { text: "リスト" });
      const listSelect = listCol.createEl("select", {
        cls: "seiton-filter-select",
      });
      listSelect.createEl("option", { text: "指定なし", value: "" });
      for (const l of lists) {
        const opt = listSelect.createEl("option", { text: l, value: l });
        if (this.state.list === l) {
          opt.selected = true;
        }
      }
      listSelect.addEventListener("change", () => {
        this.state.list = listSelect.value;
        this.renderAll();
      });
    }
  }

  private renderAll(): void {
    const body = this.contentEl.querySelector<HTMLElement>(
      ".seiton-filter-modal-body"
    );
    if (!body) {
      return;
    }
    body.empty();
    this.renderKindSection(body);
    this.renderStatusSection(body);
    this.renderTagSection(body);
    this.renderMetadataSection(body);
    this.updateApplyButtonCount();
  }

  private updateApplyButtonCount(): void {
    if (!this.applyBtn) {
      return;
    }
    const queryState: LibraryQueryState = {
      courseFilter: this.state.course,
      filter: this.state.status === "all" ? this.state.kind : this.state.status,
      listFilter: this.state.list,
      projectFilter: this.state.project,
      query: "",
      sort: "updated",
      tagFilter: this.state.tag,
    };
    const hits = queryHits(this.index, queryState, 9999);
    this.applyBtn.setText(`絞り込む（${hits.length}件）`);
  }
}
