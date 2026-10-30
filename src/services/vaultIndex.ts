/**
 * Vault全体の読み取り専用索引。正本ではなく、VaultのMarkdownから毎回作り直せる。
 * Library・検索・プロジェクト・本棚・Webクリップが同じ索引を共有する。
 */

import type { App, TFile } from "obsidian";
import {
  ARCHIVE_FOLDER,
  LINKS_FILE,
  MIGRATION_FOLDER,
  TEMPLATES_FOLDER,
} from "../config";
import {
  bodyAfterFrontmatter,
  frontmatterList,
  scanFrontmatter,
} from "../domain/frontmatter";
import { displayLink, normalizeLink } from "../domain/links";
import type { MemoState } from "../domain/memoLog";
import { parseMemoLog } from "../domain/memoLog";
import { normalizeSourceUrl } from "../domain/network";
import { parsePromptLog } from "../domain/promptLog";
import { decodeHtmlEntities, normalizeNewlines } from "../domain/text";
import { dateKeyOf } from "../domain/time";

export type IndexKind = "note" | "memo" | "prompt";

export interface NoteRecord {
  archived: boolean;
  basename: string;
  book: Record<string, string>;
  course: string;
  cover: string;
  created: string;
  excerpt: string;
  frontmatter: Record<string, unknown>;
  kind: string;
  lists: string[];
  mtime: number;
  path: string;
  pinned: boolean;
  projects: string[];
  review: boolean;
  searchText: string;
  source: string;
  tags: string[];
  title: string;
  type: "note";
}

export interface MemoIndexItem {
  at: string;
  body: string;
  entryId: string;
  line: number;
  path: string;
  promotedTo: string | null;
  state: MemoState;
  title: string;
  type: "memo";
  week: string;
}

export interface PromptIndexItem {
  at: string;
  body: string;
  entryId: string;
  line: number;
  path: string;
  project: string;
  projectKey: string;
  projectKeys: string[];
  sessionState: string;
  title: string;
  type: "prompt";
}

export type IndexItem = NoteRecord | MemoIndexItem | PromptIndexItem;

export interface IndexProblem {
  message: string;
  path: string;
}

export interface VaultIndex {
  builtAt: number;
  memos: MemoIndexItem[];
  notes: NoteRecord[];
  problems: IndexProblem[];
  prompts: PromptIndexItem[];
}

export interface SearchFilters {
  course?: string;
  includeArchived?: boolean;
  includeDeleted?: boolean;
  kinds?: string[];
  limit?: number;
  list?: string;
  project?: string;
  status?: "review" | "archived" | "pinned";
  tags?: string[];
}

export interface SearchHit {
  item: IndexItem;
  score: number;
}

