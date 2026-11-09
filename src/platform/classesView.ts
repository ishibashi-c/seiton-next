import type { App, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { ItemView, Modal, normalizePath, TFile } from "obsidian";
import { COURSES_FILE, SYSTEM_FOLDER, VIEW_TYPE_CLASSES } from "../config";
import { userMessageOf } from "../domain/errors";
import {
  buildFrontmatter,
  scanFrontmatter,
  yamlQuoted,
} from "../domain/frontmatter";
import type { NoteService } from "../services/noteService";
import type {
  AcademicGrade,
  AcademicTerm,
  CourseRegistration,
  SeitonSettings,
} from "../services/settings";
import type { NoteRecord, VaultIndexService } from "../services/vaultIndex";
import { NewNoteModal } from "./newNoteModal";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import { button, selectField, textField } from "./ui/field";
import { buildSeitonModal } from "./ui/modal";
import { showToast } from "./ui/toast";

/**
 * 履修科目・当学期設定を `Seiton/System/Courses.md` に Markdown として保存する。
 * これにより data.json を同期しない環境でも .md ファイルとして完全に同期される。
 */
export async function saveCoursesLedgerMarkdown(
  app: App,
  settings: Pick<SeitonSettings, "courses" | "currentGrade" | "currentTerm">
): Promise<void> {
  const fm = buildFrontmatter(
    {
      current_grade: yamlQuoted(settings.currentGrade),
      current_term: yamlQuoted(settings.currentTerm),
      kind: "course-ledger",
    },
    "\n"
  );
  const rows = settings.courses.map((c) => {
    const safeName = c.name.replace(/\|/gu, "｜").trim();
    return `| ${safeName} | ${c.grade} | ${c.term} | ${c.dayOfWeek ?? ""} | ${c.period ?? ""} | ${c.id} |`;
  });
  const body = [
    "# 履修科目・学期台帳",
    "",
    "| 科目名 | 学年 | 学期 | 曜日 | 時限 | ID |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  const content = `${fm}\n${body}`;
  const path = normalizePath(COURSES_FILE);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  const segments = normalizePath(SYSTEM_FOLDER).split("/");
  let cur = "";
  for (const seg of segments) {
    cur = cur ? `${cur}/${seg}` : seg;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {
        // 既存なら無視
      }
    }
  }
  await app.vault.create(path, content);
}

/**
 * `Seiton/System/Courses.md` が存在する場合、そこから当学期・履修科目を読み込んで設定と同期する。
 */
export async function loadCoursesLedgerMarkdown(
  app: App,
  getSettings: () => SeitonSettings,
  saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(normalizePath(COURSES_FILE));
  if (!(file instanceof TFile)) {
    return;
  }
  try {
    const text = await app.vault.cachedRead(file);
    const scanned = scanFrontmatter(text);
    const validGrades = new Set(["1年", "2年", "3年", "4年"]);
    const validTerms = new Set(["前期", "後期", "通年", "集中"]);
    const rawGrade = scanned.fields.current_grade?.trim() ?? "";
    const rawTerm = scanned.fields.current_term?.trim() ?? "";
    const current = getSettings();
    const currentGrade = validGrades.has(rawGrade)
      ? (rawGrade as AcademicGrade)
      : current.currentGrade;
    const currentTerm = validTerms.has(rawTerm)
      ? (rawTerm as AcademicTerm)
      : current.currentTerm;

    const courses: CourseRegistration[] = [];
    const lines = text.slice(scanned.bodyStartOffset).split(/\r?\n/u);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!(trimmed.startsWith("|") && trimmed.endsWith("|"))) {
        continue;
      }
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      if (cells.length < 3) {
        continue;
      }
      const [
        name = "",
        grade = "",
        term = "",
        dayOfWeek = "",
        period = "",
        id = "",
      ] = cells;
      if (
        !name ||
        name === "科目名" ||
        name.startsWith("---") ||
        !validGrades.has(grade) ||
        !validTerms.has(term)
      ) {
        continue;
      }
      courses.push({
        dayOfWeek: dayOfWeek || undefined,
        grade: grade as AcademicGrade,
        id: id || `c_${courses.length + 1}`,
        name,
        period: period || undefined,
        term: term as AcademicTerm,
      });
    }

    const changed =
      currentGrade !== current.currentGrade ||
      currentTerm !== current.currentTerm ||
      JSON.stringify(courses) !== JSON.stringify(current.courses);
    if (changed) {
      await saveSettings({ courses, currentGrade, currentTerm });
    }
  } catch {
    // 読み込み失敗時は既存設定を維持
  }
}

