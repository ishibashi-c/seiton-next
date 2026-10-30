/**
 * ショートカット（リンク集）ノートの解析と、行単位の編集。
 *
 * ノートは手でも編集できる。ここでは「読んで、触った行だけを差し替える」ことに徹し、
 * 解釈できない行はそのまま残す。
 */

import { normalizeLink } from "./links";

export interface LinkEntry {
  label: string;
  line: number;
  target: string;
}

export interface LinkSection {
  items: LinkEntry[];
  /** 見出しの行番号。先頭のグループなしは `null`。 */
  line: number | null;
  name: string | null;
}

export interface LinkList {
  sections: LinkSection[];
}

export type LinkEditStatus =
  | "added"
  | "duplicate"
  | "exists"
  | "missing"
  | "removed"
  | "unchanged"
  | "updated";

export interface LinkEdit {
  content: string;
  status: LinkEditStatus;
}

export interface LinkInput {
  group: string | null;
  label: string;
  target: string;
}

export const LINK_TITLE = "ショートカット";

/** PC用。いま開いているページをショートカットへ送るブックマークレット。 */
export const LINK_BOOKMARKLET =
  'javascript:(()=>{const e=encodeURIComponent;location.href="obsidian://seiton-next?action=link&url="+e(location.href)+"&title="+e(document.title||"");})();';

const ITEM_PATTERN = /^[-*+]\s+\[(.+)\]\(([^()\s]+)\)\s*$/u;
const HEADING_PATTERN = /^##\s+(.+?)\s*$/u;
const TITLE_PATTERN = /^#\s+/u;

/** 空のリンク集。最初の追加でこのファイルを作る。 */
export function emptyLinkDocument(): string {
  return `# ${LINK_TITLE}\n\n`;
}

/** 比較用のキー。URLはクエリ・ハッシュ・末尾スラッシュを落とす。 */
export function linkKey(target: string): string {
  const value = target.trim();
  if (value === "") {
    return "";
  }
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      url.hash = "";
      url.search = "";
      return url.toString().replace(/\/$/u, "").toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  }
  return normalizeLink(value);
}

export function parseLinkList(content: string): LinkList {
  const lines = content.split(/\r?\n/u);
  const sections: LinkSection[] = [{ items: [], line: null, name: null }];
  for (let index = frontmatterEnd(lines); index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = HEADING_PATTERN.exec(line);
    if (heading?.[1]) {
      sections.push({ items: [], line: index, name: heading[1] });
      continue;
    }
    const item = ITEM_PATTERN.exec(line);
    if (!(item?.[1] && item[2])) {
      continue;
    }
    const current = sections.at(-1) ?? sections[0];
    current?.items.push({
      label: item[1].trim(),
      line: index,
      target: item[2],
    });
  }
  return {
    sections: sections.filter(
      (section) => section.name !== null || section.items.length > 0
    ),
  };
}

export function addLink(content: string, input: LinkInput): LinkEdit {
  const label = input.label.trim();
  const target = input.target.trim();
  if (label === "" || target === "") {
    return { content, status: "unchanged" };
  }
  const eol = eolOf(content);
  const lines = content.split(eol);
  if (findLinkLine(lines, target) >= 0) {
    return { content, status: "duplicate" };
  }
  const index =
    input.group === null
      ? rootInsertIndex(lines)
      : groupInsertIndex(lines, input.group);
  if (index === null) {
    return { content, status: "missing" };
  }
  lines.splice(index, 0, `- [${label}](${target})`);
  ensureHeadingGaps(lines);
  return { content: lines.join(eol), status: "added" };
}

/** 1件を別の場所・別の名前に置き換える。実体は削除して追加。 */
export function updateLink(
  content: string,
  fromTarget: string,
  input: LinkInput
): LinkEdit {
  const removed = removeLink(content, fromTarget);
  if (removed.status === "missing") {
    return { content, status: "missing" };
  }
  const added = addLink(removed.content, input);
  if (added.status !== "added") {
    return { content, status: added.status };
  }
  return { content: added.content, status: "updated" };
}

