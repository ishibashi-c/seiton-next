import type { App } from "obsidian";
import { VIEW_TYPE_CLASSES } from "../../config";
import {
  CLASS_WEEKDAYS,
  coursesForWeekday,
  currentPeriodOf,
  weekdayLabelOf,
} from "../../domain/classes";
import { findSessionForDate } from "../../domain/classSchedule";
import { userMessageOf } from "../../domain/errors";
import { normalizeLectureDate } from "../../domain/lectureDate";
import { loadClassSchedule } from "../../services/classSchedule";
import type { NoteService } from "../../services/noteService";
import type {
  CourseRegistration,
  SeitonSettings,
} from "../../services/settings";
import type { VaultIndex, VaultIndexService } from "../../services/vaultIndex";
import { openMarkdownAtEnd } from "../openNote";
import { openSeitonView } from "../seitonNav";
import { showToast } from "../ui/toast";

export interface HomeTimetableOptions {
  app: App;
  getSettings: () => SeitonSettings;
  indexService: VaultIndexService;
  notes: NoteService;
  onChanged: () => void;
}

function todayKey(now = new Date()): string {
  return [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function initialWeekday(now = new Date()): string {
  const today = weekdayLabelOf(now);
  return (CLASS_WEEKDAYS as readonly string[]).includes(today) ? today : "月";
}

export class HomeTimetable {
  private readonly app: App;
  private readonly getSettings: () => SeitonSettings;
  private readonly notes: NoteService;
  private readonly indexService: VaultIndexService;
  private readonly onChanged: () => void;
  private selectedWeekday: string = initialWeekday();
  private sectionEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private dayBarEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private lastIndex: VaultIndex | null = null;
  private busy = false;

  constructor(options: HomeTimetableOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.notes = options.notes;
    this.indexService = options.indexService;
    this.onChanged = options.onChanged;
  }

  renderSection(parent: HTMLElement): HTMLElement {
    const section = parent.createDiv({
      cls: "seiton-zone seiton-home-section seiton-home-timetable",
    });
    section.style.display = "none";

    const head = section.createDiv({
      cls: "seiton-zone-head seiton-home-timetable-head",
    });
    const titleWrap = head.createDiv({
      cls: "seiton-home-timetable-title-wrap",
    });
    this.titleEl = titleWrap.createEl("h2", { text: "今日の授業" });
    this.dayBarEl = titleWrap.createDiv({
      attr: { "aria-label": "曜日を切り替え", role: "group" },
      cls: "seiton-home-timetable-days",
    });

    const actions = head.createDiv({ cls: "seiton-zone-actions" });
    const openClassesBtn = actions.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "授業タブ",
    });
    openClassesBtn.addEventListener("click", () => {
      void openSeitonView(this.app, VIEW_TYPE_CLASSES);
    });

    this.bodyEl = section.createDiv({ cls: "seiton-home-timetable-body" });
    this.sectionEl = section;
    return section;
  }

  render(index: VaultIndex): void {
    this.lastIndex = index;
    const section = this.sectionEl;
    const body = this.bodyEl;
    const dayBar = this.dayBarEl;
    if (!(section && body && dayBar)) {
      return;
    }

    const settings = this.getSettings();
    const currentCourses = (settings.courses ?? []).filter(
      (course) =>
        course.grade === settings.currentGrade &&
        course.term === settings.currentTerm
    );
    if (currentCourses.length === 0) {
      section.style.display = "none";
      return;
    }

    section.style.display = "";
    const now = new Date();
    const todayWeekday = weekdayLabelOf(now);
    const activePeriod =
      this.selectedWeekday === todayWeekday ? currentPeriodOf(now) : null;
    const today = todayKey(now);

    if (this.titleEl) {
      this.titleEl.setText(
        this.selectedWeekday === todayWeekday
          ? "今日の授業"
          : `${this.selectedWeekday}曜の授業`
      );
    }

    dayBar.empty();
    for (const day of CLASS_WEEKDAYS) {
      const btn = dayBar.createEl("button", {
        attr: { type: "button" },
        cls: `seiton-timetable-day-pill${
          this.selectedWeekday === day ? " is-active" : ""
        }${day === todayWeekday ? " is-today" : ""}`,
        text: day,
      });
      btn.addEventListener("click", () => {
        this.selectedWeekday = day;
        if (this.lastIndex) {
          this.render(this.lastIndex);
        }
      });
    }

    body.empty();
    const existingCoursesToday = new Set<string>();
    for (const note of index.notes) {
      if (
        note.archived ||
        note.kind !== "class" ||
        !note.course.trim() ||
        note.frontmatter.class_note_type === "extra"
      ) {
        continue;
      }
      const date =
        normalizeLectureDate(note.frontmatter.lecture_date) ||
        (note.created ?? "").slice(0, 10);
      if (date === today) {
        existingCoursesToday.add(note.course.trim());
      }
    }

    const { dayCourses, ondemandCourses } = coursesForWeekday(
      currentCourses,
      this.selectedWeekday
    );

    if (dayCourses.length === 0 && ondemandCourses.length === 0) {
      body.createDiv({
        cls: "seiton-home-timetable-empty",
        text: `${this.selectedWeekday}曜日の授業はありません。`,
      });
      return;
    }

    const strip = body.createDiv({ cls: "seiton-home-timetable-strip" });
    for (const course of dayCourses) {
      this.renderCourseButton(strip, course, {
        hasTodayNote: existingCoursesToday.has(course.name.trim()),
        isNow: Boolean(activePeriod && course.period === activePeriod),
        slotLabel: course.period || `${course.dayOfWeek ?? ""}曜`,
      });
    }
    for (const course of ondemandCourses) {
      this.renderCourseButton(strip, course, {
        hasTodayNote: existingCoursesToday.has(course.name.trim()),
        isNow: false,
        isOndemand: true,
        slotLabel: course.dayOfWeek === "集中" ? "集中" : "随時",
      });
    }
  }

  reset(): void {
    this.sectionEl = null;
    this.titleEl = null;
    this.dayBarEl = null;
    this.bodyEl = null;
    this.lastIndex = null;
  }

  private renderCourseButton(
    parent: HTMLElement,
    course: CourseRegistration,
    opts: {
      hasTodayNote: boolean;
      isNow: boolean;
      isOndemand?: boolean;
      slotLabel: string;
    }
  ): void {
    const btn = parent.createEl("button", {
      attr: {
        title: opts.hasTodayNote
          ? `${course.name} の今日のノートを開く`
          : `${course.name} の今日のノートを作成して開く`,
        type: "button",
      },
      cls: `seiton-timetable-chip${opts.isNow ? " is-now" : ""}${
        opts.hasTodayNote ? " is-existing" : ""
      }${opts.isOndemand ? " is-ondemand" : ""}`,
    });
    btn.createSpan({
      cls: "seiton-timetable-chip-slot",
      text: opts.slotLabel,
    });
    btn.createSpan({
      cls: "seiton-timetable-chip-name",
      text: course.name,
    });
    btn.createSpan({
      cls: "seiton-timetable-chip-action",
      text: opts.hasTodayNote ? "続き" : "＋ 書く",
    });
    btn.addEventListener("click", () => {
      void this.openCourseNote(course);
    });
  }

  private async openCourseNote(course: CourseRegistration): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const today = todayKey();
      const schedule = await loadClassSchedule(this.app);
      const matchedSession = findSessionForDate(
        schedule,
        course.name,
        today,
        course.term
      );
      const result = await this.notes.findOrCreateClassNote({
        course: course.name,
        grade: course.grade,
        lectureDate: today,
        session: matchedSession?.round ?? null,
        term: course.term,
      });
      this.indexService.invalidate();
      this.onChanged();
      await openMarkdownAtEnd(this.app, result.path);
    } catch (error) {
      showToast(userMessageOf(error));
    } finally {
      this.busy = false;
    }
  }
}