function todayKey(): string {
  const date = new Date();
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export interface EnrichedClassNote {
  course: string;
  excerpt: string;
  grade: AcademicGrade;
  isInferred: boolean;
  lectureDate: string;
  mtime: number;
  path: string;
  record: NoteRecord;
  round: number;
  term: AcademicTerm;
  title: string;
}

export interface CourseGroup {
  courseName: string;
  grade: AcademicGrade;
  isInferred: boolean;
  maxRound: number;
  notes: EnrichedClassNote[];
  registration?: CourseRegistration;
  term: AcademicTerm;
}

/** 科目の新規登録・編集モーダル */
export class CourseManageModal extends Modal {
  private readonly getSettings: () => SeitonSettings;
  private readonly saveSettings: (
    patch: Partial<SeitonSettings>
  ) => Promise<void>;
  private readonly notes: NoteService;
  private readonly onSaved: () => void;
  private readonly editingCourse?: CourseRegistration;
  private name = "";
  private grade: AcademicGrade;
  private term: AcademicTerm;
  private dayOfWeek = "";
  private period = "";
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    notes: NoteService,
    getSettings: () => SeitonSettings,
    saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>,
    onSaved: () => void,
    courseToEdit?: CourseRegistration
  ) {
    super(app);
    this.notes = notes;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.onSaved = onSaved;
    this.editingCourse = courseToEdit;
    const current = getSettings();
    this.name = courseToEdit?.name ?? "";
    this.grade = courseToEdit?.grade ?? current.currentGrade;
    this.term = courseToEdit?.term ?? current.currentTerm;
    this.dayOfWeek = courseToEdit?.dayOfWeek ?? "";
    this.period = courseToEdit?.period ?? "";
  }

  override onOpen(): void {
    const isEdit = Boolean(this.editingCourse);
    const { body, footer } = buildSeitonModal(this, {
      description: "履修科目の学年・学期・曜日・時限を設定します。",
      title: isEdit ? "科目を編集" : "科目を登録",
    });

    textField(body, {
      label: "科目名",
      onChange: (value) => {
        this.name = value;
      },
      placeholder: "例: 認知科学",
      value: this.name,
    });

    selectField(body, {
      choices: [
        { label: "1年", value: "1年" },
        { label: "2年", value: "2年" },
        { label: "3年", value: "3年" },
        { label: "4年", value: "4年" },
      ],
      label: "学年",
      onChange: (value) => {
        this.grade = value as AcademicGrade;
      },
      value: this.grade,
    });

    selectField(body, {
      choices: [
        { label: "前期", value: "前期" },
        { label: "後期", value: "後期" },
        { label: "通年", value: "通年" },
        { label: "集中", value: "集中" },
      ],
      label: "学期",
      onChange: (value) => {
        this.term = value as AcademicTerm;
      },
      value: this.term,
    });

    selectField(body, {
      choices: [
        { label: "指定なし", value: "" },
        { label: "月曜日", value: "月" },
        { label: "火曜日", value: "火" },
        { label: "水曜日", value: "水" },
        { label: "木曜日", value: "木" },
        { label: "金曜日", value: "金" },
        { label: "土曜日", value: "土" },
        { label: "集中", value: "集中" },
      ],
      label: "曜日",
      onChange: (value) => {
        this.dayOfWeek = value;
      },
      value: this.dayOfWeek,
    });

    selectField(body, {
      choices: [
        { label: "指定なし", value: "" },
        { label: "1限", value: "1限" },
        { label: "2限", value: "2限" },
        { label: "3限", value: "3限" },
        { label: "4限", value: "4限" },
        { label: "5限", value: "5限" },
        { label: "6限", value: "6限" },
        { label: "7限", value: "7限" },
      ],
      label: "時限",
      onChange: (value) => {
        this.period = value;
      },
      value: this.period,
    });

    this.statusEl = body.createDiv({ cls: "st-status" });

    if (isEdit) {
      button(footer, {
        label: "削除",
        onClick: () => {
          void this.handleDelete();
        },
        tone: "danger",
      });
    }

    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });

    button(footer, {
      label: isEdit ? "保存" : "登録",
      onClick: () => {
        void this.handleSave();
      },
      tone: "primary",
    });
  }

  private async handleSave(): Promise<void> {
    const trimmed = this.name.trim();
    if (!trimmed) {
      this.statusEl?.setText("科目名を入力してください。");
      this.statusEl?.addClass("is-error");
      return;
    }

    const current = this.getSettings();
    let updatedCourses: CourseRegistration[];
    if (this.editingCourse) {
      updatedCourses = current.courses.map((course) =>
        course.id === this.editingCourse?.id
          ? {
              ...course,
              dayOfWeek: this.dayOfWeek || undefined,
              grade: this.grade,
              name: trimmed,
              period: this.period || undefined,
              term: this.term,
            }
          : course
      );
    } else {
      const newCourse: CourseRegistration = {
        dayOfWeek: this.dayOfWeek || undefined,
        grade: this.grade,
        id: `c_${Date.now().toString(36)}`,
        name: trimmed,
        period: this.period || undefined,
        term: this.term,
      };
      updatedCourses = [...current.courses, newCourse];
    }

    try {
      await this.saveSettings({ courses: updatedCourses });
      await saveCoursesLedgerMarkdown(this.app, {
        courses: updatedCourses,
        currentGrade: current.currentGrade,
        currentTerm: current.currentTerm,
      });
      const targetCourseName = this.editingCourse?.name ?? trimmed;
      await this.notes.updateCourseNotesMetadata(targetCourseName, {
        course: trimmed,
        grade: this.grade,
        term: this.term,
      });
      this.onSaved();
      this.close();
    } catch (error) {
      this.statusEl?.setText(userMessageOf(error));
      this.statusEl?.addClass("is-error");
    }
  }

  private async handleDelete(): Promise<void> {
    if (!this.editingCourse) {
      return;
    }
    const current = this.getSettings();
    const updatedCourses = current.courses.filter(
      (course) => course.id !== this.editingCourse?.id
    );
    try {
      await this.saveSettings({ courses: updatedCourses });
      await saveCoursesLedgerMarkdown(this.app, {
        courses: updatedCourses,
        currentGrade: current.currentGrade,
        currentTerm: current.currentTerm,
      });
      this.onSaved();
      this.close();
    } catch (error) {
      this.statusEl?.setText(userMessageOf(error));
      this.statusEl?.addClass("is-error");
    }
  }
}

