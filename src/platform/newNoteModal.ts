import type { App } from "obsidian";
import { ButtonComponent, Modal, Setting, type TextComponent } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { NOTE_TEMPLATES, type NoteTemplateId } from "../domain/noteTemplates";
import { buildVocabulary } from "../domain/vocabulary";
import type { ClassCandidate, NoteService } from "../services/noteService";
import type { VaultIndexService } from "../services/vaultIndex";
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
  private courseSelect: HTMLSelectElement | null = null;
  private newCourseInput: HTMLInputElement | null = null;
  private newCourseSetting: HTMLElement | null = null;
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
    this.modalEl.addClass("seiton-new-note-modal");
    this.setTitle("新しいノート");
    this.contentEl.createEl("p", {
      cls: "seiton-prompt-hint",
      text: "本文はObsidian標準エディターで編集します。タイトルとテンプレートだけ選びます。",
    });

    new Setting(this.contentEl)
      .setName("テンプレート")
      .addDropdown((dropdown) => {
        for (const template of NOTE_TEMPLATES) {
          dropdown.addOption(template.id, template.label);
        }
        dropdown.setValue(this.template).onChange((value) => {
          this.template = value as NoteTemplateId;
          this.updateClassFields();
        });
      });
    new Setting(this.contentEl)
      .setName("タイトル")
      .setDesc(
        "空欄なら授業は「講義日 科目名」、それ以外は「無題」になります。"
      )
      .addText((text: TextComponent) => {
        text.setPlaceholder("例: 認知科学の授業メモ").onChange((value) => {
          this.title = value;
        });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });
    let projectText: TextComponent | null = null;
    new Setting(this.contentEl)
      .setName("プロジェクト")
      .setDesc("任意。空欄なら関連付けません。")
      .addText((text: TextComponent) => {
        projectText = text;
        text.setValue(this.project).onChange((value) => {
          this.project = value;
        });
      });
    const cached = this.indexService.getCached();
    if (cached) {
      const row = this.contentEl.createDiv({ cls: "seiton-vocab-row" });
      renderVocabularyChips(
        row,
        buildVocabulary(cached.notes.map((note) => note.projects)),
        {
          current: this.project ? [this.project] : [],
          label: "既存",
          onPick: (value) => {
            this.project = value;
            projectText?.setValue(value);
          },
        }
      );
    }

    this.classFields = this.contentEl.createDiv({
      cls: "seiton-class-fields",
    });
    const courseSetting = new Setting(this.classFields)
      .setName("授業科目")
      .setDesc("既存の科目から選ぶか、新しい科目を入力します。");
    this.courseSelect = courseSetting.controlEl.createEl("select", {
      attr: { "aria-label": "授業科目" },
      cls: "dropdown seiton-course-select",
    });
    this.courseSelect.addEventListener("change", () => {
      const value = this.courseSelect?.value ?? "";
      if (value === "__new") {
        this.course = this.newCourseInput?.value.trim() ?? "";
        this.showNewCourse(true);
      } else {
        this.course = value;
        this.showNewCourse(false);
      }
    });
    const newCourseSetting = new Setting(this.classFields)
      .setName("新しい科目名")
      .setDesc(
        "前後の空白は除きます。既存と同じ名前なら同じ科目として扱います。"
      );
    this.newCourseInput = newCourseSetting.controlEl.createEl("input", {
      attr: { placeholder: "例: 社会デザイン概論", type: "text" },
      cls: "seiton-new-course-input",
    });
    this.newCourseInput.addEventListener("input", () => {
      this.course = this.newCourseInput?.value.trim() ?? "";
    });
    this.newCourseSetting = newCourseSetting.settingEl;
    this.showNewCourse(false);
    new Setting(this.classFields)
      .setName("講義日")
      .setDesc("授業テンプレートのとき必須です。")
      .addText((text: TextComponent) => {
        text.inputEl.type = "date";
        text.setValue(this.lectureDate).onChange((value) => {
          this.lectureDate = value;
        });
      });
    this.updateClassFields();
    void this.loadCourses();

    this.candidatesEl = this.contentEl.createDiv({
      cls: "seiton-class-candidates",
    });
    this.statusEl = this.contentEl.createDiv({ cls: "seiton-modal-status" });
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

  private showNewCourse(show: boolean): void {
    if (this.newCourseSetting) {
      this.newCourseSetting.style.display = show ? "" : "none";
    }
    if (show) {
      this.newCourseInput?.focus();
    }
  }

  private async loadCourses(): Promise<void> {
    if (!this.courseSelect) {
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
    this.courseSelect.empty();
    this.courseSelect.createEl("option", {
      text: "既存の科目から選択",
      value: "",
    });
    for (const course of courses) {
      this.courseSelect.createEl("option", {
        text: `${course}（${counts.get(course) ?? 0}）`,
        value: course,
      });
    }
    this.courseSelect.createEl("option", {
      text: "＋ 新しい科目を入力",
      value: "__new",
    });
    if (courses.length === 0) {
      this.courseSelect.value = "__new";
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
