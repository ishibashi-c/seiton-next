import type { PromptSessionSummary } from "../services/promptService";
import type { MemoIndexItem } from "../services/vaultIndex";
import { normalizeLink } from "./links";
import { extractTags } from "./memoTags";
import { domainOf } from "./network";
import { normalizeNewlines } from "./text";

export type ProjectStatus = "active" | "paused" | "done";

export interface ProjectTask {
  checked: boolean;
  line: string;
  lineIndex: number;
  sourcePath: string;
  sourceTitle: string;
  text: string;
}

export interface ProjectLink {
  label: string;
  lineIndex: number;
  url: string;
}

export interface ResolvedNextAction {
  isPinned: boolean;
  task?: ProjectTask;
  text: string;
}

/** 一覧と詳細で同じセッション数を出すための集計。 */
export function countSessionsByProject(
  sessions: PromptSessionSummary[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.project === null || session.project.trim() === "") {
      continue;
    }
    const key = normalizeLink(session.project);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function normalizeProjectStatus(
  frontmatter: Record<string, unknown>,
  archived: boolean
): ProjectStatus {
  if (archived) {
    return "done";
  }
  const raw =
    typeof frontmatter.project_status === "string"
      ? frontmatter.project_status.trim().toLowerCase()
      : "";
  if (raw === "done" || raw === "archived" || raw === "completed") {
    return "done";
  }
  if (raw === "paused" || raw === "hold" || raw === "on-hold") {
    return "paused";
  }
  return "active";
}

function updateFenceState(
  line: string,
  state: { char: string | null; len: number }
): boolean {
  const trimmed = line.trimStart();
  const match = /^(`{3,}|~{3,})/u.exec(trimmed);
  if (match?.[1]) {
    const ch = match[1][0] ?? "`";
    const len = match[1].length;
    if (state.char === null) {
      state.char = ch;
      state.len = len;
      return true;
    }
    if (ch === state.char && len >= state.len) {
      state.char = null;
      state.len = 0;
      return true;
    }
  }
  return state.char !== null;
}

export function extractMarkdownTasks(
  content: string,
  sourcePath: string,
  sourceTitle: string
): ProjectTask[] {
  const lines = normalizeNewlines(content).split("\n");
  const fence = { char: null as string | null, len: 0 };
  const tasks: ProjectTask[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    if (updateFenceState(line, fence)) {
      continue;
    }
    const match = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }
    tasks.push({
      checked: match[1]?.toLowerCase() === "x",
      line,
      lineIndex,
      sourcePath,
      sourceTitle,
      text: (match[2] ?? "").trim(),
    });
  }

  return tasks;
}

function findSectionRange(
  lines: string[],
  headings: readonly string[]
): { end: number; start: number } | null {
  const fence = { char: null as string | null, len: 0 };
  let start = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (updateFenceState(line, fence)) {
      continue;
    }
    const h2 = /^##[ \t]+(.+?)[ \t]*$/u.exec(line);
    if (h2?.[1] && headings.includes(h2[1].trim())) {
      start = i;
      break;
    }
  }

  if (start < 0) {
    return null;
  }

  const fenceAfter = { char: null as string | null, len: 0 };
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (updateFenceState(line, fenceAfter)) {
      continue;
    }
    if (/^#{1,2}[ \t]+/u.test(line)) {
      return { end: i, start };
    }
  }

  return { end: lines.length, start };
}

function appendBulletToSection(
  content: string,
  headings: readonly string[],
  defaultHeading: string,
  bulletLine: string
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = normalizeNewlines(content).split("\n");
  const range = findSectionRange(lines, headings);

  if (range) {
    let lastContentIndex = range.start;
    for (let i = range.end - 1; i > range.start; i -= 1) {
      if ((lines[i] ?? "").trim() !== "") {
        lastContentIndex = i;
        break;
      }
    }

    if (lastContentIndex === range.start) {
      const hasBlankAfterHeading =
        range.start + 1 < range.end &&
        (lines[range.start + 1] ?? "").trim() === "";
      const insertAt = hasBlankAfterHeading ? range.start + 2 : range.start + 1;
      const toInsert = hasBlankAfterHeading ? [bulletLine] : ["", bulletLine];
      if (
        range.end < lines.length &&
        (lines[range.end - 1] ?? "").trim() !== ""
      ) {
        toInsert.push("");
      } else if (
        range.end < lines.length &&
        hasBlankAfterHeading &&
        insertAt === range.end
      ) {
        toInsert.push("");
      }
      lines.splice(insertAt, 0, ...toInsert);
    } else {
      lines.splice(lastContentIndex + 1, 0, bulletLine);
    }

    return lines.join(eol);
  }

  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") {
    lines.pop();
  }
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(defaultHeading, "", bulletLine, "");
  return lines.join(eol);
}