/** 現在の学年・学期の設定モーダル */
export class SetCurrentTermModal extends Modal {
  private readonly getSettings: () => SeitonSettings;
  private readonly saveSettings: (
    patch: Partial<SeitonSettings>
  ) => Promise<void>;
  private readonly onSaved: () => void;
  private grade: AcademicGrade;
  private term: AcademicTerm;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    getSettings: () => SeitonSettings,
    saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>,
    onSaved: () => void
  ) {
    super(app);
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.onSaved = onSaved;
    const current = getSettings();
    this.grade = current.currentGrade;
    this.term = current.currentTerm;
  }

  override onOpen(): void {
    const { body, footer } = buildSeitonModal(this, {
      description:
        "大学の現在の学年と学期を設定します。講義ノートの作成時にデフォルトとして適用されます。",
      title: "当学期を設定",
    });

    selectField(body, {
      choices: [
        { label: "1年", value: "1年" },
        { label: "2年", value: "2年" },
        { label: "3年", value: "3年" },
        { label: "4年", value: "4年" },
      ],
      label: "学年",
      onChange: (value) => {
        this.grade = value as AcademicGrade;
      },
      value: this.grade,
    });

    selectField(body, {
      choices: [
        { label: "前期", value: "前期" },
        { label: "後期", value: "後期" },
        { label: "通年", value: "通年" },
        { label: "集中", value: "集中" },
      ],
      label: "学期",
      onChange: (value) => {
        this.term = value as AcademicTerm;
      },
      value: this.term,
    });

    this.statusEl = body.createDiv({ cls: "st-status" });

    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });

    button(footer, {
      label: "保存",
      onClick: () => {
        void this.handleSave();
      },
      tone: "primary",
    });
  }

  private async handleSave(): Promise<void> {
    try {
      const current = this.getSettings();
      await this.saveSettings({
        currentGrade: this.grade,
        currentTerm: this.term,
      });
      await saveCoursesLedgerMarkdown(this.app, {
        courses: current.courses,
        currentGrade: this.grade,
        currentTerm: this.term,
      });
      this.onSaved();
      this.close();
    } catch (error) {
      this.statusEl?.setText(userMessageOf(error));
      this.statusEl?.addClass("is-error");
    }
  }
}

