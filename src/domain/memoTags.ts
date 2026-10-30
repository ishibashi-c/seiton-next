/**
 * 一言メモ本文からObsidianのタグを拾う。
 * コードブロック、インラインコード、URL、エスケープした `#` は対象外。
 */

const FENCED_CODE_PATTERN = /```[\s\S]*?```/gu;
const INLINE_CODE_PATTERN = /`[^`\n]*`/gu;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t).*$/gmu;
const URL_PATTERN = /(?:https?|obsidian):\/\/[^\s)）」』]+/gu;
const ESCAPED_HASH_PATTERN = /\\#/gu;
const TAG_TOKEN_PATTERN = /(?:^|[\s(（「『【、])#([^\s#]+)/gu;
const TRAILING_PUNCTUATION = /[.,;:!?、。，．：；！？)）\]】」』]+$/u;
const TAG_BODY_PATTERN = /^[\p{L}\p{N}_/-]+$/u;
const NON_DIGIT_PATTERN = /[^\d]/u;

/** 本文に現れるタグを、最初に出た順で返す（`#` は含めない）。 */
export function extractTags(body: string): string[] {
  const text = body
    .replace(FENCED_CODE_PATTERN, " ")
    .replace(INLINE_CODE_PATTERN, " ")
    .replace(INDENTED_CODE_PATTERN, " ")
    .replace(URL_PATTERN, " ")
    .replace(ESCAPED_HASH_PATTERN, " ");

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const match of text.matchAll(TAG_TOKEN_PATTERN)) {
    const raw = match[1] ?? "";
    const tag = raw.replace(TRAILING_PUNCTUATION, "");
    if (tag === "" || !TAG_BODY_PATTERN.test(tag)) {
      continue;
    }
    if (!NON_DIGIT_PATTERN.test(tag)) {
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}
