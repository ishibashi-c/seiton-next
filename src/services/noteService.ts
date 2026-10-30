import type { App, TFile } from "obsidian";
import { normalizePath, TFile as TFileClass } from "obsidian";
import { NOTES_FOLDER } from "../config";
import { toSeitonError } from "../domain/errors";
import {
  lectureDateFromBasename,
  normalizeLectureDate,
} from "../domain/lectureDate";
import type { NoteTemplateId } from "../domain/noteTemplates";
import {
  buildNoteDocument,
  buildTemplateBody,
  classNotePath,
  datedNotePath,
  findTemplate,
  projectNotePath,
} from "../domain/noteTemplates";
import { formatLocalIso } from "../domain/time";
import type { PropertyService } from "./propertyService";

export interface CreateNoteInput {
  course?: string | null;
  lectureDate?: string | null;
  project?: string | null;
  template: NoteTemplateId;
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
    const lectureDate =
      template.id === "class" ? normalizeLectureDate(input.lectureDate) : "";
    if (template.id === "class") {
      if (!course) {
        throw new Error("授業科目を入力してください。");
      }
      if (!lectureDate) {
        throw new Error("講義日を YYYY-MM-DD で入力してください。");
      }
    }
    const title =
      input.title.replace(/\r\n|\r|\n/gu, " ").trim() ||
      (template.id === "class" ? `${lectureDate} ${course}` : "無題");
    const base =
      template.id === "project"
        ? projectNotePath(title)
        : template.id === "class"
          ? classNotePath(lectureDate, course)
          : datedNotePath(dateKey, title);
    const body = buildTemplateBody(template.id);
    const content = buildNoteDocument({
      body,
      course: course || null,
      createdAt,
      kind,
      lectureDate: lectureDate || null,
      project: input.project ?? null,
      title,
    });

    await this.ensureFolder(NOTES_FOLDER);
    const path = await this.createUnique(base, content);
    return path;
  }

  async createProject(title: string): Promise<string> {
    return this.createNote({ template: "project", title });
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