/** 特定科目の学年・学期変更モーダル */
export class ChangeCourseTermModal extends Modal {
  private readonly courseName: string;
  private readonly notes: NoteService;
  private readonly getSettings: () => SeitonSettings;
  private readonly saveSettings: (
    patch: Partial<SeitonSettings>
  ) => Promise<void>;
  private readonly onSaved: () => void;
  private grade: AcademicGrade;
  private term: AcademicTerm;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    notes: NoteService,
    courseName: string,
    initialGrade: AcademicGrade,
    initialTerm: AcademicTerm,
    getSettings: () => SeitonSettings,
    saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>,
    onSaved: () => void
  ) {
    super(app);
    this.notes = notes;
    this.courseName = courseName;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.onSaved = onSaved;
    this.grade = initialGrade;
    this.term = initialTerm;
  }

  override onOpen(): void {
    const { body, footer } = buildSeitonModal(this, {
      description: `「${this.courseName}」の所属学期を設定します。登録科目台帳を更新します。`,
      title: "科目の学期を変更",
    });

    selectField(body, {
      choices: [
        { label: "1年", value: "1年" },
        { label: "2年", value: "2年" },
        { label: "3年", value: "3年" },
        { label: "4年", value: "4年" },
      ],
      label: "学年",
      onChange: (value) => {
        this.grade = value as AcademicGrade;
      },
      value: this.grade,
    });

    selectField(body, {
      choices: [
        { label: "前期", value: "前期" },
        { label: "後期", value: "後期" },
        { label: "通年", value: "通年" },
        { label: "集中", value: "集中" },
      ],
      label: "学期",
      onChange: (value) => {
        this.term = value as AcademicTerm;
      },
      value: this.term,
    });

    this.statusEl = body.createDiv({ cls: "st-status" });

    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });

    button(footer, {
      label: "保存",
      onClick: () => {
        void this.handleSave();
      },
      tone: "primary",
    });
  }

  private async handleSave(): Promise<void> {
    const current = this.getSettings();
    const existingIndex = current.courses.findIndex(
      (c) => c.name === this.courseName
    );
    let updatedCourses: CourseRegistration[];
    if (existingIndex >= 0) {
      updatedCourses = current.courses.map((c, idx) =>
        idx === existingIndex ? { ...c, grade: this.grade, term: this.term } : c
      );
    } else {
      updatedCourses = [
        ...current.courses,
        {
          grade: this.grade,
          id: `c_${Date.now().toString(36)}`,
          name: this.courseName,
          term: this.term,
        },
      ];
    }

    try {
      await this.saveSettings({ courses: updatedCourses });
      await saveCoursesLedgerMarkdown(this.app, {
        courses: updatedCourses,
        currentGrade: current.currentGrade,
        currentTerm: current.currentTerm,
      });
      await this.notes.updateCourseNotesMetadata(this.courseName, {
        grade: this.grade,
        term: this.term,
      });
      this.onSaved();
      this.close();
    } catch (error) {
      this.statusEl?.setText(userMessageOf(error));
      this.statusEl?.addClass("is-error");
    }
  }
}

/** 授業専用ビュー */
export class SeitonClassesView extends ItemView {
  private readonly indexService: VaultIndexService;
  private readonly notes: NoteService;
  private readonly getSettings: () => SeitonSettings;
  private readonly saveSettings: (
    patch: Partial<SeitonSettings>
  ) => Promise<void>;
  private readonly openFile: (path: string) => Promise<void>;
  private activeFilter = "current"; // "current" | "all" | "${grade} ${term}"
  private bodyEl: HTMLElement | null = null;
  private refreshTimer: number | null = null;
  private refreshing = false;
  private refreshAgain = false;

  constructor(
    leaf: WorkspaceLeaf,
    indexService: VaultIndexService,
    notes: NoteService,
    getSettings: () => SeitonSettings,
    saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>,
    openFile: (path: string) => Promise<void>
  ) {
    super(leaf);
    this.indexService = indexService;
    this.notes = notes;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.openFile = openFile;
  }

  override getViewType(): string {
    return VIEW_TYPE_CLASSES;
  }

  override getDisplayText(): string {
    return "Seiton 授業";
  }

  override getIcon(): string {
    return "graduation-cap";
  }

  override async onOpen(): Promise<void> {
    const settings = this.getSettings();
    const { body } = mountTabShell(this, {
      actions: [
        {
          kind: "primary",
          label: "講義ノートを作成",
          onClick: () => this.openNewClassNote(),
        },
        {
          kind: "text",
          label: "＋ 科目を登録",
          onClick: () => this.openCourseManage(),
        },
        {
          kind: "text",
          label: "当学期を設定",
          onClick: () => this.openSetCurrentTerm(),
        },
      ],
      rootClasses: ["seiton-home", "seiton-classes"],
      subline: `${settings.currentGrade} ${settings.currentTerm} · 科目別の講義ノートと履修台帳`,
      tab: "classes",
      title: "授業",
    });
    body.addClass("seiton-classes-body");
    this.bodyEl = body;
    this.registerVaultEvents();
    finishTabShell(this, VIEW_TYPE_CLASSES);
    void this.refresh();
  }

