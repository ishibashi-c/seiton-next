import type { VaultIndex } from "../../services/vaultIndex";
import { allCourses, allLists, allTags } from "../../services/vaultIndex";
import { createSelect, type SelectControl } from "../ui/select";
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
  control: SelectControl | null,
  emptyLabel: string,
  values: string[],
  current: string
): void {
  if (!control) {
    return;
  }
  control.setChoices([
    { label: emptyLabel, value: "" },
    ...values.map((value) => ({ label: value, value })),
  ]);
  control.setValue(current);
}

export class LibraryControls {
  private readonly options: LibraryControlsOptions;
  private courseSelect: SelectControl | null = null;
  private listSelect: SelectControl | null = null;
  private projectSelect: SelectControl | null = null;
  private sortSelect: SelectControl | null = null;
  private tagSelect: SelectControl | null = null;

  constructor(options: LibraryControlsOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    const controls = parent.createDiv({ cls: "seiton-library-controls" });

    this.courseSelect = createSelect({
      choices: [],
      onChange: (value) => this.options.onCourseChange(value),
      value: this.options.getCourse(),
    });
    this.courseSelect.element.addClass("seiton-library-select");
    this.courseSelect.element.addClass("is-quiet");
    this.courseSelect.element.addClass("seiton-course-select");
    controls.append(this.courseSelect.element);

    this.sortSelect = createSelect({
      choices: [
        { label: "更新順", value: "updated" },
        { label: "作成順", value: "created" },
        { label: "講義日順", value: "lecture" },
      ],
      onChange: (value) =>
        this.options.onSortChange(
          value === "created" || value === "lecture" ? value : "updated"
        ),
      value: this.options.getSort(),
    });
    this.sortSelect.element.addClass("seiton-library-select");
    this.sortSelect.element.addClass("is-quiet");
    controls.append(this.sortSelect.element);

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
    this.tagSelect = createSelect({
      choices: [],
      onChange: (value) => this.options.onTagChange(value),
      value: this.options.getTag(),
    });
    this.tagSelect.element.addClass("seiton-library-select");
    this.tagSelect.element.addClass("is-quiet");
    selects.append(this.tagSelect.element);
    this.listSelect = createSelect({
      choices: [],
      onChange: (value) => this.options.onListChange(value),
      value: this.options.getList(),
    });
    this.listSelect.element.addClass("seiton-library-select");
    this.listSelect.element.addClass("is-quiet");
    selects.append(this.listSelect.element);
    this.projectSelect = createSelect({
      choices: [],
      onChange: (value) => this.options.onProjectChange(value),
      value: this.options.getProject(),
    });
    this.projectSelect.element.addClass("seiton-library-select");
    this.projectSelect.element.addClass("is-quiet");
    selects.append(this.projectSelect.element);
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
    this.sortSelect.setValue(sort);
    this.sortSelect.element.toggleClass("is-disabled", searching);
    this.sortSelect.element.title = searching
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
