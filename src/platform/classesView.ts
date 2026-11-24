import type { App, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { ItemView, Modal, normalizePath, setIcon, TFile } from "obsidian";
import { COURSES_FILE, SYSTEM_FOLDER, VIEW_TYPE_CLASSES } from "../config";
import {
  classNotePreview,
  countUncheckedTasks,
  currentPeriodOf,
  partitionCoursesForTimetable,
  timetableCellKey,
  weekdayLabelOf,
} from "../domain/classes";
import {
  type ClassSessionEntry,
  findSessionForDate,
} from "../domain/classSchedule";
import { userMessageOf } from "../domain/errors";
import {
  buildFrontmatter,
  scanFrontmatter,
  yamlQuoted,
} from "../domain/frontmatter";
import { normalizeLectureDate } from "../domain/lectureDate";
import type { ClassNoteType } from "../domain/noteTemplates";
import { loadClassSchedule } from "../services/classSchedule";
import type { NoteService } from "../services/noteService";
import type { PropertyService } from "../services/propertyService";
import type {
  AcademicGrade,
  AcademicTerm,
  CourseRegistration,
  SeitonSettings,
} from "../services/settings";
import type {
  NoteRecord,
  VaultIndex,
  VaultIndexService,
} from "../services/vaultIndex";
import { makeCardClickable } from "./cardClick";
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
  isExtra: boolean;
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
    courseToEdit?: CourseRegistration,
    initialSlot?: { dayOfWeek?: string; period?: string }
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
    this.dayOfWeek = courseToEdit?.dayOfWeek ?? initialSlot?.dayOfWeek ?? "";
    this.period = courseToEdit?.period ?? initialSlot?.period ?? "";
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

/** 授業専用ビュー（Keep理念：執筆中を上に固定 ＋ 蓄積カードウォール ＋ 週間時間割） */
export class SeitonClassesView extends ItemView {
  private readonly indexService: VaultIndexService;
  private readonly notes: NoteService;
  private readonly properties: PropertyService;
  private readonly getSettings: () => SeitonSettings;
  private readonly saveSettings: (
    patch: Partial<SeitonSettings>
  ) => Promise<void>;
  private readonly openFile: (path: string) => Promise<void>;
  private activeFilter = "current"; // "current" | "all" | "${grade} ${term}"
  private selectedCourse = "";
  private timetableOpen = false;
  private timetableUserToggled = false;
  private bodyEl: HTMLElement | null = null;
  private sublineEl: HTMLElement | null = null;
  private classSchedule: ClassSessionEntry[] = [];
  private lastIndex: VaultIndex | null = null;
  private refreshTimer: number | null = null;
  private refreshing = false;
  private refreshAgain = false;

  constructor(
    leaf: WorkspaceLeaf,
    indexService: VaultIndexService,
    notes: NoteService,
    properties: PropertyService,
    getSettings: () => SeitonSettings,
    saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>,
    openFile: (path: string) => Promise<void>
  ) {
    super(leaf);
    this.indexService = indexService;
    this.notes = notes;
    this.properties = properties;
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
    const { body, header } = mountTabShell(this, {
      actions: [
        {
          kind: "primary",
          label: "講義ノートを作成",
          onClick: () => this.openNewClassNote(this.selectedCourse),
        },
        {
          kind: "text",
          label: "＋ 授業外ノート",
          onClick: () => this.openNewClassNote(this.selectedCourse, "extra"),
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
      subline: `${settings.currentGrade} ${settings.currentTerm} · 執筆中を上に固定・講義メモの蓄積`,
      tab: "classes",
      title: "授業",
    });
    body.addClass("seiton-classes-body");
    this.bodyEl = body;
    this.sublineEl = header.sublineEl;
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
    this.sublineEl = null;
    this.lastIndex = null;
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
      this.classSchedule = await loadClassSchedule(this.app);
      const index = await this.indexService.get();
      if (!this.bodyEl) {
        return;
      }
      this.lastIndex = index;
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
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => handler(file))
    );
  }

  private openNewClassNote(
    defaultCourse = "",
    defaultClassNoteType: ClassNoteType = "lecture"
  ): void {
    new NewNoteModal(
      this.app,
      this.notes,
      this.indexService,
      "",
      (path) => {
        void this.openFile(path);
      },
      {
        defaultClassNoteType,
        defaultCourse,
        defaultTemplate: "class",
        getSettings: this.getSettings,
      }
    ).open();
  }

  private openCourseManage(
    courseToEdit?: CourseRegistration,
    initialSlot?: { dayOfWeek?: string; period?: string }
  ): void {
    new CourseManageModal(
      this.app,
      this.notes,
      this.getSettings,
      this.saveSettings,
      () => {
        this.indexService.invalidate();
        void this.refresh();
      },
      courseToEdit,
      initialSlot
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

  private render(index: VaultIndex): void {
    if (!this.bodyEl) {
      return;
    }
    this.bodyEl.empty();

    const settings = this.getSettings();
    if (this.sublineEl) {
      this.sublineEl.setText(
        `${settings.currentGrade} ${settings.currentTerm} · 執筆中を上に固定・講義メモの蓄積`
      );
    }

    const registeredCourses = settings.courses ?? [];
    const registeredCourseMap = new Map<string, CourseRegistration>();
    for (const c of registeredCourses) {
      const key = c.name.trim();
      const existing = registeredCourseMap.get(key);
      if (
        !existing ||
        (c.grade === settings.currentGrade && c.term === settings.currentTerm)
      ) {
        registeredCourseMap.set(key, c);
      }
    }

    // 1. ノートの分類・推定
    const classNotes: EnrichedClassNote[] = [];
    for (const note of index.notes) {
      if (note.archived || note.kind !== "class") {
        continue;
      }
      const course = note.course.trim() || "(科目未設定)";
      const lectureDate =
        normalizeLectureDate(note.frontmatter.lecture_date) ||
        (note.created ?? "").slice(0, 10);

      const noteGradeRaw =
        typeof note.frontmatter.grade === "string"
          ? note.frontmatter.grade.trim()
          : "";
      const noteTermRaw =
        typeof note.frontmatter.term === "string"
          ? note.frontmatter.term.trim()
          : "";
      const reg =
        registeredCourses.find(
          (c) =>
            c.name.trim() === course &&
            (!noteGradeRaw || c.grade === noteGradeRaw) &&
            (!noteTermRaw || c.term === noteTermRaw)
        ) ?? registeredCourseMap.get(course);

      let grade = noteGradeRaw ? (noteGradeRaw as AcademicGrade) : reg?.grade;
      let term = noteTermRaw ? (noteTermRaw as AcademicTerm) : reg?.term;

      let isInferred = false;
      if (!grade || !term) {
        isInferred = true;
        grade = grade ?? settings.currentGrade;
        if (!term) {
          const month = Number((lectureDate || note.created).slice(5, 7)) || 10;
          term = month >= 4 && month <= 9 ? "前期" : "後期";
        }
      }

      const isExtra = note.frontmatter.class_note_type === "extra";
      const fmSession = Number(note.frontmatter.session);
      const scheduledRound =
        findSessionForDate(this.classSchedule, course, lectureDate, term)
          ?.round ?? 0;
      const roundMatch =
        /第\s*(\d+)\s*回/.exec(note.title) ??
        /第\s*(\d+)\s*回/.exec(note.basename);
      const round = isExtra
        ? 0
        : Number.isInteger(fmSession) && fmSession > 0
          ? fmSession
          : scheduledRound > 0
            ? scheduledRound
            : roundMatch
              ? Number(roundMatch[1])
              : 0;

      classNotes.push({
        course,
        excerpt: note.excerpt,
        grade,
        isExtra,
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
    for (const reg of registeredCourses) {
      const key = reg.name.trim();
      const existing = courseGroupsMap.get(key);
      if (
        !existing ||
        (reg.grade === settings.currentGrade &&
          reg.term === settings.currentTerm)
      ) {
        courseGroupsMap.set(key, {
          courseName: key,
          grade: reg.grade,
          isInferred: false,
          maxRound: 0,
          notes: [],
          registration: reg,
          term: reg.term,
        });
      }
    }

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
    const allTerms = new Set<string>([currentTermKey]);
    for (const group of courseGroupsMap.values()) {
      allTerms.add(`${group.grade} ${group.term}`);
    }

    const matchesScope = (
      grade: AcademicGrade,
      term: AcademicTerm
    ): boolean => {
      if (this.activeFilter === "all") {
        return true;
      }
      const key = `${grade} ${term}`;
      return this.activeFilter === "current"
        ? key === currentTermKey
        : key === this.activeFilter;
    };

    const scopeNotes = classNotes.filter((note) =>
      matchesScope(note.grade, note.term)
    );

    const scopeCourseCounts = new Map<string, number>();
    for (const note of scopeNotes) {
      scopeCourseCounts.set(
        note.course,
        (scopeCourseCounts.get(note.course) ?? 0) + 1
      );
    }

    const courseBarNames = new Set<string>(scopeCourseCounts.keys());
    for (const reg of registeredCourses) {
      if (matchesScope(reg.grade, reg.term)) {
        courseBarNames.add(reg.name.trim());
      }
    }

    const courseBarItems = [...courseBarNames]
      .sort((a, b) => a.localeCompare(b, "ja"))
      .map((name) => {
        const reg =
          registeredCourses.find(
            (c) => c.name.trim() === name && matchesScope(c.grade, c.term)
          ) ?? registeredCourseMap.get(name);
        const group = courseGroupsMap.get(name);
        return {
          count: scopeCourseCounts.get(name) ?? 0,
          courseName: name,
          grade: reg?.grade ?? group?.grade ?? settings.currentGrade,
          registration: reg,
          term: reg?.term ?? group?.term ?? settings.currentTerm,
        };
      });

    if (
      this.selectedCourse !== "" &&
      !courseBarItems.some((item) => item.courseName === this.selectedCourse)
    ) {
      this.selectedCourse = "";
    }

    const visibleNotes = this.selectedCourse
      ? scopeNotes.filter((note) => note.course === this.selectedCourse)
      : scopeNotes;

    const pinnedNotes = visibleNotes
      .filter((note) => note.record.pinned)
      .sort((a, b) => b.mtime - a.mtime);
    const archivedNotes = visibleNotes
      .filter((note) => !note.record.pinned)
      .sort(
        (a, b) =>
          b.lectureDate.localeCompare(a.lectureDate) || b.mtime - a.mtime
      );

    // 4. 最上段：学期スイッチャー＆科目フィルタバー
    this.renderIndexAndFilters(
      this.bodyEl,
      classNotes,
      scopeNotes.length,
      pinnedNotes.length,
      courseBarItems,
      allTerms,
      currentTermKey,
      settings
    );

    // 5. 時間割 / クイック起動ストリップ（全学期以外の特定学期表示時）
    if (this.activeFilter !== "all") {
      const isCurrentTerm =
        this.activeFilter === "current" || this.activeFilter === currentTermKey;
      const [parsedGrade, parsedTerm] = isCurrentTerm
        ? [settings.currentGrade, settings.currentTerm]
        : (this.activeFilter.split(" ") as [AcademicGrade, AcademicTerm]);
      const targetGrade = parsedGrade || settings.currentGrade;
      const targetTerm = parsedTerm || settings.currentTerm;
      const targetKey = `${targetGrade} ${targetTerm}`;

      const termGroupsMap = new Map<string, CourseGroup>();
      for (const reg of registeredCourses) {
        if (`${reg.grade} ${reg.term}` !== targetKey) {
          continue;
        }
        const key = reg.name.trim();
        termGroupsMap.set(key, {
          courseName: key,
          grade: reg.grade,
          isInferred: false,
          maxRound: 0,
          notes: [],
          registration: reg,
          term: reg.term,
        });
      }
      for (const note of scopeNotes) {
        if (`${note.grade} ${note.term}` !== targetKey) {
          continue;
        }
        let group = termGroupsMap.get(note.course);
        if (!group) {
          group = {
            courseName: note.course,
            grade: note.grade,
            isInferred: note.isInferred,
            maxRound: 0,
            notes: [],
            term: note.term,
          };
          termGroupsMap.set(note.course, group);
        }
        group.notes.push(note);
        if (note.round > group.maxRound) {
          group.maxRound = note.round;
        }
      }
      this.renderTimetableStrip(
        this.bodyEl,
        [...termGroupsMap.values()],
        settings,
        {
          grade: targetGrade,
          isCurrentTerm,
          term: targetTerm,
        }
      );
    }

    // 6. 「執筆中（固定済み）」セクション
    this.renderPinnedWall(this.bodyEl, pinnedNotes);

    // 7. 「これまでの記録（蓄積）」カードウォール
    this.renderArchiveWall(this.bodyEl, archivedNotes, courseBarItems);
  }

  /** 最上段：学期フィルター・サマリー・科目フィルター（すべて左軸揃え） */
  private renderIndexAndFilters(
    container: HTMLElement,
    allNotes: EnrichedClassNote[],
    scopeCount: number,
    pinnedCount: number,
    courseBarItems: Array<{
      count: number;
      courseName: string;
      grade: AcademicGrade;
      registration?: CourseRegistration;
      term: AcademicTerm;
    }>,
    allTerms: Set<string>,
    currentTermKey: string,
    settings: SeitonSettings
  ): void {
    const toolbar = container.createDiv({ cls: "seiton-classes-toolbar" });
    const termRow = toolbar.createDiv({ cls: "seiton-classes-term-row" });
    const termTabs = termRow.createDiv({ cls: "seiton-classes-term-tabs" });

    const currentCount = allNotes.filter(
      (n) => `${n.grade} ${n.term}` === currentTermKey
    ).length;
    const currentBtn = termTabs.createEl("button", {
      cls: `seiton-classes-term-tab${this.activeFilter === "current" ? " is-active" : ""}`,
      type: "button",
    });
    currentBtn.createSpan({
      text: `当学期 (${settings.currentGrade} ${settings.currentTerm})`,
    });
    currentBtn.createSpan({
      cls: "seiton-classes-term-count",
      text: String(currentCount),
    });
    currentBtn.addEventListener("click", () => {
      this.activeFilter = "current";
      this.selectedCourse = "";
      this.timetableUserToggled = false;
      this.rerenderCached();
    });

    const sortedOtherTerms = [...allTerms]
      .filter((termKey) => termKey !== currentTermKey)
      .sort((a, b) => b.localeCompare(a, "ja"));

    for (const termKey of sortedOtherTerms) {
      const termCount = allNotes.filter(
        (n) => `${n.grade} ${n.term}` === termKey
      ).length;
      const termBtn = termTabs.createEl("button", {
        cls: `seiton-classes-term-tab${this.activeFilter === termKey ? " is-active" : ""}`,
        type: "button",
      });
      termBtn.createSpan({ text: termKey });
      termBtn.createSpan({
        cls: "seiton-classes-term-count",
        text: String(termCount),
      });
      termBtn.addEventListener("click", () => {
        this.activeFilter = termKey;
        this.selectedCourse = "";
        this.timetableUserToggled = false;
        this.rerenderCached();
      });
    }

    const allBtn = termTabs.createEl("button", {
      cls: `seiton-classes-term-tab${this.activeFilter === "all" ? " is-active" : ""}`,
      type: "button",
    });
    allBtn.createSpan({ text: "すべて" });
    allBtn.createSpan({
      cls: "seiton-classes-term-count",
      text: String(allNotes.length),
    });
    allBtn.addEventListener("click", () => {
      this.activeFilter = "all";
      this.selectedCourse = "";
      this.timetableUserToggled = false;
      this.rerenderCached();
    });

    const summaryEl = termRow.createDiv({ cls: "seiton-classes-summary" });
    summaryEl.createSpan({
      cls: "seiton-classes-summary-num",
      text: String(scopeCount),
    });
    const scopeLabel =
      this.activeFilter === "current"
        ? `${settings.currentGrade} ${settings.currentTerm}`
        : this.activeFilter === "all"
          ? "全学期"
          : this.activeFilter;
    summaryEl.createSpan({
      cls: "seiton-classes-summary-label",
      text: `回の記録（${scopeLabel}）`,
    });
    if (pinnedCount > 0) {
      summaryEl.createSpan({
        cls: "seiton-classes-pinned-badge",
        text: `執筆中 ${pinnedCount}`,
      });
    }

    if (courseBarItems.length > 0) {
      const courseBar = toolbar.createDiv({
        cls: "seiton-classes-course-bar",
      });
      const allCoursesBtn = courseBar.createEl("button", {
        cls: `seiton-course-filter-chip${this.selectedCourse === "" ? " is-active" : ""}`,
        type: "button",
      });
      allCoursesBtn.createSpan({ text: "すべて" });
      allCoursesBtn.addEventListener("click", () => {
        this.selectedCourse = "";
        this.rerenderCached();
      });

      for (const item of courseBarItems) {
        const active = this.selectedCourse === item.courseName;
        const chip = courseBar.createEl("button", {
          cls: `seiton-course-filter-chip${active ? " is-active" : ""}`,
          type: "button",
        });
        chip.createSpan({ text: item.courseName });
        chip.createSpan({
          cls: "seiton-course-filter-count",
          text: String(item.count),
        });
        chip.addEventListener("click", () => {
          this.selectedCourse = active ? "" : item.courseName;
          this.rerenderCached();
        });
      }

      if (this.selectedCourse) {
        const selectedItem = courseBarItems.find(
          (item) => item.courseName === this.selectedCourse
        );
        if (selectedItem) {
          const actions = courseBar.createDiv({
            cls: "seiton-course-bar-actions",
          });
          const writeBtn = actions.createEl("button", {
            cls: "st-btn is-secondary is-sm",
            text: "＋ 今日のノート",
            type: "button",
          });
          writeBtn.addEventListener("click", () => {
            void this.createClassNote(selectedItem.courseName);
          });
          const extraBtn = actions.createEl("button", {
            cls: "st-btn is-ghost is-sm",
            text: "＋ 授業外ノート",
            type: "button",
          });
          extraBtn.addEventListener("click", () => {
            this.openNewClassNote(selectedItem.courseName, "extra");
          });
          if (selectedItem.registration) {
            const editBtn = actions.createEl("button", {
              cls: "st-btn is-ghost is-sm",
              text: "科目設定",
              type: "button",
            });
            editBtn.addEventListener("click", () => {
              this.openCourseManage(selectedItem.registration);
            });
          } else {
            const regBtn = actions.createEl("button", {
              cls: "st-btn is-ghost is-sm",
              text: "当学期に登録",
              type: "button",
            });
            regBtn.addEventListener("click", () => {
              void this.registerToCurrentTerm(selectedItem.courseName);
            });
            const termBtn = actions.createEl("button", {
              cls: "st-btn is-ghost is-sm",
              text: "学期変更",
              type: "button",
            });
            termBtn.addEventListener("click", () => {
              this.openChangeCourseTerm(
                selectedItem.courseName,
                selectedItem.grade,
                selectedItem.term
              );
            });
          }
        }
      }
    }
  }

  /** 時間割ストリップ（配置済み科目がなければコンパクトバー、配置済みまたは展開時は週間時間割を表示） */
  private renderTimetableStrip(
    container: HTMLElement,
    termGroups: CourseGroup[],
    settings: SeitonSettings,
    scope: {
      grade: AcademicGrade;
      isCurrentTerm: boolean;
      term: AcademicTerm;
    }
  ): void {
    const termRegistrations = (settings.courses ?? []).filter(
      (c) => c.grade === scope.grade && c.term === scope.term
    );
    const groupByName = new Map(
      termGroups.map((group) => [group.courseName, group])
    );
    const unregisteredGroups = termGroups.filter(
      (group) => !group.registration
    );

    const today = todayKey();
    const hasTodayNote = (courseName: string): boolean => {
      if (!scope.isCurrentTerm) {
        return false;
      }
      const group = groupByName.get(courseName);
      return Boolean(
        group?.notes.some((note) => !note.isExtra && note.lectureDate === today)
      );
    };

    const { scheduled, unscheduled, visibleDays, visiblePeriods } =
      partitionCoursesForTimetable(termRegistrations);

    const isOpen = this.timetableUserToggled
      ? this.timetableOpen
      : scope.isCurrentTerm && scheduled.size > 0;

    if (!isOpen) {
      const strip = container.createDiv({
        cls: "seiton-classes-quick-strip",
      });
      const left = strip.createDiv({ cls: "seiton-classes-quick-left" });
      if (scope.isCurrentTerm) {
        left.createSpan({
          cls: "seiton-timetable-ondemand-label",
          text: "今日のノート",
        });
        const chips = left.createDiv({
          cls: "seiton-timetable-ondemand-list",
        });
        this.renderOndemandChips(
          chips,
          unscheduled,
          unregisteredGroups,
          groupByName,
          hasTodayNote,
          true
        );

        if (unscheduled.length === 0 && unregisteredGroups.length === 0) {
          chips.createSpan({
            cls: "seiton-classes-quick-empty",
            text: "科目を登録すると1クリックで今日のノートを開けます",
          });
        }
      } else {
        left.createSpan({
          cls: "seiton-timetable-ondemand-label",
          text: `週間時間割（${scope.grade} ${scope.term}）`,
        });
        const chips = left.createDiv({
          cls: "seiton-timetable-ondemand-list",
        });
        chips.createSpan({
          cls: "seiton-classes-quick-empty",
          text: `${termRegistrations.length}科目登録済み（開いて時間割・オンデマンドを確認）`,
        });
      }

      const openBtn = strip.createEl("button", {
        cls: "st-btn is-ghost is-sm seiton-classes-timetable-toggle",
        text: "時間割を開く",
        type: "button",
      });
      openBtn.addEventListener("click", () => {
        this.timetableUserToggled = true;
        this.timetableOpen = true;
        this.rerenderCached();
      });
      return;
    }

    const box = container.createDiv({
      cls: "seiton-zone seiton-classes-timetable-box",
    });
    const head = box.createDiv({ cls: "seiton-classes-timetable-head" });
    const headLeft = head.createDiv({
      cls: "seiton-classes-timetable-head-left",
    });
    headLeft.createEl("h2", {
      cls: "seiton-classes-timetable-title",
      text: `週間時間割（${scope.grade} ${scope.term}）`,
    });
    headLeft.createSpan({
      cls: "seiton-classes-timetable-hint",
      text: scope.isCurrentTerm
        ? "クリックで今日のノートを書く · 空きコマで科目登録"
        : "クリックで科目を絞り込み · 歯車で科目設定",
    });
    const closeBtn = head.createEl("button", {
      cls: "st-btn is-ghost is-sm seiton-classes-timetable-toggle",
      text: "折りたたむ",
      type: "button",
    });
    closeBtn.addEventListener("click", () => {
      this.timetableUserToggled = true;
      this.timetableOpen = false;
      this.rerenderCached();
    });

    const now = new Date();
    const todayWeekday = scope.isCurrentTerm ? weekdayLabelOf(now) : "";
    const activePeriod = scope.isCurrentTerm ? currentPeriodOf(now) : null;

    const tableWrap = box.createDiv({ cls: "seiton-timetable-wrap" });
    const grid = tableWrap.createDiv({ cls: "seiton-timetable-grid" });
    grid.style.gridTemplateColumns = `44px repeat(${visibleDays.length}, minmax(0, 1fr))`;

    // ヘッダー行
    grid.createDiv({ cls: "seiton-timetable-corner" });
    for (const day of visibleDays) {
      grid.createDiv({
        cls: `seiton-timetable-day-head${day === todayWeekday ? " is-today" : ""}`,
        text: day,
      });
    }

    // 時限行
    for (const period of visiblePeriods) {
      grid.createDiv({
        cls: `seiton-timetable-period-head${period === activePeriod ? " is-now" : ""}`,
        text: period,
      });

      for (const day of visibleDays) {
        const isTodayCol = day === todayWeekday;
        const isNowCell = isTodayCol && period === activePeriod;
        const cell = grid.createDiv({
          cls: `seiton-timetable-cell${isTodayCol ? " is-today" : ""}${isNowCell ? " is-now" : ""}`,
        });
        const slotCourses = scheduled.get(timetableCellKey(day, period)) ?? [];

        if (slotCourses.length === 0) {
          const emptyBtn = cell.createEl("button", {
            attr: {
              "aria-label": `${day}曜 ${period} に科目を登録`,
              title: `${day}曜 ${period} に科目を登録`,
              type: "button",
            },
            cls: "seiton-timetable-empty-slot",
          });
          emptyBtn.createSpan({
            cls: "seiton-timetable-empty-plus",
            text: "＋",
          });
          emptyBtn.addEventListener("click", () => {
            this.openCourseManage(undefined, { dayOfWeek: day, period });
          });
          continue;
        }

        for (const reg of slotCourses) {
          const count =
            groupByName
              .get(reg.name.trim())
              ?.notes.filter((note) => !note.isExtra).length ?? 0;
          const todayExists = hasTodayNote(reg.name.trim());
          const slotBtn = cell.createDiv({
            attr: {
              role: "button",
              tabindex: "0",
              title: scope.isCurrentTerm
                ? todayExists
                  ? `${reg.name} の今日のノートを開く`
                  : `${reg.name} の今日のノートを作成`
                : `${reg.name} で絞り込む`,
            },
            cls: `seiton-timetable-slot${todayExists ? " has-today" : ""}`,
          });

          const top = slotBtn.createDiv({ cls: "seiton-timetable-slot-top" });
          top.createSpan({
            cls: "seiton-timetable-slot-name",
            text: reg.name,
          });

          const gearBtn = top.createEl("button", {
            attr: {
              "aria-label": `${reg.name} を編集`,
              title: "科目を編集",
              type: "button",
            },
            cls: "seiton-timetable-slot-edit",
          });
          setIcon(gearBtn, "settings");
          gearBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            this.openCourseManage(reg);
          });

          const meta = slotBtn.createDiv({
            cls: "seiton-timetable-slot-meta",
          });
          if (todayExists) {
            meta.createSpan({ cls: "seiton-timetable-today-dot" });
          }
          meta.createSpan({
            text: todayExists ? `今日あり · ${count}回` : `${count}回`,
          });

          const activate = () => {
            if (scope.isCurrentTerm) {
              void this.createClassNote(reg.name);
              return;
            }
            this.selectedCourse =
              this.selectedCourse === reg.name ? "" : reg.name;
            this.rerenderCached();
          };
          slotBtn.addEventListener("click", (event) => {
            if ((event.target as Element).closest("button")) {
              return;
            }
            activate();
          });
          slotBtn.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activate();
            }
          });
        }
      }
    }

    // オンデマンド / 時間割外・未登録科目帯
    if (unscheduled.length > 0 || unregisteredGroups.length > 0) {
      const band = box.createDiv({ cls: "seiton-timetable-ondemand" });
      band.createSpan({
        cls: "seiton-timetable-ondemand-label",
        text: "オンデマンド・時間割外",
      });
      const chips = band.createDiv({ cls: "seiton-timetable-ondemand-list" });
      this.renderOndemandChips(
        chips,
        unscheduled,
        unregisteredGroups,
        groupByName,
        hasTodayNote,
        scope.isCurrentTerm
      );
    }
  }

  private renderOndemandChips(
    chips: HTMLElement,
    unscheduled: CourseRegistration[],
    unregisteredGroups: CourseGroup[],
    groupByName: Map<string, CourseGroup>,
    hasTodayNote: (courseName: string) => boolean,
    isCurrentTerm: boolean
  ): void {
    for (const reg of unscheduled) {
      const count =
        groupByName.get(reg.name.trim())?.notes.filter((note) => !note.isExtra)
          .length ?? 0;
      const todayExists = hasTodayNote(reg.name.trim());
      const chip = chips.createDiv({
        cls: `seiton-ondemand-chip${todayExists ? " has-today" : ""}`,
      });
      const openBtn = chip.createEl("button", {
        attr: {
          title: isCurrentTerm
            ? todayExists
              ? `${reg.name} の今日のノートを開く`
              : `${reg.name} の今日のノートを作成`
            : `${reg.name} で絞り込む`,
          type: "button",
        },
        cls: "seiton-ondemand-chip-main",
      });
      if (todayExists) {
        openBtn.createSpan({ cls: "seiton-timetable-today-dot" });
      }
      openBtn.createSpan({ text: reg.name });
      openBtn.createSpan({
        cls: "seiton-ondemand-chip-count",
        text: `${count}回`,
      });
      openBtn.addEventListener("click", () => {
        if (isCurrentTerm) {
          void this.createClassNote(reg.name);
          return;
        }
        this.selectedCourse = this.selectedCourse === reg.name ? "" : reg.name;
        this.rerenderCached();
      });

      const editBtn = chip.createEl("button", {
        attr: {
          "aria-label": `${reg.name} を設定`,
          title: "曜日・時限を設定",
          type: "button",
        },
        cls: "seiton-ondemand-chip-edit",
      });
      setIcon(editBtn, "settings");
      editBtn.addEventListener("click", () => {
        this.openCourseManage(reg);
      });
    }

    for (const group of unregisteredGroups) {
      const todayExists = hasTodayNote(group.courseName);
      const count = group.notes.filter((note) => !note.isExtra).length;
      const chip = chips.createDiv({
        cls: `seiton-ondemand-chip is-inferred${todayExists ? " has-today" : ""}`,
      });
      const openBtn = chip.createEl("button", {
        cls: "seiton-ondemand-chip-main",
        type: "button",
      });
      openBtn.createSpan({ text: group.courseName });
      openBtn.createSpan({
        cls: "seiton-ondemand-chip-count",
        text: `${count}回`,
      });
      openBtn.addEventListener("click", () => {
        if (isCurrentTerm) {
          void this.createClassNote(group.courseName);
          return;
        }
        this.selectedCourse =
          this.selectedCourse === group.courseName ? "" : group.courseName;
        this.rerenderCached();
      });

      const regBtn = chip.createEl("button", {
        attr: {
          title: "当学期に登録",
          type: "button",
        },
        cls: "seiton-ondemand-chip-reg",
        text: "登録",
        type: "button",
      });
      regBtn.addEventListener("click", () => {
        void this.registerToCurrentTerm(group.courseName);
      });
    }
  }

  /** Keep理念: 執筆中（固定済み）エリア */
  private renderPinnedWall(
    container: HTMLElement,
    pinnedNotes: EnrichedClassNote[]
  ): void {
    const section = container.createDiv({
      cls: "seiton-zone seiton-keep-section seiton-keep-pinned-section",
    });
    const head = section.createDiv({ cls: "seiton-zone-head" });
    head.createEl("h2", { text: "執筆中（固定済み）" });
    if (pinnedNotes.length > 0) {
      head.createSpan({
        cls: "seiton-zone-count",
        text: `${pinnedNotes.length}件`,
      });
    }

    if (pinnedNotes.length === 0) {
      section.createDiv({
        cls: "seiton-keep-empty-hint",
        text: "時間割や科目から新しいノートを作成すると、執筆中としてここに固定されます。",
      });
      return;
    }

    const wall = section.createDiv({ cls: "seiton-keep-wall is-pinned" });
    for (const note of pinnedNotes) {
      this.renderKeepCard(wall, note, true);
    }
  }

  /** Keep理念: これまでの記録（蓄積）カードウォール */
  private renderArchiveWall(
    container: HTMLElement,
    archivedNotes: EnrichedClassNote[],
    courseBarItems: Array<{ courseName: string }>
  ): void {
    const section = container.createDiv({
      cls: "seiton-zone seiton-keep-section seiton-keep-archive-section",
    });
    const head = section.createDiv({ cls: "seiton-zone-head" });
    head.createEl("h2", {
      text: this.selectedCourse
        ? `${this.selectedCourse} の記録`
        : "これまでの記録",
    });
    head.createSpan({
      cls: "seiton-zone-count",
      text: `${archivedNotes.length}件`,
    });

    if (archivedNotes.length === 0) {
      if (courseBarItems.length === 0) {
        const empty = section.createDiv({ cls: "st-empty" });
        empty.createSpan({
          text: "この条件に一致する授業ノートはありません。",
        });
      } else {
        section.createDiv({
          cls: "seiton-keep-empty-hint",
          text: "書き終えたノートの固定を解除すると、ここに時系列で蓄積していきます。",
        });
      }
      return;
    }

    const wall = section.createDiv({ cls: "seiton-keep-wall" });
    for (const note of archivedNotes) {
      this.renderKeepCard(wall, note, false);
    }
  }

  private renderKeepCard(
    parent: HTMLElement,
    note: EnrichedClassNote,
    isPinned: boolean
  ): void {
    const card = parent.createEl("article", {
      cls: `seiton-keep-card${isPinned ? " is-pinned" : ""}`,
    });

    const top = card.createDiv({ cls: "seiton-keep-card-top" });
    const badges = top.createDiv({ cls: "seiton-keep-card-badges" });
    badges.createSpan({
      cls: "seiton-keep-card-course",
      text: note.course,
    });
    if (note.isExtra) {
      badges.createSpan({
        cls: "seiton-keep-card-badge is-extra",
        text: "授業外",
      });
    } else if (note.round > 0) {
      badges.createSpan({
        cls: "seiton-keep-card-badge",
        text: `第${note.round}回`,
      });
    }
    const pinBtn = top.createEl("button", {
      attr: {
        "aria-label": isPinned
          ? "固定を解除して下の記録へ移す"
          : "執筆中として上に固定する",
        title: isPinned ? "固定を解除（書き終わり）" : "執筆中に固定（上へ）",
        type: "button",
      },
      cls: `seiton-keep-pin-btn${isPinned ? " is-pinned" : ""}`,
    });
    const pinIcon = pinBtn.createSpan({ cls: "seiton-keep-pin-icon" });
    setIcon(pinIcon, isPinned ? "pin-off" : "pin");
    if (isPinned) {
      pinBtn.createSpan({ text: "固定解除" });
    }
    pinBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.toggleNotePinned(note, !isPinned);
    });

    const titleBtn = card.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-keep-card-title",
      text: note.title,
    });
    titleBtn.addEventListener("click", () => {
      void this.openFile(note.path);
    });

    const preview = classNotePreview(note.record.searchText);
    if (preview) {
      card.createDiv({
        cls: "seiton-keep-card-preview",
        text: preview,
      });
    } else {
      card.createDiv({
        cls: "seiton-keep-card-preview is-blank",
        text: "まだ本文はありません（クリックして書く）",
      });
    }

    const unchecked = countUncheckedTasks(note.record.searchText);
    const foot = card.createDiv({ cls: "seiton-keep-card-foot" });
    foot.createSpan({
      cls: "seiton-keep-card-date",
      text: note.lectureDate || "日付なし",
    });
    if (unchecked > 0) {
      foot.createSpan({
        cls: "seiton-keep-card-tasks",
        text: `課題 ${unchecked}件`,
      });
    } else if (isPinned) {
      foot.createSpan({
        cls: "seiton-keep-card-action-hint",
        text: "続きを書く →",
      });
    }

    makeCardClickable(card, () => {
      void this.openFile(note.path);
    });
  }

  private rerenderCached(): void {
    if (this.lastIndex) {
      this.render(this.lastIndex);
      return;
    }
    void this.refresh();
  }

  private async toggleNotePinned(
    note: EnrichedClassNote,
    nextPinned: boolean
  ): Promise<void> {
    try {
      await this.properties.update(note.path, {
        pinned: nextPinned ? true : null,
      });
      note.record.pinned = nextPinned;
      note.record.frontmatter.pinned = nextPinned;
      this.indexService.invalidate(note.path);
      if (this.lastIndex) {
        this.render(this.lastIndex);
      } else {
        void this.refresh();
      }
      showToast(nextPinned ? "執筆中に固定しました。" : "固定を解除しました。");
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  /** 同日・同科目ノートがあれば開き、なければ白紙で作成して即書き始める */
  private async createClassNote(courseName: string): Promise<void> {
    const today = todayKey();
    const settings = this.getSettings();
    const courses = settings.courses ?? [];
    const reg =
      courses.find(
        (c) =>
          c.name.trim() === courseName.trim() &&
          c.grade === settings.currentGrade &&
          c.term === settings.currentTerm
      ) ?? courses.find((c) => c.name.trim() === courseName.trim());
    const grade = reg?.grade ?? settings.currentGrade;
    const term = reg?.term ?? settings.currentTerm;
    const matchedSession = findSessionForDate(
      this.classSchedule,
      courseName,
      today,
      term
    );

    try {
      const result = await this.notes.findOrCreateClassNote({
        course: courseName,
        grade,
        lectureDate: today,
        session: matchedSession?.round ?? null,
        term,
      });
      showToast(
        result.created
          ? `「${today} ${courseName}」を作成しました`
          : `今日の「${courseName}」を開きます`
      );
      await this.openFile(result.path);
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