  override async onClose(): Promise<void> {
    closeTabShell(this, VIEW_TYPE_CLASSES);
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.contentEl.empty();
    this.bodyEl = null;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      await loadCoursesLedgerMarkdown(
        this.app,
        this.getSettings,
        this.saveSettings
      );
      const index = await this.indexService.get();
      if (!this.bodyEl) {
        return;
      }
      this.render(index);
    } catch (error) {
      showToast(userMessageOf(error));
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  private registerVaultEvents(): void {
    const handler = (file: TAbstractFile, oldPath?: string): void => {
      if (!file.path.endsWith(".md")) {
        return;
      }
      if (oldPath) {
        this.indexService.invalidate(oldPath);
      }
      this.indexService.invalidate(file.path);
      if (this.refreshTimer !== null) {
        window.clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        void this.refresh();
      }, 500);
    };

    this.registerEvent(this.app.vault.on("modify", (file) => handler(file)));
    this.registerEvent(this.app.vault.on("create", (file) => handler(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => handler(file)));
    this.registerEvent(
      this.app.vault.on("rename", (file, old) => handler(file, old))
    );
  }

  private openNewClassNote(defaultCourse = ""): void {
    new NewNoteModal(
      this.app,
      this.notes,
      this.indexService,
      "",
      (path) => {
        void this.openFile(path);
      },
      {
        defaultCourse,
        defaultTemplate: "class",
        getSettings: this.getSettings,
      }
    ).open();
  }

  private openCourseManage(courseToEdit?: CourseRegistration): void {
    new CourseManageModal(
      this.app,
      this.notes,
      this.getSettings,
      this.saveSettings,
      () => {
        this.indexService.invalidate();
        void this.refresh();
      },
      courseToEdit
    ).open();
  }

  private openSetCurrentTerm(): void {
    new SetCurrentTermModal(
      this.app,
      this.getSettings,
      this.saveSettings,
      () => void this.refresh()
    ).open();
  }

  private openChangeCourseTerm(
    courseName: string,
    currentGrade: AcademicGrade,
    currentTerm: AcademicTerm
  ): void {
    new ChangeCourseTermModal(
      this.app,
      this.notes,
      courseName,
      currentGrade,
      currentTerm,
      this.getSettings,
      this.saveSettings,
      () => {
        this.indexService.invalidate();
        void this.refresh();
      }
    ).open();
  }

  private render(index: { notes: NoteRecord[] }): void {
    if (!this.bodyEl) {
      return;
    }
    this.bodyEl.empty();

    const settings = this.getSettings();
    const registeredCourses = settings.courses ?? [];
    const registeredCourseMap = new Map<string, CourseRegistration>(
      registeredCourses.map((c) => [c.name.trim(), c])
    );

    // 1. ノートの分類・推定
    const classNotes: EnrichedClassNote[] = [];
    for (const note of index.notes) {
      if (note.archived || note.kind !== "class") {
        continue;
      }
      const course = note.course.trim() || "(科目未設定)";
      const lectureDate =
        typeof note.frontmatter.lecture_date === "string" &&
        note.frontmatter.lecture_date.trim() !== ""
          ? note.frontmatter.lecture_date.trim()
          : (note.created ?? "").slice(0, 10);

      const reg = registeredCourseMap.get(course);

      let grade =
        typeof note.frontmatter.grade === "string" &&
        note.frontmatter.grade.trim() !== ""
          ? (note.frontmatter.grade.trim() as AcademicGrade)
          : reg?.grade;
      let term =
        typeof note.frontmatter.term === "string" &&
        note.frontmatter.term.trim() !== ""
          ? (note.frontmatter.term.trim() as AcademicTerm)
          : reg?.term;

      let isInferred = false;
      if (!grade || !term) {
        isInferred = true;
        grade = grade ?? settings.currentGrade;
        if (!term) {
          const month = Number((lectureDate || note.created).slice(5, 7)) || 10;
          term = month >= 4 && month <= 9 ? "前期" : "後期";
        }
      }

      // 回次（第N回）の抽出
      const roundMatch =
        /第\s*(\d+)\s*回/.exec(note.title) ??
        /第\s*(\d+)\s*回/.exec(note.basename);
      const round = roundMatch ? Number(roundMatch[1]) : 0;

      classNotes.push({
        course,
        excerpt: note.excerpt,
        grade,
        isInferred,
        lectureDate,
        mtime: note.mtime,
        path: note.path,
        record: note,
        round,
        term,
        title: note.title,
      });
    }

    // 2. 科目ごとにグループ化
    const courseGroupsMap = new Map<string, CourseGroup>();

    // まず登録科目を登録
    for (const reg of registeredCourses) {
      courseGroupsMap.set(reg.name.trim(), {
        courseName: reg.name.trim(),
        grade: reg.grade,
        isInferred: false,
        maxRound: 0,
        notes: [],
        registration: reg,
        term: reg.term,
      });
    }

    // ノートを追加
    for (const note of classNotes) {
      let group = courseGroupsMap.get(note.course);
      if (!group) {
        group = {
          courseName: note.course,
          grade: note.grade,
          isInferred: note.isInferred,
          maxRound: 0,
          notes: [],
          term: note.term,
        };
        courseGroupsMap.set(note.course, group);
      }
      group.notes.push(note);
      if (note.round > group.maxRound) {
        group.maxRound = note.round;
      }
    }

    // 各グループのノートを回次昇順（回次がなければ日付昇順）で並べる
    for (const group of courseGroupsMap.values()) {
      group.notes.sort((a, b) => {
        if (a.round && b.round) {
          return a.round - b.round;
        }
        return a.lectureDate.localeCompare(b.lectureDate);
      });
      if (group.maxRound === 0 && group.notes.length > 0) {
        group.maxRound = group.notes.length;
      }
    }

    // 3. 学期スイッチャー用データの集計
    const currentTermKey = `${settings.currentGrade} ${settings.currentTerm}`;
    const allTerms = new Set<string>();
    allTerms.add(currentTermKey);

    for (const group of courseGroupsMap.values()) {
      allTerms.add(`${group.grade} ${group.term}`);
    }

    // 現在のフィルターで表示するノートと科目
    const filteredGroups = [...courseGroupsMap.values()].filter((group) => {
      if (this.activeFilter === "all") {
        return true;
      }
      const groupTermKey = `${group.grade} ${group.term}`;
      if (this.activeFilter === "current") {
        return groupTermKey === currentTermKey;
      }
      return groupTermKey === this.activeFilter;
    });

    // 4. 最上段：授業インデックス＆学期スイッチャー
    this.renderIndex(
      this.bodyEl,
      classNotes,
      allTerms,
      currentTermKey,
      settings
    );

    // 5. 当学期の履修科目（1タップで今日の講義ノート作成）セクション
    const currentTermGroups = [...courseGroupsMap.values()].filter(
      (group) => `${group.grade} ${group.term}` === currentTermKey
    );
    this.renderTodayActionSection(this.bodyEl, currentTermGroups, settings);

    // 6. 科目別の講義ノート台帳セクション
    this.renderCourseLedgers(this.bodyEl, filteredGroups);
  }

  /** 最上段：インデックスと学期フィルターバー */
  private renderIndex(
    container: HTMLElement,
    allNotes: EnrichedClassNote[],
    allTerms: Set<string>,
    currentTermKey: string,
    settings: SeitonSettings
  ): void {
    const indexTop = container.createDiv({ cls: "seiton-index-top" });

    // 表示中の対象スコープでのノート数を集計
    let activeNotesCount = 0;
    let activeScopeLabel = "";
    if (this.activeFilter === "current") {
      activeNotesCount = allNotes.filter(
        (n) => `${n.grade} ${n.term}` === currentTermKey
      ).length;
      activeScopeLabel = `${settings.currentGrade} ${settings.currentTerm}`;
    } else if (this.activeFilter === "all") {
      activeNotesCount = allNotes.length;
      activeScopeLabel = "全学期";
    } else {
      activeNotesCount = allNotes.filter(
        (n) => `${n.grade} ${n.term}` === this.activeFilter
      ).length;
      activeScopeLabel = this.activeFilter;
    }

    const totalEl = indexTop.createDiv({ cls: "seiton-index-total" });
    totalEl.createSpan({
      cls: "seiton-index-total-number",
      text: String(activeNotesCount),
    });
    totalEl.createSpan({
      cls: "seiton-index-total-label",
      text: `回の記録（${activeScopeLabel}）`,
    });

    const labelsBar = container.createDiv({ cls: "seiton-index-labels" });

    // 当学期ボタン
    const currentCount = allNotes.filter(
      (n) => `${n.grade} ${n.term}` === currentTermKey
    ).length;
    const currentBtn = labelsBar.createEl("button", {
      cls: `seiton-index-label${this.activeFilter === "current" ? " is-active" : ""}`,
      type: "button",
    });
    currentBtn.createSpan({
      text: `当学期 (${settings.currentGrade}${settings.currentTerm})`,
    });
    currentBtn.createSpan({
      cls: "seiton-index-count",
      text: String(currentCount),
    });
    currentBtn.addEventListener("click", () => {
      this.activeFilter = "current";
      void this.refresh();
    });

    // 他学期ボタン
    const sortedOtherTerms = [...allTerms]
      .filter((termKey) => termKey !== currentTermKey)
      .sort((a, b) => b.localeCompare(a, "ja"));

    for (const termKey of sortedOtherTerms) {
      const termCount = allNotes.filter(
        (n) => `${n.grade} ${n.term}` === termKey
      ).length;
      const termBtn = labelsBar.createEl("button", {
        cls: `seiton-index-label${this.activeFilter === termKey ? " is-active" : ""}`,
        type: "button",
      });
      termBtn.createSpan({ text: termKey });
      termBtn.createSpan({
        cls: "seiton-index-count",
        text: String(termCount),
      });
      termBtn.addEventListener("click", () => {
        this.activeFilter = termKey;
        void this.refresh();
      });
    }

    // すべての学期ボタン
    const allBtn = labelsBar.createEl("button", {
      cls: `seiton-index-label${this.activeFilter === "all" ? " is-active" : ""}`,
      type: "button",
    });
    allBtn.createSpan({ text: "すべての学期" });
    allBtn.createSpan({
      cls: "seiton-index-count",
      text: String(allNotes.length),
    });
    allBtn.addEventListener("click", () => {
      this.activeFilter = "all";
      void this.refresh();
    });
  }

  /** 当学期の履修科目（1タップで今日の講義ノート作成）セクション */
  private renderTodayActionSection(
    container: HTMLElement,
    currentTermGroups: CourseGroup[],
    settings: SeitonSettings
  ): void {
    const section = container.createDiv({
      cls: "seiton-zone seiton-classes-today-section",
    });
    const head = section.createDiv({ cls: "seiton-zone-head" });
    head.createEl("h2", {
      text: `当学期（${settings.currentGrade} ${settings.currentTerm}）の履修科目`,
    });

    if (currentTermGroups.length === 0) {
      const empty = section.createDiv({ cls: "st-empty" });
      empty.createSpan({
        text: "当学期に登録されている科目はありません。右上の「＋ 科目を登録」から科目を登録できます。",
      });
      return;
    }

    const pills = section.createDiv({ cls: "seiton-quick-class-pills" });
    for (const group of currentTermGroups) {
      const nextRound = group.maxRound + 1;
      const scheduleParts: string[] = [];
      if (group.registration?.dayOfWeek) {
        scheduleParts.push(group.registration.dayOfWeek);
      }
      if (group.registration?.period) {
        scheduleParts.push(group.registration.period);
      }
      const scheduleText =
        scheduleParts.length > 0 ? ` (${scheduleParts.join(" ")})` : "";

      const pill = pills.createEl("button", {
        attr: {
          title: `「${todayKey()} ${group.courseName}（第${nextRound}回）」を作成`,
          type: "button",
        },
        cls: "seiton-quick-class-pill st-pill",
      });
      pill.createSpan({
        text: `${group.courseName}${scheduleText} · 次は第${nextRound}回`,
      });
      pill.createSpan({
        cls: "seiton-quick-class-add",
        text: " ＋ 今日の講義ノート",
      });
      pill.addEventListener("click", () => {
        void this.createClassNote(group.courseName, nextRound);
      });
    }
  }

  /** 科目別の講義ノート台帳セクション */
  private renderCourseLedgers(
    container: HTMLElement,
    courseGroups: CourseGroup[]
  ): void {
    const section = container.createDiv({
      cls: "seiton-zone seiton-classes-ledger-section",
    });
    const head = section.createDiv({ cls: "seiton-zone-head" });
    head.createEl("h2", { text: "科目別 講義ノート台帳" });

    if (courseGroups.length === 0) {
      const empty = section.createDiv({ cls: "st-empty" });
      empty.createSpan({ text: "表示対象の科目がありません。" });
      return;
    }

    // 科目名順でソート
    const sortedGroups = [...courseGroups].sort((a, b) =>
      a.courseName.localeCompare(b.courseName, "ja")
    );

    for (const group of sortedGroups) {
      const courseBox = section.createDiv({ cls: "seiton-class-course-box" });

      // 科目ヘッダー
      const courseHead = courseBox.createDiv({
        cls: "seiton-class-course-head",
      });

      const titleWrap = courseHead.createDiv({
        cls: "seiton-class-course-title-wrap",
      });
      titleWrap.createEl("h3", {
        cls: "seiton-class-course-name",
        text: group.courseName,
      });

      const metaWrap = titleWrap.createDiv({
        cls: "seiton-class-course-meta",
      });
      const badgeText = `${group.grade} ${group.term}${
        group.registration?.dayOfWeek
          ? ` · ${group.registration.dayOfWeek}`
          : ""
      }${group.registration?.period ? ` ${group.registration.period}` : ""}${
        group.isInferred ? " (推定)" : ""
      }`;
      metaWrap.createSpan({
        cls: "st-pill is-subtle",
        text: badgeText,
      });
      metaWrap.createSpan({
        cls: "seiton-class-course-count",
        text: `全${group.notes.length}回`,
      });

      const actionsWrap = courseHead.createDiv({
        cls: "seiton-class-course-actions",
      });

      // 編集 / 学期変更ボタン
      if (group.registration) {
        const editBtn = actionsWrap.createEl("button", {
          cls: "st-btn is-ghost is-sm",
          text: "設定",
          type: "button",
        });
        editBtn.addEventListener("click", () => {
          this.openCourseManage(group.registration);
        });
      } else {
        const regBtn = actionsWrap.createEl("button", {
          cls: "st-btn is-secondary is-sm",
          text: "当学期に登録",
          type: "button",
        });
        regBtn.addEventListener("click", () => {
          void this.registerToCurrentTerm(group.courseName);
        });

        const termBtn = actionsWrap.createEl("button", {
          cls: "st-btn is-ghost is-sm",
          text: "学期を変更",
          type: "button",
        });
        termBtn.addEventListener("click", () => {
          this.openChangeCourseTerm(group.courseName, group.grade, group.term);
        });
      }

      // ノート追加ボタン
      const nextRound = group.maxRound + 1;
      const addNoteBtn = actionsWrap.createEl("button", {
        cls: "st-btn is-secondary is-sm",
        text: "＋ ノート追加",
        type: "button",
      });
      addNoteBtn.addEventListener("click", () => {
        void this.createClassNote(group.courseName, nextRound);
      });

      // 講義ノート一覧台帳行
      if (group.notes.length === 0) {
        const emptyRow = courseBox.createDiv({
          cls: "seiton-item seiton-class-empty-row",
        });
        const content = emptyRow.createDiv({ cls: "seiton-item-content" });
        content.createSpan({
          cls: "st-muted",
          text: "講義ノートはまだありません。",
        });
      } else {
        const listGrid = courseBox.createDiv({
          cls: "seiton-card-grid is-list",
        });
        for (const note of group.notes) {
          const row = listGrid.createEl("article", {
            cls: "seiton-item",
          });

          const content = row.createDiv({ cls: "seiton-item-content" });
          const titleBtn = content.createEl("button", {
            cls: "seiton-item-title",
            text: note.title,
            type: "button",
          });
          titleBtn.addEventListener("click", () => {
            void this.openFile(note.path);
          });

          if (note.excerpt) {
            content.createDiv({
              cls: "seiton-item-excerpt",
              text: note.excerpt,
            });
          }

          const side = row.createDiv({ cls: "seiton-item-side" });
          side.createSpan({
            cls: "seiton-item-updated",
            text: note.lectureDate,
          });
        }
      }
    }
  }

  /** 1タップで今日の講義ノートを作成して開く */
  private async createClassNote(
    courseName: string,
    round: number
  ): Promise<void> {
    const today = todayKey();
    const title = `${today} ${courseName}（第${round}回）`;
    const settings = this.getSettings();
    const reg = (settings.courses ?? []).find(
      (c) => c.name.trim() === courseName.trim()
    );
    const grade = reg?.grade ?? settings.currentGrade;
    const term = reg?.term ?? settings.currentTerm;

    try {
      showToast(`「${title}」を作成中…`);
      const path = await this.notes.createNote({
        course: courseName,
        grade,
        lectureDate: today,
        project: null,
        template: "class",
        term,
        title,
      });

      await this.openFile(path);
      this.indexService.invalidate();
      void this.refresh();
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  /** 未登録科目を当学期に登録する */
  private async registerToCurrentTerm(courseName: string): Promise<void> {
    const settings = this.getSettings();
    const newCourse: CourseRegistration = {
      grade: settings.currentGrade,
      id: `c_${Date.now().toString(36)}`,
      name: courseName,
      term: settings.currentTerm,
    };
    const nextCourses = [...settings.courses, newCourse];
    try {
      await this.saveSettings({
        courses: nextCourses,
      });
      await saveCoursesLedgerMarkdown(this.app, {
        ...settings,
        courses: nextCourses,
      });
      const updatedCount = await this.notes.updateCourseNotesMetadata(
        courseName,
        {
          grade: settings.currentGrade,
          term: settings.currentTerm,
        }
      );
      showToast(
        updatedCount > 0
          ? `「${courseName}」を当学期の科目に登録し、${updatedCount}件のノートを更新しました。`
          : `「${courseName}」を当学期の科目に登録しました。`
      );
      this.indexService.invalidate();
      void this.refresh();
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }
}
