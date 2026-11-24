import type { App, TFile } from "obsidian";
import { normalizePath, TFile as TFileClass } from "obsidian";
import { NOTES_FOLDER } from "../config";
import { toSeitonError } from "../domain/errors";
import {
  lectureDateFromBasename,
  normalizeLectureDate,
} from "../domain/lectureDate";
import type { ClassNoteType, NoteTemplateId } from "../domain/noteTemplates";
import {
  buildNoteDocument,
  buildTemplateBody,
  classExtraNotePath,
  classNotePath,
  datedNotePath,
  findTemplate,
  projectNotePath,
} from "../domain/noteTemplates";
import { formatLocalIso } from "../domain/time";
import type { PropertyService } from "./propertyService";

export interface CreateNoteInput {
  classNoteType?: ClassNoteType | null;
  course?: string | null;
  extraLabel?: string | null;
  grade?: string | null;
  lectureDate?: string | null;
  pinned?: boolean;
  project?: string | null;
  session?: number | null;
  template: NoteTemplateId;
  term?: string | null;
  title: string;
}

export interface ClassCandidate {
  lectureDate: string;
  path: string;
  title: string;
}

/** ノート・プロジェクトの作成だけを担う。編集はObsidian標準エディター。 */
export class NoteService {
  private readonly app: App;
  private readonly properties: PropertyService;

  constructor(app: App, properties: PropertyService) {
    this.app = app;
    this.properties = properties;
  }

  async createNote(input: CreateNoteInput): Promise<string> {
    const template = findTemplate(input.template);
    const kind = template.kind;
    const now = new Date();
    const createdAt = formatLocalIso(now);
    const dateKey = createdAt.slice(0, 10);
    const course = input.course?.trim() ?? "";
    const isClass = template.id === "class";
    const isExtraClass = isClass && input.classNoteType === "extra";
    const lectureDate = isClass ? normalizeLectureDate(input.lectureDate) : "";
    if (isClass) {
      if (!course) {
        throw new Error("授業科目を入力してください。");
      }
      if (!lectureDate) {
        throw new Error("講義日を YYYY-MM-DD で入力してください。");
      }
    }
    const extraLabel = isExtraClass
      ? (input.extraLabel || input.title || "").trim() || "授業外"
      : "";
    const title =
      input.title.replace(/\r\n|\r|\n/gu, " ").trim() ||
      (isExtraClass
        ? `${lectureDate} ${course} ${extraLabel}`
        : isClass
          ? `${lectureDate} ${course}`
          : "無題");
    const base =
      template.id === "project"
        ? projectNotePath(title)
        : isExtraClass
          ? classExtraNotePath(lectureDate, course, extraLabel)
          : isClass
            ? classNotePath(lectureDate, course)
            : datedNotePath(dateKey, title);
    const body = buildTemplateBody(template.id);
    const content = buildNoteDocument({
      body,
      classNoteType: isExtraClass ? "extra" : null,
      course: course || null,
      createdAt,
      grade: isClass ? input.grade?.trim() || null : null,
      kind,
      lectureDate: lectureDate || null,
      pinned: input.pinned,
      project: input.project ?? null,
      session: isClass && !isExtraClass ? (input.session ?? null) : null,
      term: isClass ? input.term?.trim() || null : null,
      title,
    });

    await this.ensureFolder(NOTES_FOLDER);
    const path = await this.createUnique(base, content);
    return path;
  }

  async createProject(title: string): Promise<string> {
    return this.createNote({ template: "project", title });
  }

  async findOrCreateClassNote(input: {
    course: string;
    grade?: string | null;
    lectureDate: string;
    session?: number | null;
    term?: string | null;
  }): Promise<{ created: boolean; path: string }> {
    const course = input.course.trim();
    const lectureDate = normalizeLectureDate(input.lectureDate);
    if (!course) {
      throw new Error("授業科目を入力してください。");
    }
    if (!lectureDate) {
      throw new Error("講義日を YYYY-MM-DD で入力してください。");
    }
    const candidates = await this.findClassCandidates(course, lectureDate);
    if (candidates.length > 0 && candidates[0]) {
      return { created: false, path: candidates[0].path };
    }
    const path = await this.createNote({
      course,
      grade: input.grade ?? null,
      lectureDate,
      pinned: true,
      project: null,
      session: input.session ?? null,
      template: "class",
      term: input.term ?? null,
      title: `${lectureDate} ${course}`,
    });
    return { created: true, path };
  }

  async findClassCandidates(
    courseValue: string,
    lectureDateValue: string
  ): Promise<ClassCandidate[]> {
    const course = courseValue.trim();
    const lectureDate = normalizeLectureDate(lectureDateValue);
    if (!(course && lectureDate)) {
      return [];
    }
    const candidates: ClassCandidate[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter =
        this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const kind = typeof frontmatter.kind === "string" ? frontmatter.kind : "";
      if (kind && kind !== "class") {
        continue;
      }
      if (frontmatter.class_note_type === "extra") {
        continue;
      }
      const noteCourse =
        typeof frontmatter.course === "string" ? frontmatter.course.trim() : "";
      if (noteCourse !== course) {
        continue;
      }
      const date =
        normalizeLectureDate(frontmatter.lecture_date) ||
        lectureDateFromBasename(file.basename);
      if (date !== lectureDate) {
        continue;
      }
      candidates.push({
        lectureDate: date,
        path: file.path,
        title:
          typeof frontmatter.title === "string" && frontmatter.title.trim()
            ? frontmatter.title.trim()
            : file.basename,
      });
    }
    return candidates.sort((left, right) =>
      left.path.localeCompare(right.path, "ja")
    );
  }

  async setArchived(path: string, archived: boolean): Promise<void> {
    await this.properties.update(path, { archived });
  }

  /**
   * 指定した科目の全授業ノート（.md）の Frontmatter に grade / term（および科目名変更時は course）を一括保存する。
   */
  async updateCourseNotesMetadata(
    targetCourseName: string,
    patch: { course?: string; grade: string; term: string }
  ): Promise<number> {
    const trimmedTarget = targetCourseName.trim();
    if (!trimmedTarget) {
      return 0;
    }
    let updatedCount = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter =
        this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const kind = typeof frontmatter.kind === "string" ? frontmatter.kind : "";
      if (kind !== "class") {
        continue;
      }
      const noteCourse =
        typeof frontmatter.course === "string" ? frontmatter.course.trim() : "";
      if (noteCourse !== trimmedTarget) {
        continue;
      }
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (patch.course?.trim()) {
          fm.course = patch.course.trim();
        }
        fm.grade = patch.grade;
        fm.term = patch.term;
      });
      updatedCount += 1;
    }
    return updatedCount;
  }

  getFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFileClass ? file : null;
  }

  private async createUnique(base: string, content: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const path =
        attempt === 0 ? base : base.replace(/\.md$/u, `-${attempt + 1}.md`);
      if (this.app.vault.getAbstractFileByPath(path)) {
        continue;
      }
      try {
        const file = await this.app.vault.create(path, content);
        return file.path;
      } catch (error) {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          throw toSeitonError(error, "ノートの作成に失敗しました。");
        }
      }
    }
    throw toSeitonError(
      new Error("path collision"),
      "同名のノートが多く、作成できませんでした。"
    );
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = normalizePath(path)
      .split("/")
      .filter((segment) => segment !== "");
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing) {
        continue;
      }
      await this.app.vault.createFolder(current);
    }
  }
}
