import type { App } from "obsidian";
import { Modal } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { NOTE_TEMPLATES, type NoteTemplateId } from "../domain/noteTemplates";
import { buildVocabulary } from "../domain/vocabulary";
import type { ClassCandidate, NoteService } from "../services/noteService";
import type { VaultIndexService } from "../services/vaultIndex";
import { button, fieldRow, selectField, textField } from "./ui/field";
import { buildSeitonModal } from "./ui/modal";
import type { SelectControl } from "./ui/select";
import { renderVocabularyChips } from "./vocabularyChips";

function todayKey(): string {
  const date = new Date();
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export class NewNoteModal extends Modal {
  private readonly noteService: NoteService;
  private readonly indexService: VaultIndexService;
  private readonly defaultProject: string;
  private readonly onCreated: (path: string) => void;
  private template: NoteTemplateId = "note";
  private title = "";
  private project: string;
  private course = "";
  private courseControl: SelectControl | null = null;
  private newCourseInput: HTMLInputElement | null = null;
  private newCourseRow: HTMLElement | null = null;
  private lectureDate = todayKey();
  private statusEl: HTMLElement | null = null;
  private candidatesEl: HTMLElement | null = null;
  private classFields: HTMLElement | null = null;
  private forceCreate = false;

  constructor(
    app: App,
    noteService: NoteService,
    indexService: VaultIndexService,
    defaultProject: string,
    onCreated: (path: string) => void
  ) {
    super(app);
    this.noteService = noteService;
    this.indexService = indexService;
    this.defaultProject = defaultProject;
    this.project = defaultProject;
    this.onCreated = onCreated;
  }

  override onOpen(): void {
    const { body, footer } = buildSeitonModal(this, {
      description:
        "本文はObsidian標準エディターで編集します。タイトルとテンプレートだけ選びます。",
      title: "新しいノート",
    });

    selectField(body, {
      choices: NOTE_TEMPLATES.map((template) => ({
        label: template.label,
        value: template.id,
      })),
      label: "テンプレート",
      onChange: (value) => {
        this.template = value as NoteTemplateId;
        this.updateClassFields();
      },
      value: this.template,
    });

    const titleInput = textField(body, {
      description:
        "空欄なら授業は「講義日 科目名」、それ以外は「無題」になります。",
      label: "タイトル",
      onChange: (value) => {
        this.title = value;
      },
      placeholder: "例: 認知科学の授業メモ",
    });
    window.setTimeout(() => titleInput.focus(), 50);

    const projectRow = fieldRow(body, {
      description: "任意。空欄なら関連付けません。",
      label: "プロジェクト",
    });
    const projectInput = projectRow.createEl("input", {
      cls: "st-input",
      type: "text",
    });
    projectInput.value = this.project;
    projectInput.addEventListener("input", () => {
      this.project = projectInput.value;
    });

    const cached = this.indexService.getCached();
    if (cached) {
      const chips = projectRow.createDiv({ cls: "seiton-vocab-row" });
      renderVocabularyChips(
        chips,
        buildVocabulary(cached.notes.map((note) => note.projects)),
        {
          current: this.project ? [this.project] : [],
          label: "既存",
          onPick: (value) => {
            this.project = value;
            projectInput.value = value;
          },
        }
      );
    }

    this.classFields = body.createDiv({ cls: "seiton-class-fields" });
    this.courseControl = selectField(this.classFields, {
      choices: [{ label: "既存の科目から選択", value: "" }],
      description: "既存の科目から選ぶか、新しい科目を入力します。",
      label: "授業科目",
      onChange: (value) => {
        if (value === "__new") {
          this.course = this.newCourseInput?.value.trim() ?? "";
          this.showNewCourse(true);
          return;
        }
        this.course = value;
        this.showNewCourse(false);
      },
      value: "",
    });

    this.newCourseRow = fieldRow(this.classFields, {
      description:
        "前後の空白は除きます。既存と同じ名前なら同じ科目として扱います。",
      label: "新しい科目名",
    });
    const newCourseInput = this.newCourseRow.createEl("input", {
      cls: "st-input",
      type: "text",
    });
    newCourseInput.placeholder = "例: 社会デザイン概論";
    newCourseInput.addEventListener("input", () => {
      this.course = newCourseInput.value.trim();
    });
    this.newCourseInput = newCourseInput;

    textField(this.classFields, {
      description: "授業テンプレートのとき必須です。",
      label: "講義日",
      onChange: (value) => {
        this.lectureDate = value;
      },
      type: "date",
      value: this.lectureDate,
    });

    this.showNewCourse(false);
    this.updateClassFields();
    void this.loadCourses();

    this.candidatesEl = body.createDiv({ cls: "seiton-class-candidates" });
    this.statusEl = body.createDiv({ cls: "st-status" });

    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });
    button(footer, {
      label: "作成",
      onClick: () => {
        void this.submit();
      },
      tone: "primary",
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.statusEl = null;
    this.candidatesEl = null;
    this.classFields = null;
    this.courseControl = null;
    this.newCourseInput = null;
    this.newCourseRow = null;
  }

  private showNewCourse(show: boolean): void {
    if (this.newCourseRow) {
      this.newCourseRow.style.display = show ? "" : "none";
    }
    if (show) {
      this.newCourseInput?.focus();
    }
  }

  private async loadCourses(): Promise<void> {
    const control = this.courseControl;
    if (!control) {
      return;
    }
    const index = await this.indexService.get();
    const counts = new Map<string, number>();
    for (const note of index.notes) {
      if (note.archived || note.kind !== "class" || !note.course.trim()) {
        continue;
      }
      counts.set(note.course.trim(), (counts.get(note.course.trim()) ?? 0) + 1);
    }
    const courses = [...counts.keys()].sort((left, right) =>
      left.localeCompare(right, "ja")
    );
    control.setChoices([
      { label: "既存の科目から選択", value: "" },
      ...courses.map((course) => ({
        label: `${course}（${counts.get(course) ?? 0}）`,
        value: course,
      })),
      { label: "＋ 新しい科目を入力", value: "__new" },
    ]);
    if (courses.length === 0) {
      control.setValue("__new");
      this.showNewCourse(true);
    }
  }

  private updateClassFields(): void {
    if (this.classFields) {
      this.classFields.style.display = this.template === "class" ? "" : "none";
    }
    this.candidatesEl?.empty();
    this.forceCreate = false;
  }

  private async submit(): Promise<void> {
    if (this.template === "class") {
      if (!this.course.trim()) {
        this.setStatus("授業科目を入力してください。", true);
        return;
      }
      if (!this.lectureDate) {
        this.setStatus("講義日を入力してください。", true);
        return;
      }
      if (!this.forceCreate) {
        try {
          const candidates = await this.noteService.findClassCandidates(
            this.course,
            this.lectureDate
          );
          if (candidates.length > 0) {
            this.renderCandidates(candidates);
            return;
          }
        } catch (error) {
          this.setStatus(userMessageOf(error), true);
          return;
        }
      }
    }

    try {
      this.setStatus("作成中…");
      const path = await this.noteService.createNote({
        course: this.template === "class" ? this.course : null,
        lectureDate: this.template === "class" ? this.lectureDate : null,
        project: this.project.trim() || this.defaultProject || null,
        template: this.template,
        title: this.title,
      });
      this.onCreated(path);
      this.close();
    } catch (error) {
      this.setStatus(userMessageOf(error), true);
    }
  }

  private renderCandidates(candidates: ClassCandidate[]): void {
    if (!this.candidatesEl) {
      return;
    }
    this.candidatesEl.empty();
    const box = this.candidatesEl.createDiv({
      cls: "seiton-class-candidate-box",
    });
    box.createEl("p", {
      cls: "seiton-class-candidate-title",
      text: "同じ日・同じ科目のノートがあります。",
    });
    for (const candidate of candidates) {
      const row = box.createDiv({ cls: "seiton-class-candidate" });
      const text = row.createDiv({ cls: "seiton-class-candidate-text" });
      text.createDiv({ text: candidate.title });
      const fileName = candidate.path.split("/").pop() ?? candidate.path;
      const meta = text.createDiv({
        cls: "seiton-class-candidate-meta",
        text: `${candidate.lectureDate} · ${fileName}`,
      });
      meta.title = candidate.path;
      const open = row.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-class-candidate-open",
        text: "既存を開く",
      });
      open.addEventListener("click", () => {
        this.onCreated(candidate.path);
        this.close();
      });
    }
    const another = box.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-class-candidate-create",
      text: "別ノートを作成",
    });
    another.addEventListener("click", () => {
      this.forceCreate = true;
      this.candidatesEl?.empty();
      void this.submit();
    });
    this.candidatesEl.scrollIntoView({ block: "nearest" });
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }
}
