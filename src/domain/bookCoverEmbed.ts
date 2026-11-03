/**
 * 書籍ノート本文と表紙埋め込み構文（![[cover.jpg|240]]）の純関数。
 * Obsidian API に依存しない。
 */

import { BookError } from "./book";
import { scanFrontmatter } from "./frontmatter";
import { detectEol } from "./text";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 本文先頭に置く表紙の埋め込み行。 */
export function coverEmbedLine(cover: string): string {
  return `![[${cover}|240]]`;
}

/** 既に表紙が埋め込まれているか。 */
export function hasCoverEmbed(document: string, cover: string): boolean {
  return document.includes(coverEmbedLine(cover));
}

/**
 * 既存の書籍ノートの本文先頭へ表紙を挿し込む。
 * frontmatter が閉じていない場合は破壊を避けて例外にする。
 */
export function embedCoverInDocument(document: string, cover: string): string {
  if (cover.trim() === "" || hasCoverEmbed(document, cover)) {
    return document;
  }
  const scan = scanFrontmatter(document);
  if (!(scan.present && scan.closed)) {
    throw new BookError(
      "BOOK_FORMAT",
      "frontmatterが閉じていないため表紙を挿入できません。"
    );
  }
  const eol = detectEol(document);
  const head = document.slice(0, scan.bodyStartOffset);
  const body = document.slice(scan.bodyStartOffset).replace(/^\n+/u, "");
  const line = coverEmbedLine(cover);
  return body === ""
    ? `${head}${line}${eol}`
    : `${head}${line}${eol}${eol}${body}`;
}

/**
 * メモ欄に表紙の埋め込み行を出さないための除去。
 * 本文の先頭に置いた `![[...]]` 1行と、その直後の空行を取り除く。
 */
export function stripCoverEmbed(text: string, cover: string): string {
  if (cover.trim() === "") {
    return text;
  }
  const pattern = new RegExp(
    `^\\s*!\\[\\[[^\\]]*${escapeRegExp(cover)}[^\\]]*\\]\\]\\s*$`,
    "mu"
  );
  const without = text.replace(pattern, "").replace(/^\n+/u, "");
  return without.trimEnd();
}

/** 保存時に、本文の先頭へ表紙を戻す。 */
export function withCoverEmbed(text: string, cover: string): string {
  const body = text.trimEnd();
  if (cover.trim() === "") {
    return body;
  }
  return body === ""
    ? coverEmbedLine(cover)
    : `${coverEmbedLine(cover)}\n\n${body}`;
}
