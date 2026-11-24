import type { App } from "obsidian";
import { Modal } from "obsidian";
import {
  type ClassSessionEntry,
  findSessionForDate,
  listCourseSessions,
  resolveSuggestedSession,
} from "../domain/classSchedule";
import { userMessageOf } from "../domain/errors";
import {
  type ClassNoteType,
  NOTE_TEMPLATES,
  type NoteTemplateId,
} from "../domain/noteTemplates";
import { buildVocabulary } from "../domain/vocabulary";
import { loadClassSchedule } from "../services/classSchedule";
import type { ClassCandidate, NoteService } from "../services/noteService";
import type { CourseRegistration, SeitonSettings } from "../services/settings";
import type { VaultIndexService } from "../services/vaultIndex";
import { button, fieldRow, selectField, textField } from "./ui/field";
import { buildSeitonModal } from "./ui/modal";
import { createSelect, type SelectControl } from "./ui/select";
import { renderVocabularyChips } from "./vocabularyChips";

function todayKey(): string {
  const date = new Date();
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

const EXTRA_NOTE_PRESETS = [
  "宿題",
  "ディスカッション",
  "レポート",
  "メモ",
] as const;

export interface NewNoteModalOptions {
  defaultClassNoteType?: ClassNoteType;
  defaultCourse?: string;
  defaultTemplate?: NoteTemplateId;
  getSettings?: () => SeitonSettings;
}

export class NewNoteModal extends Modal {
  private readonly noteService: NoteService;
  private readonly indexService: VaultIndexService;
  private readonly defaultProject: string;
  private readonly onCreated: (path: string) => void;
  private readonly getSettings?: () => SeitonSettings;
  private template: NoteTemplateId = "note";
  private classNoteType: ClassNoteType = "lecture";
  private title = "";
  private project: string;
  private course = "";
  private lectureDate = todayKey();
  private session: number | null = null;
  private classSchedule: ClassSessionEntry[] = [];
  private titleInput: HTMLInputElement | null = null;
  private dateInput: HTMLInputElement | null = null;
  private courseControl: SelectControl | null = null;
  private sessionFieldRow: HTMLElement | null = null;
  private sessionControl: SelectControl | null = null;
  private extraPresetRow: HTMLElement | null = null;
  private modeLectureBtn: HTMLButtonElement | null = null;
  private modeExtraBtn: HTMLButtonElement | null = null;
  private newCourseInput: HTMLInputElement | null = null;
  private newCourseRow: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private candidatesEl: HTMLElement | null = null;
  private classFields: HTMLElement | null = null;
  private forceCreate = false;

  constructor(
    app: App,
    noteService: NoteService,
    indexService: VaultIndexService,
    defaultProject: string,
    onCreated: (path: string) => void,
    options?: NewNoteModalOptions
  ) {
    super(app);
    this.noteService = noteService;
    this.indexService = indexService;
    this.defaultProject = defaultProject;
    this.project = defaultProject;
    this.onCreated = onCreated;
    this.getSettings = options?.getSettings;
    if (options?.defaultTemplate) {
      this.template = options.defaultTemplate;
    }
    if (options?.defaultClassNoteType) {
      this.classNoteType = options.defaultClassNoteType;
    }
    if (options?.defaultCourse) {
      this.course = options.defaultCourse;
    }
  }

  override onOpen(): void {
    const { body, footer } = buildSeitonModal(this, {
      description:
        "本文はObsidian標準エディターで編集します。タイトルとテンプレートだけ選びます。",
      title: "新しいノート",
    });

    const quickClassSection = body.createDiv({
      cls: "seiton-quick-class-section",
    });
    quickClassSection.style.display = "none";

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
        "空欄なら授業は「講義日 科目名」、授業外は「授業外」、それ以外は「無題」になります。",
      label: "タイトル",
      onChange: (value) => {
        this.title = value;
      },
      placeholder: "例: 認知科学の授業メモ",
    });
    this.titleInput = titleInput;
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

    const modeRow = fieldRow(this.classFields, {
      description:
        "宿題・ディスカッション等の授業外メモは講義回と切り離して作成できます。",
      label: "ノート種別",
    });
    const modeToggle = modeRow.createDiv({
      attr: { "aria-label": "授業ノート種別", role: "group" },
      cls: "seiton-class-mode-toggle",
    });
    this.modeLectureBtn = modeToggle.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-class-mode-btn",
      text: "講義回ノート",
    });
    this.modeExtraBtn = modeToggle.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-class-mode-btn",
      text: "授業外ノート（宿題・ディスカッション等）",
    });
    this.modeLectureBtn.addEventListener("click", () => {
      this.setClassNoteType("lecture");
    });
    this.modeExtraBtn.addEventListener("click", () => {
      this.setClassNoteType("extra");
    });

    this.extraPresetRow = fieldRow(this.classFields, {
      description:
        "種別をクリックするとタイトルに入ります（必要なら後ろに番号等を追記できます）。",
      label: "授業外の種類",
    });
    const presetChips = this.extraPresetRow.createDiv({
      cls: "seiton-extra-preset-row",
    });
    for (const preset of EXTRA_NOTE_PRESETS) {
      const btn = presetChips.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-extra-preset-chip",
        text: preset,
      });
      btn.addEventListener("click", () => {
        this.title = preset;
        if (this.titleInput) {
          this.titleInput.value = preset;
          this.titleInput.focus();
        }
      });
    }

    this.courseControl = selectField(this.classFields, {
      choices: [{ label: "既存の科目から選択", value: "" }],
      description: "既存の科目から選ぶか、新しい科目を入力します。",
      label: "授業科目",
      onChange: (value) => {
        if (value === "__new") {
          this.course = this.newCourseInput?.value.trim() ?? "";
          this.showNewCourse(true);
          this.syncSessionOptions(false);
          return;
        }
        this.course = value;
        this.showNewCourse(false);
        this.syncSessionOptions(true);
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
      this.syncSessionOptions(false);
    });
    this.newCourseInput = newCourseInput;

    const sessionRow = fieldRow(this.classFields, {
      description: "開講日カレンダーから講義回を選ぶと日付も自動で揃います。",
      label: "講義回（開講日）",
    });
    sessionRow.style.display = "none";
    this.sessionFieldRow = sessionRow;
    const sessionSelect = createSelect({
      choices: [{ label: "日付を手動指定", value: "__manual" }],
      onChange: (value) => {
        if (value === "__manual") {
          const reg = this.resolveCourseRegistration(this.course);
          const matched = findSessionForDate(
            this.classSchedule,
            this.course,
            this.lectureDate,
            reg?.term
          );
          this.session = matched?.round ?? null;
          return;
        }
        const [roundStr = "", dateStr = ""] = value.split(":");
        const round = Number(roundStr);
        if (dateStr) {
          this.lectureDate = dateStr;
          if (this.dateInput) {
            this.dateInput.value = dateStr;
          }
        }
        this.session = Number.isInteger(round) && round > 0 ? round : null;
      },
      value: "__manual",
    });
    sessionRow.append(sessionSelect.element);
    this.sessionControl = sessionSelect;

    this.dateInput = textField(this.classFields, {
      description: "授業テンプレートのとき必須です。",
      label: "講義日",
      onChange: (value) => {
        this.lectureDate = value;
        if (this.classNoteType === "lecture") {
          const reg = this.resolveCourseRegistration(this.course);
          const matched = findSessionForDate(
            this.classSchedule,
            this.course,
            value,
            reg?.term
          );
          if (matched && this.sessionControl) {
            this.session = matched.round;
            this.sessionControl.setValue(`${matched.round}:${matched.date}`);
          } else {
            this.session = null;
            this.sessionControl?.setValue("__manual");
          }
        }
      },
      type: "date",
      value: this.lectureDate,
    });

    this.showNewCourse(false);
    this.updateClassFields();
    void this.initClassData(quickClassSection);

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
    this.titleInput = null;
    this.dateInput = null;
    this.courseControl = null;
    this.sessionFieldRow = null;
    this.sessionControl = null;
    this.extraPresetRow = null;
    this.modeLectureBtn = null;
    this.modeExtraBtn = null;
    this.newCourseInput = null;
    this.newCourseRow = null;
  }

  private resolveCourseRegistration(
    courseName: string
  ): CourseRegistration | undefined {
    const trimmed = courseName.trim();
    if (!trimmed) {
      return undefined;
    }
    const settings = this.getSettings?.();
    const courses = settings?.courses ?? [];
    return (
      courses.find(
        (c) =>
          c.name.trim() === trimmed &&
          c.grade === settings?.currentGrade &&
          c.term === settings?.currentTerm
      ) ?? courses.find((c) => c.name.trim() === trimmed)
    );
  }

  private async initClassData(quickClassSection: HTMLElement): Promise<void> {
    this.classSchedule = await loadClassSchedule(this.app);
    await Promise.all([
      this.loadCourses(),
      this.renderQuickClassPills(quickClassSection),
    ]);
  }

  private setClassNoteType(nextType: ClassNoteType): void {
    if (this.classNoteType === nextType) {
      return;
    }
    this.classNoteType = nextType;
    this.candidatesEl?.empty();
    this.forceCreate = false;
    if (nextType === "extra") {
      this.session = null;
      this.lectureDate = todayKey();
      if (this.dateInput) {
        this.dateInput.value = this.lectureDate;
      }
    }
    this.updateClassModeUI();
    if (nextType === "lecture") {
      this.syncSessionOptions(true);
    }
  }

  private updateClassModeUI(): void {
    const isLecture = this.classNoteType === "lecture";
    this.modeLectureBtn?.toggleClass("is-active", isLecture);
    this.modeExtraBtn?.toggleClass("is-active", !isLecture);
    this.modeLectureBtn?.setAttribute("aria-pressed", String(isLecture));
    this.modeExtraBtn?.setAttribute("aria-pressed", String(!isLecture));
    if (this.extraPresetRow) {
      this.extraPresetRow.style.display = isLecture ? "none" : "";
    }
    if (this.titleInput) {
      this.titleInput.placeholder =
        this.template === "class" && !isLecture
          ? "例: 宿題 / ディスカッション1 / レポート"
          : "例: 認知科学の授業メモ";
    }
    if (!isLecture && this.sessionFieldRow) {
      this.sessionFieldRow.style.display = "none";
    }
  }

  private syncSessionOptions(autoSelectSuggested: boolean): void {
    if (!(this.sessionFieldRow && this.sessionControl)) {
      return;
    }
    const reg = this.resolveCourseRegistration(this.course);
    const term = reg?.term;
    const sessions = listCourseSessions(this.classSchedule, this.course, term);
    if (this.classNoteType !== "lecture" || sessions.length === 0) {
      this.sessionFieldRow.style.display = "none";
      if (this.classNoteType === "extra") {
        this.session = null;
      }
      return;
    }

    this.sessionFieldRow.style.display = "";
    const choices = [
      ...sessions.map((entry) => {
        const slotParts = [entry.dayOfWeek, entry.period].filter(Boolean);
        const slot = slotParts.length > 0 ? `（${slotParts.join(" ")}）` : "";
        const cancelled = entry.cancelled ? " (休講)" : "";
        return {
          label: `第${entry.round}回 · ${entry.date}${slot}${cancelled}`,
          value: `${entry.round}:${entry.date}`,
        };
      }),
      { label: "日付を手動指定", value: "__manual" },
    ];
    this.sessionControl.setChoices(choices);

    const today = todayKey();
    const target = autoSelectSuggested
      ? (findSessionForDate(this.classSchedule, this.course, today, term) ??
        resolveSuggestedSession(this.classSchedule, this.course, today, term))
      : findSessionForDate(
          this.classSchedule,
          this.course,
          this.lectureDate,
          term
        );

    if (target) {
      this.lectureDate = target.date;
      if (this.dateInput) {
        this.dateInput.value = target.date;
      }
      this.session = target.round;
      this.sessionControl.setValue(`${target.round}:${target.date}`);
    } else {
      this.session = null;
      this.sessionControl.setValue("__manual");
    }
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
    const settings = this.getSettings?.();
    const currentGrade = settings?.currentGrade;
    const currentTerm = settings?.currentTerm;
    const currentRegisteredCourses = new Set(
      settings?.courses
        .filter((c) => c.grade === currentGrade && c.term === currentTerm)
        .map((c) => c.name.trim()) ?? []
    );

    const counts = new Map<string, number>();
    for (const note of index.notes) {
      if (note.archived || note.kind !== "class" || !note.course.trim()) {
        continue;
      }
      counts.set(note.course.trim(), (counts.get(note.course.trim()) ?? 0) + 1);
    }

    // 当学期の科目はノート数が0でも含める
    for (const course of currentRegisteredCourses) {
      if (!counts.has(course)) {
        counts.set(course, 0);
      }
    }

    const currentChoices: Array<{ label: string; value: string }> = [];
    const otherChoices: Array<{ label: string; value: string }> = [];

    const sortedCourses = [...counts.keys()].sort((left, right) =>
      left.localeCompare(right, "ja")
    );

    for (const course of sortedCourses) {
      const count = counts.get(course) ?? 0;
      if (currentRegisteredCourses.has(course)) {
        currentChoices.push({
          label: `[当学期] ${course}（${count}）`,
          value: course,
        });
      } else {
        otherChoices.push({
          label: `${course}（${count}）`,
          value: course,
        });
      }
    }

    const allChoices = [
      { label: "既存の科目から選択", value: "" },
      ...currentChoices,
      ...otherChoices,
      { label: "＋ 新しい科目を入力", value: "__new" },
    ];
    control.setChoices(allChoices);

    if (this.course && counts.has(this.course)) {
      control.setValue(this.course);
      this.showNewCourse(false);
      this.syncSessionOptions(this.classNoteType === "lecture");
    } else if (counts.size === 0) {
      control.setValue("__new");
      this.showNewCourse(true);
      this.syncSessionOptions(false);
    } else {
      this.syncSessionOptions(false);
    }
  }

  private async renderQuickClassPills(container: HTMLElement): Promise<void> {
    const index = await this.indexService.get();
    const settings = this.getSettings?.();
    const currentGrade = settings?.currentGrade;
    const currentTerm = settings?.currentTerm;
    const currentRegisteredCourses = new Set(
      settings?.courses
        .filter((c) => c.grade === currentGrade && c.term === currentTerm)
        .map((c) => c.name.trim()) ?? []
    );

    const stats = new Map<
      string,
      { count: number; isCurrent: boolean; lastMtime: number }
    >();

    // まず当学期の登録科目をシード
    for (const course of currentRegisteredCourses) {
      stats.set(course, { count: 0, isCurrent: true, lastMtime: 0 });
    }

    for (const note of index.notes) {
      if (note.archived || note.kind !== "class" || !note.course.trim()) {
        continue;
      }
      if (note.frontmatter.class_note_type === "extra") {
        continue;
      }
      const course = note.course.trim();
      const current = stats.get(course) ?? {
        count: 0,
        isCurrent: currentRegisteredCourses.has(course),
        lastMtime: 0,
      };
      stats.set(course, {
        count: current.count + 1,
        isCurrent: current.isCurrent,
        lastMtime: Math.max(current.lastMtime, note.mtime),
      });
    }

    // ソート：当学期優先、次にノート数・更新日降順
    const topCourses = [...stats.entries()]
      .sort((a, b) => {
        if (a[1].isCurrent !== b[1].isCurrent) {
          return a[1].isCurrent ? -1 : 1;
        }
        return b[1].count - a[1].count || b[1].lastMtime - a[1].lastMtime;
      })
      .slice(0, 8);

    if (topCourses.length === 0) {
      return;
    }

    container.empty();
    container.style.display = "";

    const head = container.createDiv({ cls: "seiton-quick-class-head" });
    head.createSpan({
      cls: "seiton-quick-class-label",
      text: "科目から1タップで今日の授業ノートを作成",
    });

    const today = todayKey();
    const pills = container.createDiv({ cls: "seiton-quick-class-pills" });
    for (const [course, info] of topCourses) {
      const reg = this.resolveCourseRegistration(course);
      const matched =
        findSessionForDate(this.classSchedule, course, today, reg?.term) ??
        resolveSuggestedSession(this.classSchedule, course, today, reg?.term);
      const nextRound = matched ? matched.round : info.count + 1;
      const targetDate = matched ? matched.date : today;
      const label = `${course}（第${nextRound}回）`;
      const pill = pills.createEl("button", {
        attr: {
          title: `「${targetDate} ${course}（第${nextRound}回）」を作成`,
          type: "button",
        },
        cls: `seiton-quick-class-pill st-pill${info.isCurrent ? " is-current" : ""}`,
        text: label,
      });
      pill.addEventListener("click", () => {
        this.template = "class";
        this.classNoteType = "lecture";
        this.course = course;
        this.lectureDate = targetDate;
        this.session = matched ? matched.round : null;
        this.title = `${targetDate} ${course}（第${nextRound}回）`;
        void this.submit();
      });
    }
  }

  private updateClassFields(): void {
    if (this.classFields) {
      this.classFields.style.display = this.template === "class" ? "" : "none";
    }
    this.updateClassModeUI();
    if (this.template === "class" && this.classNoteType === "lecture") {
      this.syncSessionOptions(false);
    }
    this.candidatesEl?.empty();
    this.forceCreate = false;
  }

  private async submit(): Promise<void> {
    const isClass = this.template === "class";
    const isExtraClass = isClass && this.classNoteType === "extra";

    if (isClass) {
      if (!this.course.trim()) {
        this.setStatus("授業科目を入力してください。", true);
        return;
      }
      if (!this.lectureDate) {
        this.setStatus("講義日を入力してください。", true);
        return;
      }
      if (!isExtraClass && !this.forceCreate) {
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
      const settings = this.getSettings?.();
      const matchedCourse = isClass
        ? this.resolveCourseRegistration(this.course)
        : undefined;
      const fallbackSession =
        isClass && !isExtraClass
          ? (this.session ??
            findSessionForDate(
              this.classSchedule,
              this.course,
              this.lectureDate,
              matchedCourse?.term
            )?.round ??
            null)
          : null;

      const path = await this.noteService.createNote({
        classNoteType: isExtraClass ? "extra" : null,
        course: isClass ? this.course : null,
        extraLabel: isExtraClass ? this.title.trim() || "授業外" : null,
        grade: isClass
          ? (matchedCourse?.grade ?? settings?.currentGrade ?? null)
          : null,
        lectureDate: isClass ? this.lectureDate : null,
        pinned: isExtraClass ? true : undefined,
        project: this.project.trim() || this.defaultProject || null,
        session: fallbackSession,
        template: this.template,
        term: isClass
          ? (matchedCourse?.term ?? settings?.currentTerm ?? null)
          : null,
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
