/**
 * 一言メモを独立ノートへ昇格するときの、タイトル・ファイル名・本文の純関数。
 * 元の週次メモは消さず、昇格先へのリンクだけを追記する。
 */

import { buildFrontmatter, yamlQuoted } from "./frontmatter";
import { normalizeNewlines } from "./text";

export const PROMOTABLE_KINDS = [
  "idea",
  "note",
  "class",
  "reading",
  "collection",
] as const;

export type PromotableKind = (typeof PROMOTABLE_KINDS)[number];

export function isPromotableKind(value: string): value is PromotableKind {
  return (PROMOTABLE_KINDS as readonly string[]).includes(value);
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function truncateCodePoints(value: string, length: number): string {
  return Array.from(value).slice(0, length).join("");
}

/** メモ本文の先頭から、独立ノートの初期タイトルを作る。 */
export function titleFromMemoBody(body: string): string {
  const lines = normalizeNewlines(body).split("\n");
  let fence: string | null = null;

  for (const line of lines) {
    const text = line.trim();
    const fenceMatch = /^(`{3,}|~{3,})/u.exec(text);
    if (fence) {
      if (
        fenceMatch?.[1]?.startsWith(fence[0] ?? "") &&
        (fenceMatch[1]?.length ?? 0) >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      continue;
    }
    if (
      text === "" ||
      text.startsWith("<!--") ||
      /^(?:-{3,}|\*{3,}|_{3,})$/u.test(text)
    ) {
      continue;
    }

    const display = text
      .replace(/^#{1,6}[ \t]+/u, "")
      .replace(/^>[ \t]?/u, "")
      .replace(/^(?:[-*+]|\d+\.)[ \t]+/u, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu,
        (_match, target: string, label?: string) =>
          label === undefined || label === "" ? target : label
      )
      .replace(/[*_~`]+/gu, "")
      .replace(/\s+/gu, " ")
      .trim();

    if (display !== "") {
      return truncateCodePoints(display, 60);
    }
  }
  return "一言メモ";
}

/** Obsidian のファイル名・内部リンクで問題になる文字を避ける。 */
/**
 * Dropbox は絵文字を含むファイル名を拒否する（"Dropbox does not support emoji
 * in file / folder names"）。同期が止まるため、ファイル名からは取り除く。
 */
const FILENAME_EMOJI =
  /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{20E3}]/gu;

/** 絵文字の連結に使われるゼロ幅接合子。文字クラスには入れられない。 */
const FILENAME_JOINER = /\u200D/gu;

export function sanitizeNoteTitle(value: string): string {
  let title = normalizeNewlines(value)
    .replace(/[\\/:*?"<>|#^[\]]/gu, "-")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(FILENAME_EMOJI, "")
    .replace(FILENAME_JOINER, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, "");

  title = truncateCodePoints(title, 80).trim();

  if (title === "") {
    return "一言メモ";
  }
  if (WINDOWS_RESERVED.test(title)) {
    return `_${title}`;
  }
  return title;
}

/** `Seiton/Notes/2026-10-26-タイトル.md` */
export function promotedNotePath(dateKey: string, title: string): string {
  const safeTitle = sanitizeNoteTitle(title);
  return `Seiton/Notes/${dateKey}-${safeTitle}.md`;
}

/** パス衝突時に `.md` の直前に識別子を足す。 */
export function withPathSuffix(path: string, suffix: string): string {
  return path.endsWith(".md")
    ? `${path.slice(0, -3)}-${suffix}.md`
    : `${path}-${suffix}`;
}

export function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/u, "");
}

export interface PromotedNoteInput {
  body: string;
  created: string;
  eol?: string;
  kind: PromotableKind;
  memoId: string;
}

/** 昇格先の独立ノート。本文は元メモと同一で、リンク行は含めない。 */
export function buildPromotedNoteDocument(input: PromotedNoteInput): string {
  const eol = input.eol ?? "\n";
  const frontmatter = buildFrontmatter(
    {
      created: yamlQuoted(input.created),
      kind: input.kind,
      seiton_memo_id: yamlQuoted(input.memoId),
    },
    eol
  );
  const body = normalizeNewlines(input.body);
  const bodyWithNewline = body.endsWith("\n") ? body : `${body}\n`;
  return `${frontmatter}${eol}${bodyWithNewline}`;
}

/** 週次メモ側に残す、クリック可能な昇格先リンク。 */
export function appendPromotionLink(body: string, link: string): string {
  const normalized = normalizeNewlines(body);
  if (normalized.includes(link)) {
    return normalized;
  }
  const trimmed = normalized.replace(/\s+$/u, "");
  if (trimmed === "") {
    return `> 昇格先: ${link}`;
  }
  return `${trimmed}\n\n> 昇格先: ${link}`;
}
