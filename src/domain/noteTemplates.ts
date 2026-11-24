import { buildFrontmatter, yamlQuoted } from "./frontmatter";
import { wikiLink } from "./links";
import { sanitizeNoteTitle } from "./notes";

export type NoteTemplateId =
  | "note"
  | "class"
  | "idea"
  | "article"
  | "task"
  | "collection"
  | "profile"
  | "reading"
  | "project";

export interface NoteTemplate {
  description: string;
  id: NoteTemplateId;
  kind: string;
  label: string;
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    description: "自由な長文ノート",
    id: "note",
    kind: "note",
    label: "ノート",
  },
  {
    description: "授業・講義の記録",
    id: "class",
    kind: "class",
    label: "授業",
  },
  {
    description: "思いつき・企画",
    id: "idea",
    kind: "idea",
    label: "アイデア",
  },
  {
    description: "記事・調査のまとめ",
    id: "article",
    kind: "article",
    label: "記事",
  },
  { description: "やることの記録", id: "task", kind: "task", label: "タスク" },
  {
    description: "任意のコレクション",
    id: "collection",
    kind: "collection",
    label: "コレクション",
  },
  {
    description: "プロフィール・自己紹介",
    id: "profile",
    kind: "profile",
    label: "プロフィール",
  },
  { description: "読書ノート", id: "reading", kind: "reading", label: "読書" },
  {
    description: "プロジェクトの概要",
    id: "project",
    kind: "project",
    label: "プロジェクト",
  },
];

const FALLBACK_TEMPLATE: NoteTemplate = {
  description: "自由な長文ノート",
  id: "note",
  kind: "note",
  label: "ノート",
};

export function findTemplate(id: string): NoteTemplate {
  return (
    NOTE_TEMPLATES.find((template) => template.id === id) ?? FALLBACK_TEMPLATE
  );
}

export function buildTemplateBody(id: NoteTemplateId): string {
  switch (id) {
    case "class":
      return "";
    case "idea":
      return "## アイデア\n\n## 次に試すこと\n";
    case "article":
      return "## 概要\n\n## 要点\n\n## 引用・参考\n";
    case "task":
      return "## やること\n\n- [ ] \n\n## メモ\n";
    case "collection":
      return "## 集めたもの\n\n";
    case "profile":
      return "## プロフィール\n\n## 興味・関心\n";
    case "reading":
      return "## 感想\n\n## 引用\n";
    case "project":
      return "## 目的\n\n## 進め方\n\n## 関連情報\n";
    default:
      return "## メモ\n";
  }
}

export type ClassNoteType = "lecture" | "extra";

export interface NoteDocumentInput {
  body: string;
  classNoteType?: ClassNoteType | null;
  course?: string | null;
  createdAt: string;
  eol?: string;
  grade?: string | null;
  kind: string;
  lectureDate?: string | null;
  pinned?: boolean;
  project?: string | null;
  session?: number | null;
  term?: string | null;
  title: string;
}

export type BuildNoteDocumentInput = NoteDocumentInput;

export function buildNoteDocument(input: NoteDocumentInput): string {
  const eol = input.eol ?? "\n";
  const fields: Record<string, string> = {
    created: yamlQuoted(input.createdAt),
    kind: input.kind,
  };
  if (input.pinned) {
    fields.pinned = "true";
  }
  if (input.course?.trim()) {
    fields.course = yamlQuoted(input.course.trim());
  }
  if (input.lectureDate?.trim()) {
    fields.lecture_date = yamlQuoted(input.lectureDate.trim());
  }
  if (
    input.classNoteType !== "extra" &&
    typeof input.session === "number" &&
    Number.isInteger(input.session) &&
    input.session > 0
  ) {
    fields.session = String(input.session);
  }
  if (input.classNoteType === "extra") {
    fields.class_note_type = yamlQuoted("extra");
  }
  if (input.grade?.trim()) {
    fields.grade = yamlQuoted(input.grade.trim());
  }
  if (input.term?.trim()) {
    fields.term = yamlQuoted(input.term.trim());
  }
  if (input.project?.trim()) {
    fields.projects = `\n  - ${yamlQuoted(wikiLink(input.project.trim()))}`;
  }
  const frontmatter = buildFrontmatter(fields, eol);
  if (input.kind === "class" && input.body === "") {
    return `${frontmatter}${eol}`;
  }
  return `${frontmatter}${eol}# ${input.title}${eol}${eol}${input.body}`;
}

export function datedNotePath(dateKey: string, title: string): string {
  return `Seiton/Notes/${dateKey}-${sanitizeNoteTitle(title)}.md`;
}

export function projectNotePath(title: string): string {
  return `Seiton/Notes/${sanitizeNoteTitle(title)}.md`;
}

export function classNotePath(lectureDate: string, course: string): string {
  return `Seiton/Notes/${sanitizeNoteTitle(lectureDate)} ${sanitizeNoteTitle(course)}.md`;
}

export function classExtraNotePath(
  dateKey: string,
  course: string,
  label: string
): string {
  const cleanDate = sanitizeNoteTitle(dateKey);
  const cleanCourse = sanitizeNoteTitle(course);
  const trimmed = label.trim();
  const suffix =
    trimmed && trimmed !== "無題" ? sanitizeNoteTitle(trimmed) : "授業外";
  return `Seiton/Notes/${cleanDate} ${cleanCourse} ${suffix}.md`;
}