export function removeLink(content: string, target: string): LinkEdit {
  const eol = eolOf(content);
  const lines = content.split(eol);
  const index = findLinkLine(lines, target);
  if (index < 0) {
    return { content, status: "missing" };
  }
  lines.splice(index, 1);
  return { content: lines.join(eol), status: "removed" };
}

/** 同じグループの中で前後に入れ替える。 */
export function moveLink(
  content: string,
  target: string,
  delta: number
): LinkEdit {
  const eol = eolOf(content);
  const lines = content.split(eol);
  const index = findLinkLine(lines, target);
  if (index < 0) {
    return { content, status: "missing" };
  }
  const siblings = siblingItems(lines, index);
  const position = siblings.indexOf(index);
  const next = siblings[position + delta];
  if (position < 0 || next === undefined) {
    return { content, status: "unchanged" };
  }
  const from = lines[index] ?? "";
  lines[index] = lines[next] ?? "";
  lines[next] = from;
  return { content: lines.join(eol), status: "updated" };
}

/** ドラッグで、指定したリンクの直前に移す。 */
export function moveLinkBefore(
  content: string,
  target: string,
  anchor: string
): LinkEdit {
  return relocate(content, target, (lines) => {
    const index = findLinkLine(lines, anchor);
    return index < 0 ? null : index;
  });
}

/** ドラッグで、指定したリンクの直後に移す。 */
export function moveLinkAfter(
  content: string,
  target: string,
  anchor: string
): LinkEdit {
  return relocate(content, target, (lines) => {
    const index = findLinkLine(lines, anchor);
    return index < 0 ? null : index + 1;
  });
}

/** ドラッグで、グループの末尾（グループなしは先頭の並びの末尾）へ移す。 */
export function moveLinkToGroup(
  content: string,
  target: string,
  group: string | null
): LinkEdit {
  return relocate(content, target, (lines) =>
    group === null ? rootInsertIndex(lines) : groupInsertIndex(lines, group)
  );
}

function relocate(
  content: string,
  target: string,
  resolve: (lines: string[]) => number | null
): LinkEdit {
  const eol = eolOf(content);
  const lines = content.split(eol);
  const from = findLinkLine(lines, target);
  if (from < 0) {
    return { content, status: "missing" };
  }
  const line = lines[from] ?? "";
  lines.splice(from, 1);
  const index = resolve(lines);
  if (index === null) {
    return { content, status: "missing" };
  }
  lines.splice(index, 0, line);
  ensureHeadingGaps(lines);
  const next = lines.join(eol);
  return { content: next, status: next === content ? "unchanged" : "updated" };
}

export function addGroup(content: string, name: string): LinkEdit {
  const trimmed = name.trim();
  if (trimmed === "") {
    return { content, status: "unchanged" };
  }
  const eol = eolOf(content);
  const lines = content.split(eol);
  if (findGroupLine(lines, trimmed) >= 0) {
    return { content, status: "exists" };
  }
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    lines.push(`# ${LINK_TITLE}`);
  }
  lines.push("", `## ${trimmed}`, "");
  return { content: lines.join(eol), status: "added" };
}

export function renameGroup(
  content: string,
  from: string,
  to: string
): LinkEdit {
  const trimmed = to.trim();
  if (trimmed === "") {
    return { content, status: "unchanged" };
  }
  const eol = eolOf(content);
  const lines = content.split(eol);
  const index = findGroupLine(lines, from);
  if (index < 0) {
    return { content, status: "missing" };
  }
  if (from !== trimmed && findGroupLine(lines, trimmed) >= 0) {
    return { content, status: "exists" };
  }
  lines[index] = `## ${trimmed}`;
  return { content: lines.join(eol), status: "updated" };
}

/** 見出しを外す。中のリンクはグループなしへ移す（消さない）。 */
export function removeGroup(content: string, name: string): LinkEdit {
  const eol = eolOf(content);
  const lines = content.split(eol);
  const heading = findGroupLine(lines, name);
  if (heading < 0) {
    return { content, status: "missing" };
  }
  const end = blockEnd(lines, heading + 1);
  const block = lines.slice(heading + 1, end);
  const moved = block.filter((line) => ITEM_PATTERN.test(line));
  const prose = block.filter(
    (line) => !(ITEM_PATTERN.test(line) || line.trim() === "")
  );
  const rootIndex = rootInsertIndex(lines);
  const next = [...lines.slice(0, heading), ...prose, ...lines.slice(end)];
  if (moved.length > 0) {
    next.splice(rootIndex, 0, ...moved);
  }
  ensureHeadingGaps(next);
  return { content: next.join(eol), status: "removed" };
}

