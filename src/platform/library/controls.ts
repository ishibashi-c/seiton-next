import type { VaultIndex } from "../../services/vaultIndex";
import { allCourses, allLists, allTags } from "../../services/vaultIndex";
import type { LibrarySort } from "./query";
import type { LibrarySelection } from "./selection";

export interface LibraryControlsOptions {
  getCourse: () => string;
  getLayout: () => "cards" | "list";
  getList: () => string;
  getProject: () => string;
  getSort: () => LibrarySort;
  getTag: () => string;
  onCourseChange: (value: string) => void;
  onLayoutChange: (layout: "cards" | "list") => void;
  onListChange: (value: string) => void;
  onProjectChange: (value: string) => void;
  onRefresh: () => void;
  onSortChange: (sort: LibrarySort) => void;
  onTagChange: (value: string) => void;
  selection: LibrarySelection;
}

function fillSelect(
  select: HTMLSelectElement | null,
  emptyLabel: string,
  values: string[],
  current: string
): void {
  if (!select) {
    return;
  }
  select.empty();
  select.createEl("option", { text: emptyLabel, value: "" });
  for (const value of values) {
    select.createEl("option", { text: value, value });
  }
  select.value = current;
}

export class LibraryControls {
  private readonly options: LibraryControlsOptions;
  private courseSelect: HTMLSelectElement | null = null;
  private listSelect: HTMLSelectElement | null = null;
  private projectSelect: HTMLSelectElement | null = null;
  private sortSelect: HTMLSelectElement | null = null;
  private tagSelect: HTMLSelectElement | null = null;

  constructor(options: LibraryControlsOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    const controls = parent.createDiv({ cls: "seiton-library-controls" });

    this.courseSelect = controls.createEl("select", {
      attr: { "aria-label": "科目で絞り込む" },
      cls: "dropdown seiton-library-select seiton-course-select",
    });
    this.courseSelect.addEventListener("change", () => {
      this.options.onCourseChange(this.courseSelect?.value ?? "");
    });

    const sort = controls.createEl("select", {
      attr: { "aria-label": "並び順" },
      cls: "dropdown seiton-library-select",
    });
    this.sortSelect = sort;
    sort.createEl("option", { text: "更新順", value: "updated" });
    sort.createEl("option", { text: "作成順", value: "created" });
    sort.createEl("option", { text: "講義日順", value: "lecture" });
    sort.value = this.options.getSort();
    sort.addEventListener("change", () => {
      this.options.onSortChange(
        sort.value === "created"
          ? "created"
          : sort.value === "lecture"
            ? "lecture"
            : "updated"
      );
    });

    const layout = controls.createDiv({
      attr: { "aria-label": "表示", role: "group" },
      cls: "seiton-segmented",
    });
    const cardsButton = layout.createEl("button", {
      attr: { type: "button" },
      cls: this.options.getLayout() === "cards" ? "is-active" : "",
      text: "カード",
    });
    const listButton = layout.createEl("button", {
      attr: { type: "button" },
      cls: this.options.getLayout() === "list" ? "is-active" : "",
      text: "リスト",
    });
    const applyLayout = (next: "cards" | "list"): void => {
      cardsButton.classList.toggle("is-active", next === "cards");
      listButton.classList.toggle("is-active", next === "list");
      cardsButton.setAttribute("aria-pressed", String(next === "cards"));
      listButton.setAttribute("aria-pressed", String(next === "list"));
      this.options.onLayoutChange(next);
    };
    cardsButton.setAttribute(
      "aria-pressed",
      String(this.options.getLayout() === "cards")
    );
    listButton.setAttribute(
      "aria-pressed",
      String(this.options.getLayout() === "list")
    );
    cardsButton.addEventListener("click", () => applyLayout("cards"));
    listButton.addEventListener("click", () => applyLayout("list"));

    const selectToggle = controls.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action seiton-select-toggle",
      text: "選択",
    });
    this.options.selection.bindToggle(selectToggle);

    const more = parent.createEl("details", {
      cls: "seiton-filter-more",
    });
    more.createEl("summary", { text: "タグ・リスト・プロジェクトで絞り込む" });
    const selects = more.createDiv({ cls: "seiton-library-selects" });
    this.tagSelect = selects.createEl("select", {
      attr: { "aria-label": "タグで絞り込む" },
      cls: "dropdown",
    });
    this.tagSelect.addEventListener("change", () => {
      this.options.onTagChange(this.tagSelect?.value ?? "");
    });
    this.listSelect = selects.createEl("select", {
      attr: { "aria-label": "リストで絞り込む" },
      cls: "dropdown",
    });
    this.listSelect.addEventListener("change", () => {
      this.options.onListChange(this.listSelect?.value ?? "");
    });
    this.projectSelect = selects.createEl("select", {
      attr: { "aria-label": "プロジェクトで絞り込む" },
      cls: "dropdown",
    });
    this.projectSelect.addEventListener("change", () => {
      this.options.onProjectChange(this.projectSelect?.value ?? "");
    });
  }

  refreshOptions(index: VaultIndex): void {
    fillSelect(
      this.tagSelect,
      "タグ: すべて",
      allTags(index),
      this.options.getTag()
    );
    fillSelect(
      this.listSelect,
      "リスト: すべて",
      allLists(index),
      this.options.getList()
    );
    fillSelect(
      this.courseSelect,
      "科目: すべて",
      allCourses(index),
      this.options.getCourse()
    );
    const projects = [
      ...new Set(
        index.notes
          .filter((note) => note.kind === "project")
          .map((note) => note.title)
      ),
    ].sort((left, right) => left.localeCompare(right, "ja"));
    fillSelect(
      this.projectSelect,
      "プロジェクト: すべて",
      projects,
      this.options.getProject()
    );
  }

  setSortState(sort: LibrarySort, searching: boolean): void {
    if (!this.sortSelect) {
      return;
    }
    this.sortSelect.value = sort;
    this.sortSelect.disabled = searching;
    this.sortSelect.title = searching
      ? "検索中は関連度順で表示します"
      : "並び順";
  }

  reset(): void {
    this.courseSelect = null;
    this.listSelect = null;
    this.projectSelect = null;
    this.sortSelect = null;
    this.tagSelect = null;
  }
}