const SEARCH_TEXT_LIMIT = 20_000;

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      if (item && typeof item === "object" && "path" in item) {
        return [String((item as { path?: unknown }).path ?? "")];
      }
      return [];
    });
  }
  if (typeof value === "string") {
    return value
      .replace(/^\[|\]$/gu, "")
      .split(/[,、]/u)
      .map((item) => item.trim().replace(/^["']|["']$/gu, ""))
      .filter((item) => item !== "");
  }
  return [];
}

function normalizeProjects(value: unknown): string[] {
  return stringList(value).map((item) => displayLink(item));
}

function normalizeTags(value: unknown): string[] {
  return stringList(value).map((item) => item.replace(/^#/u, "").trim());
}

function excerptOf(body: string): string {
  return normalizeNewlines(body)
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^#{1,6}[ \t]+.*$/gmu, "")
    .replace(/[*_~`>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

function titleOfBody(body: string): string {
  const line = normalizeNewlines(body)
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value !== "" && !value.startsWith("<!--"));
  if (!line) {
    return "無題";
  }
  return line
    .replace(/^#{1,6}[ \t]+/u, "")
    .replace(/[*_~`>]/gu, "")
    .slice(0, 60);
}

function noteFromFile(
  app: App,
  file: TFile,
  content: string,
  frontmatterOverride?: Record<string, unknown>
): NoteRecord {
  const cached =
    frontmatterOverride ??
    (app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined) ??
    {};
  const scan = scanFrontmatter(content);
  const frontmatter: Record<string, unknown> = { ...cached, ...scan.fields };
  const body = bodyAfterFrontmatter(content);
  const headingTitle = /^#[ \t]+(.+)$/mu.exec(body)?.[1]?.trim() ?? "";
  const bodyWithoutTitle = body.replace(/^#[ \t]+[^\n]*(?:\n|$)/u, "");
  const rawProjects = frontmatterList(content, "projects");
  const rawTags = frontmatterList(content, "tags");
  const rawLists = frontmatterList(content, "lists");
  const rawKind = stringValue(frontmatter.kind);
  const legacyType = stringValue(frontmatter.type);
  const kind = rawKind || (legacyType === "webclip" ? "webclip" : "note");
  const book: Record<string, string> = {};
  for (const key of [
    "book_isbn",
    "book_author",
    "book_category",
    "book_series",
    "book_cover",
    "reading_status",
    "book_ownership",
    "book_finished",
    "book_rating",
  ]) {
    const value = stringValue(frontmatter[key]);
    if (value !== "") {
      book[key] = value;
    }
  }

  return {
    archived: booleanValue(frontmatter.archived),
    basename: file.basename,
    book,
    course: stringValue(frontmatter.course),
    cover:
      stringValue(frontmatter.book_cover) ||
      stringValue(frontmatter.cover) ||
      stringValue(frontmatter.image),
    created: stringValue(frontmatter.created),
    excerpt: decodeHtmlEntities(excerptOf(bodyWithoutTitle)),
    frontmatter,
    kind,
    lists: rawLists.length > 0 ? rawLists : stringList(frontmatter.lists),
    mtime: file.stat.mtime,
    path: file.path,
    pinned: booleanValue(frontmatter.pinned),
    projects:
      rawProjects.length > 0
        ? normalizeProjects(rawProjects)
        : normalizeProjects(frontmatter.projects),
    review: booleanValue(frontmatter.review),
    searchText: normalizeNewlines(body).slice(0, SEARCH_TEXT_LIMIT),
    source: stringValue(frontmatter.source),
    tags:
      rawTags.length > 0
        ? normalizeTags(rawTags)
        : normalizeTags(frontmatter.tags),
    title: decodeHtmlEntities(
      stringValue(frontmatter.title) || headingTitle || file.basename
    ),
    type: "note",
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      const item = items[current];
      if (item !== undefined) {
        results[current] = await worker(item);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );
  return results;
}

/** 検索条件と索引から結果を作る。UIから独立した純関数。 */
export function searchIndex(
  index: VaultIndex,
  query: string,
  filters: SearchFilters = {}
): SearchHit[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token !== "");
  const limit = filters.limit ?? 200;
  const hits: SearchHit[] = [];

  const matchesFilters = (item: IndexItem): boolean => {
    if (item.type === "note") {
      if (
        filters.kinds &&
        filters.kinds.length > 0 &&
        !filters.kinds.includes(item.kind)
      ) {
        return false;
      }
      if (filters.course && item.course !== filters.course) {
        return false;
      }
      if (
        filters.tags &&
        filters.tags.length > 0 &&
        !filters.tags.every((tag) => item.tags.includes(tag))
      ) {
        return false;
      }
      if (
        filters.project &&
        !item.projects.some(
          (project) => normalizeLink(project) === filters.project
        )
      ) {
        return false;
      }
      if (filters.list && !item.lists.some((list) => list === filters.list)) {
        return false;
      }
      if (
        !(filters.includeArchived ?? false) &&
        filters.status !== "archived" &&
        item.archived
      ) {
        return false;
      }
      if (filters.status === "review" && !item.review) {
        return false;
      }
      if (filters.status === "archived" && !item.archived) {
        return false;
      }
      if (filters.status === "pinned" && !item.pinned) {
        return false;
      }
      return true;
    }

    if (item.type === "memo") {
      if (filters.course) {
        return false;
      }
      if (
        filters.kinds &&
        filters.kinds.length > 0 &&
        !filters.kinds.includes("memo")
      ) {
        return false;
      }
      if (filters.status) {
        return false;
      }
      if (filters.tags && filters.tags.length > 0) {
        return false;
      }
      if (filters.project || filters.list) {
        return false;
      }
      if (!(filters.includeDeleted ?? false) && item.state === "deleted") {
        return false;
      }
      return true;
    }

    if (
      filters.course ||
      (filters.kinds &&
        filters.kinds.length > 0 &&
        !filters.kinds.includes("prompt"))
    ) {
      return false;
    }
    if (filters.status || filters.list) {
      return false;
    }
    if (filters.tags && filters.tags.length > 0) {
      return false;
    }
    if (filters.project && !item.projectKeys.includes(filters.project)) {
      return false;
    }
    return true;
  };

  for (const item of [
    ...index.notes,
    ...index.memos,
    ...index.prompts,
  ] as IndexItem[]) {
    if (!matchesFilters(item)) {
      continue;
    }
    if (tokens.length === 0) {
      hits.push({ item, score: 0 });
      continue;
    }

    const title = item.title;
    const titleLower = title.toLowerCase();
    const body = item.type === "note" ? item.searchText : item.body;
    const bodyLower = body.toLowerCase();
    const extra =
      item.type === "note"
        ? [
            item.kind,
            item.basename,
            item.path,
            item.tags.join(" "),
            item.projects.join(" "),
            item.lists.join(" "),
            item.course,
          ]
            .join(" ")
            .toLowerCase()
        : `${item.at} ${item.path}`.toLowerCase();

    let score = 0;
    let matchedAll = true;
    const titleQuery = tokens.join(" ");
    if (titleLower === titleQuery) {
      score += 30;
    } else if (titleLower.startsWith(titleQuery)) {
      score += 15;
    }
    for (const token of tokens) {
      const inTitle = titleLower.includes(token);
      const inBody = bodyLower.includes(token);
      const inExtra = extra.includes(token);
      if (!(inTitle || inBody || inExtra)) {
        matchedAll = false;
        break;
      }
      score += inTitle ? 10 : 0;
      score += inBody ? 2 : 0;
      score += inExtra ? 3 : 0;
    }
    if (matchedAll) {
      hits.push({ item, score });
    }
  }

  hits.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return updatedAt(right.item) - updatedAt(left.item);
  });

  return hits.slice(0, limit);
}

export function updatedAt(item: IndexItem): number {
  if (item.type === "note") {
    return item.mtime;
  }
  const parsed = Date.parse(item.at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 索引を構築・キャッシュする。Vault変更時はinvalidate()で捨てる。 */
export class VaultIndexService {
  private readonly app: App;
  private cache: VaultIndex | null = null;
  private building: Promise<VaultIndex> | null = null;
  private buildingGeneration = -1;
  private generation = 0;

  constructor(app: App) {
    this.app = app;
  }

  getCached(): VaultIndex | null {
    return this.cache;
  }

  invalidate(): void {
    this.generation += 1;
    this.cache = null;
  }

  async get(): Promise<VaultIndex> {
    if (this.cache) {
      return this.cache;
    }
    if (this.building && this.buildingGeneration === this.generation) {
      return this.building;
    }
    const generation = this.generation;
    const build = this.build().then((index) => {
      if (generation === this.generation) {
        this.cache = index;
      }
      return index;
    });
    const tracked = build.finally(() => {
      if (this.building === tracked) {
        this.building = null;
      }
    });
    this.building = tracked;
    this.buildingGeneration = generation;
    return tracked;
  }

  async build(): Promise<VaultIndex> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter(
        (file) =>
          file.path !== LINKS_FILE &&
          !file.path.startsWith(`${TEMPLATES_FOLDER}/`) &&
          !file.path.startsWith(`${ARCHIVE_FOLDER}/`) &&
          !file.path.startsWith(`${MIGRATION_FOLDER}/`)
      );
    const notes: NoteRecord[] = [];
    const memos: MemoIndexItem[] = [];
    const prompts: PromptIndexItem[] = [];
    const problems: IndexProblem[] = [];

    await mapLimit(files, 24, async (file) => {
      try {
        const content = await this.app.vault.cachedRead(file);
        const cachedFrontmatter =
          (this.app.metadataCache.getFileCache(file)?.frontmatter as
            | Record<string, unknown>
            | undefined) ?? {};
        const frontmatter: Record<string, unknown> =
          Object.keys(cachedFrontmatter).length > 0
            ? cachedFrontmatter
            : scanFrontmatter(content).fields;
        const kind = stringValue(frontmatter.kind);

        if (kind === "memo-log") {
          const parsed = parseMemoLog(content);
          const week = stringValue(frontmatter.week);
          for (const entry of parsed.entries) {
            memos.push({
              at: entry.at,
              body: entry.body,
              entryId: entry.id,
              line: entry.startLine,
              path: file.path,
              promotedTo: entry.promotedTo,
              state: entry.state,
              title: titleOfBody(entry.body),
              type: "memo",
              week,
            });
          }
          const firstError = parsed.diagnostics.find(
            (item) => item.severity === "error"
          );
          if (firstError) {
            problems.push({
              message: `${firstError.line}行目: ${firstError.message}`,
              path: file.path,
            });
          }
          return;
        }

        if (kind === "prompt-session") {
          const parsed = parsePromptLog(content);
          const rawProjects = frontmatterList(content, "projects");
          const rawProject = rawProjects[0] ?? "";
          const project = displayLink(rawProject);
          const projectKey = normalizeLink(rawProject);
          const projectKeys = rawProjects
            .map((value) => normalizeLink(value))
            .filter((value) => value !== "");
          for (const prompt of parsed.prompts) {
            prompts.push({
              at: prompt.at,
              body: prompt.body,
              entryId: prompt.id,
              line: prompt.startLine,
              path: file.path,
              project,
              projectKey,
              projectKeys,
              sessionState: stringValue(frontmatter.session_state),
              title: parsed.title || file.basename,
              type: "prompt",
            });
          }
          const firstError = parsed.diagnostics.find(
            (item) => item.severity === "error"
          );
          if (firstError) {
            problems.push({
              message: `${firstError.line}行目: ${firstError.message}`,
              path: file.path,
            });
          }
          return;
        }

        const note = noteFromFile(this.app, file, content, frontmatter);
        if (note.source !== "") {
          note.source = normalizeSourceUrl(note.source) ?? note.source;
        }
        notes.push(note);
      } catch (error) {
        problems.push({
          message: error instanceof Error ? error.message : String(error),
          path: file.path,
        });
      }
    });

    notes.sort((left, right) => right.mtime - left.mtime);
    memos.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
    prompts.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

    return {
      builtAt: Date.now(),
      memos,
      notes,
      problems,
      prompts,
    };
  }
}

export function allTags(index: VaultIndex): string[] {
  return [...new Set(index.notes.flatMap((note) => note.tags))].sort();
}

export function allLists(index: VaultIndex): string[] {
  return [...new Set(index.notes.flatMap((note) => note.lists))].sort();
}

export function allCourses(index: VaultIndex): string[] {
  return [
    ...new Set(
      index.notes.map((note) => note.course).filter((course) => course !== "")
    ),
  ].sort((left, right) => left.localeCompare(right, "ja"));
}

export function allProjects(index: VaultIndex): NoteRecord[] {
  return index.notes
    .filter((note) => note.kind === "project")
    .sort((left, right) => left.title.localeCompare(right.title, "ja"));
}

export function allBooks(index: VaultIndex): NoteRecord[] {
  return index.notes.filter((note) => note.kind === "book");
}

export function allWebClips(index: VaultIndex): NoteRecord[] {
  return index.notes.filter((note) => note.kind === "webclip");
}

export function dateKeyOfAt(at: string): string {
  return dateKeyOf(at) || "";
}