export function appendTaskToMarkdown(
  content: string,
  taskText: string
): string {
  const trimmed = taskText.trim();
  if (!trimmed) {
    return content;
  }
  return appendBulletToSection(
    content,
    ["タスク"],
    "## タスク",
    `- [ ] ${trimmed}`
  );
}

export function toggleTaskLineInMarkdown(
  content: string,
  lineIndex: number,
  expectedLine: string
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = normalizeNewlines(content).split("\n");
  let targetIndex = -1;
  if (
    lineIndex >= 0 &&
    lineIndex < lines.length &&
    lines[lineIndex] === expectedLine
  ) {
    targetIndex = lineIndex;
  } else {
    targetIndex = lines.indexOf(expectedLine);
  }
  if (targetIndex < 0) {
    return content;
  }
  const line = lines[targetIndex] ?? "";
  if (/^\s*[-*]\s*\[[xX]\]/u.test(line)) {
    lines[targetIndex] = line.replace(/\[[xX]\]/u, "[ ]");
  } else if (/^\s*[-*]\s*\[ \]/u.test(line)) {
    lines[targetIndex] = line.replace(/\[ \]/u, "[x]");
  } else {
    return content;
  }
  return lines.join(eol);
}

const LINK_HEADINGS = ["リンク", "関連リンク"] as const;

export function extractProjectLinks(content: string): ProjectLink[] {
  const lines = normalizeNewlines(content).split("\n");
  const range = findSectionRange(lines, LINK_HEADINGS);
  if (!range) {
    return [];
  }

  const fence = { char: null as string | null, len: 0 };
  const links: ProjectLink[] = [];

  for (let i = range.start + 1; i < range.end; i += 1) {
    const line = lines[i] ?? "";
    if (updateFenceState(line, fence)) {
      continue;
    }
    const mdMatch = /^\s*[-*]\s*\[([^\]]*)\]\(([^)\s]+)\)/u.exec(line);
    if (mdMatch?.[2]) {
      const url = mdMatch[2].trim();
      const label = mdMatch[1]?.trim() || domainOf(url) || url;
      links.push({ label, lineIndex: i, url });
      continue;
    }
    const bareMatch = /^\s*[-*]\s*((?:https?|obsidian):\/\/\S+)/u.exec(line);
    if (bareMatch?.[1]) {
      const url = bareMatch[1].trim();
      links.push({ label: domainOf(url) || url, lineIndex: i, url });
    }
  }

  return links;
}

export function appendProjectLinkToMarkdown(
  content: string,
  label: string,
  url: string
): string {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return content;
  }
  const existing = extractProjectLinks(content);
  if (existing.some((item) => item.url === trimmedUrl)) {
    return content;
  }
  const rawLabel = label.trim() || domainOf(trimmedUrl) || trimmedUrl;
  const safeLabel = rawLabel.replace(/[[\]]/gu, "");
  return appendBulletToSection(
    content,
    LINK_HEADINGS,
    "## リンク",
    `- [${safeLabel}](${trimmedUrl})`
  );
}

export function removeProjectLinkFromMarkdown(
  content: string,
  url: string
): string {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return content;
  }
  const links = extractProjectLinks(content).filter(
    (link) => link.url === trimmedUrl
  );
  if (links.length === 0) {
    return content;
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = normalizeNewlines(content).split("\n");
  const removeIndices = new Set(links.map((link) => link.lineIndex));
  const nextLines = lines.filter((_, idx) => !removeIndices.has(idx));
  return nextLines.join(eol);
}

export function projectTagName(projectTitle: string): string {
  return projectTitle.trim().replace(/\s+/gu, "_");
}

export function relatedMemosForProject(
  memos: readonly MemoIndexItem[],
  projectTitle: string
): MemoIndexItem[] {
  const rawKey = projectTitle.trim().toLowerCase();
  const tagKey = projectTagName(projectTitle).toLowerCase();
  if (!tagKey) {
    return [];
  }

  return memos
    .filter((memo) => {
      if (memo.state === "deleted") {
        return false;
      }
      const tags = extractTags(memo.body);
      return tags.some((tag) => {
        const lower = tag.toLowerCase();
        return lower === tagKey || lower === rawKey;
      });
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function resolveNextAction(
  frontmatterNextAction: unknown,
  tasks: readonly ProjectTask[]
): ResolvedNextAction | null {
  if (
    typeof frontmatterNextAction === "string" &&
    frontmatterNextAction.trim() !== ""
  ) {
    return {
      isPinned: true,
      text: frontmatterNextAction.trim(),
    };
  }
  const firstUnchecked = tasks.find((task) => !task.checked);
  if (firstUnchecked) {
    return {
      isPinned: false,
      task: firstUnchecked,
      text: firstUnchecked.text,
    };
  }
  return null;
}