/** 既存のショートカット設定を取り込む。同じURLは飛ばす。 */
export function importLinks(
  content: string,
  items: Array<{ label: string; target: string }>
): { added: number; content: string } {
  let current = content;
  let added = 0;
  for (const item of items) {
    const edit = addLink(current, {
      group: null,
      label: item.label,
      target: item.target,
    });
    if (edit.status === "added") {
      current = edit.content;
      added += 1;
    }
  }
  return { added, content: current };
}

function eolOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? "").trim() !== "---") {
    return 0;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === "---") {
      return index + 1;
    }
  }
  return 0;
}

function findLinkLine(lines: string[], target: string): number {
  const key = linkKey(target);
  if (key === "") {
    return -1;
  }
  return lines.findIndex((line) => {
    const item = ITEM_PATTERN.exec(line);
    return item?.[2] !== undefined && linkKey(item[2]) === key;
  });
}

function findGroupLine(lines: string[], name: string): number {
  return lines.findIndex(
    (line) => HEADING_PATTERN.exec(line)?.[1] === name.trim()
  );
}

function rootInsertIndex(lines: string[]): number {
  const start = frontmatterEnd(lines);
  const firstHeading = lines.findIndex(
    (line, index) => index >= start && HEADING_PATTERN.test(line)
  );
  const limit = firstHeading === -1 ? lines.length : firstHeading;
  let lastItem = -1;
  for (let index = start; index < limit; index += 1) {
    if (ITEM_PATTERN.test(lines[index] ?? "")) {
      lastItem = index;
    }
  }
  if (lastItem >= 0) {
    return lastItem + 1;
  }
  const title = lines.findIndex(
    (line, index) => index >= start && TITLE_PATTERN.test(line)
  );
  if (title >= 0) {
    const after = title + 1;
    return (lines[after] ?? "").trim() === "" ? after + 1 : after;
  }
  return (lines[start] ?? "").trim() === "" ? start + 1 : start;
}

function groupInsertIndex(lines: string[], name: string): number | null {
  const heading = findGroupLine(lines, name);
  if (heading < 0) {
    return null;
  }
  const end = blockEnd(lines, heading + 1);
  let lastItem = -1;
  for (let index = heading + 1; index < end; index += 1) {
    if (ITEM_PATTERN.test(lines[index] ?? "")) {
      lastItem = index;
    }
  }
  if (lastItem >= 0) {
    return lastItem + 1;
  }
  const after = heading + 1;
  return (lines[after] ?? "").trim() === "" ? after + 1 : after;
}

function blockEnd(lines: string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    if (HEADING_PATTERN.test(lines[index] ?? "")) {
      return index;
    }
  }
  return lines.length;
}

function siblingItems(lines: string[], index: number): number[] {
  const start = frontmatterEnd(lines);
  let from = start;
  for (let cursor = index - 1; cursor >= start; cursor -= 1) {
    if (HEADING_PATTERN.test(lines[cursor] ?? "")) {
      from = cursor + 1;
      break;
    }
  }
  const end = blockEnd(lines, index + 1);
  const result: number[] = [];
  for (let cursor = from; cursor < end; cursor += 1) {
    if (ITEM_PATTERN.test(lines[cursor] ?? "")) {
      result.push(cursor);
    }
  }
  return result;
}

/** 見出しの直前に空行を1つ保つ。見出し以外の行には触らない。 */
function ensureHeadingGaps(lines: string[]): void {
  for (let index = 1; index < lines.length; index += 1) {
    if (!HEADING_PATTERN.test(lines[index] ?? "")) {
      continue;
    }
    if ((lines[index - 1] ?? "").trim() === "") {
      continue;
    }
    lines.splice(index, 0, "");
    index += 1;
  }
}
