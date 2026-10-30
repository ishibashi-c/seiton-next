/**
 * Prompt Workbench のセッションファイル形式。
 *
 * ```markdown
 * ---
 * kind: prompt-session
 * projects:
 *   - "[[Seiton]]"
 * session_state: open
 * created: "2026-10-26T10:00:00+09:00"
 * ---
 *
 * # UI再設計
 *
 * <!-- seiton:prompt:start id="p_..." at="..." hash="..." -->
 * 指示本文
 * <!-- seiton:prompt:end -->
 *
 * <!-- seiton:draft:start -->
 * 次の指示の下書き
 * <!-- seiton:draft:end -->
 * ```
 */

import { SeitonError } from "./errors";
import type { FrontmatterScan } from "./frontmatter";
import {
  buildFrontmatter,
  scanFrontmatter,
  setFrontmatterScalar,
  yamlQuoted,
} from "./frontmatter";
import type { TextLine } from "./text";
import { detectEol, normalizeNewlines, splitTextLines, stripBom } from "./text";
import { isValidAt } from "./time";

export type PromptDiagnosticCode =
  | "duplicate-id"
  | "frontmatter-unclosed"
  | "invalid-at"
  | "invalid-marker"
  | "orphan-end"
  | "unclosed-draft"
  | "unclosed-entry"
  | "unclosed-fence";

export interface PromptDiagnostic {
  code: PromptDiagnosticCode;
  line: number;
  message: string;
  promptId?: string;
  severity: "error" | "warning";
}

export interface PromptItem {
  at: string;
  attributes: Record<string, string>;
  body: string;
  endLine: number;
  endOffset: number;
  eol: string;
  hash: string | null;
  id: string;
  startLine: number;
  startOffset: number;
}

export interface PromptDraft {
  body: string;
  endLine: number;
  endOffset: number;
  eol: string;
  startLine: number;
  startOffset: number;
}

export interface ParsedPromptLog {
  diagnostics: PromptDiagnostic[];
  draft: PromptDraft | null;
  eol: string;
  frontmatter: FrontmatterScan;
  prompts: PromptItem[];
  title: string;
}

export interface PromptItemInput {
  at: string;
  body: string;
  hash?: string | null;
  id: string;
}

export const PROMPT_END_MARKER = "<!-- seiton:prompt:end -->";
export const PROMPT_ESCAPE_MARKER = "<!-- seiton:prompt:escape -->";
export const DRAFT_END_MARKER = "<!-- seiton:draft:end -->";
export const DRAFT_ESCAPE_MARKER = "<!-- seiton:draft:escape -->";

const PROMPT_START_PATTERN = /^<!--\s*seiton:prompt:start(?:\s+(.*?))?\s*-->$/u;
const PROMPT_END_PATTERN = /^<!--\s*seiton:prompt:end\s*-->$/u;
const PROMPT_ESCAPE_PATTERN = /^<!--\s*seiton:prompt:escape\s*-->$/u;
const DRAFT_START_PATTERN = /^<!--\s*seiton:draft:start\s*-->$/u;
const DRAFT_END_PATTERN = /^<!--\s*seiton:draft:end\s*-->$/u;
const DRAFT_ESCAPE_PATTERN = /^<!--\s*seiton:draft:escape\s*-->$/u;
const ATTRIBUTE_PATTERN = /([A-Za-z_][\w-]*)="([^"]*)"/gu;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/u;
const RESERVED_LINE_PATTERN = /^<!--\s*seiton:/u;
const TITLE_PATTERN = /^#[ \t]+(.+)$/u;

const APPEND_BLOCKING = new Set<PromptDiagnosticCode>([
  "frontmatter-unclosed",
  "unclosed-draft",
  "unclosed-entry",
  "unclosed-fence",
]);

interface FenceState {
  character: "`" | "~";
  length: number;
}

interface PromptCurrent {
  attributes: Record<string, string>;
  bodyLines: string[];
  eol: string;
  id: string;
  startLine: TextLine;
}

interface DraftCurrent {
  bodyLines: string[];
  eol: string;
  startLine: TextLine;
}

interface MarkerData {
  attributes: Record<string, string>;
  id: string;
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#10;/gu, "\n")
    .replace(/&amp;/gu, "&");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\r\n|\r|\n/gu, "&#10;");
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match = ATTRIBUTE_PATTERN.exec(raw);
  while (match) {
    const key = match[1];
    const value = match[2];
    if (key && value !== undefined) {
      attributes[key] = unescapeAttribute(value);
    }
    match = ATTRIBUTE_PATTERN.exec(raw);
  }
  return attributes;
}

function parsePromptStart(text: string): MarkerData | null {
  const match = PROMPT_START_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const attributes = parseAttributes(match[1] ?? "");
  const id = attributes.id ?? "";
  const at = attributes.at ?? "";
  if (id === "" || at === "") {
    return null;
  }
  return { attributes, id };
}

function fenceOpener(text: string): FenceState | null {
  const match = FENCE_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const marker = match[1] ?? "";
  const info = match[2] ?? "";
  if (marker.startsWith("`") && info.includes("`")) {
    return null;
  }
  return {
    character: marker.startsWith("`") ? "`" : "~",
    length: marker.length,
  };
}

function isFenceCloser(text: string, fence: FenceState): boolean {
  const match = FENCE_CLOSE_PATTERN.exec(text);
  if (!match) {
    return false;
  }
  const marker = match[1] ?? "";
  return marker.startsWith(fence.character) && marker.length >= fence.length;
}

function diagnostic(
  code: PromptDiagnosticCode,
  severity: "error" | "warning",
  line: number,
  message: string,
  promptId?: string
): PromptDiagnostic {
  const result: PromptDiagnostic = { code, line, message, severity };
  if (promptId) {
    result.promptId = promptId;
  }
  return result;
}

function escapeBodyLine(line: string, eol: string, marker: string): string {
  return RESERVED_LINE_PATTERN.test(line) ? `${marker}${eol}${line}` : line;
}

function formatBody(body: string, eol: string, marker: string): string {
  return normalizeNewlines(body)
    .split("\n")
    .map((line) => escapeBodyLine(line, eol, marker))
    .join(eol);
}

/** セッションの初期内容。 */
export function createPromptSessionDocument(input: {
  title: string;
  createdAt: string;
  project?: string | null;
  eol?: string;
}): string {
  const eol = input.eol ?? "\n";
  const fields: Record<string, string> = {
    created: yamlQuoted(input.createdAt),
    kind: "prompt-session",
  };
  if (input.project) {
    fields.projects = `\n  - ${yamlQuoted(`[[${input.project}]]`)}`;
  }
  fields.session_state = "open";

  const frontmatter = buildFrontmatter(fields, eol);
  const draft = formatDraft("", eol);
  return `${frontmatter}${eol}# ${input.title}${eol}${eol}${draft}${eol}`;
}

/** 下書きブロック。 */
export function formatDraft(body: string, eol = "\n"): string {
  const content = formatBody(body, eol, DRAFT_ESCAPE_MARKER);
  return ["<!-- seiton:draft:start -->", content, DRAFT_END_MARKER].join(eol);
}

/** コピー履歴の1ブロック。 */
export function formatPromptItem(input: PromptItemInput, eol = "\n"): string {
  const attributes: Record<string, string> = {
    at: input.at,
    id: input.id,
  };
  if (input.hash) {
    attributes.hash = input.hash;
  }
  const marker = [
    "<!-- seiton:prompt:start",
    ...["id", "at", "hash"]
      .filter((key) => attributes[key] !== undefined)
      .map((key) => `${key}="${escapeAttribute(attributes[key] ?? "")}"`),
    "-->",
  ].join(" ");
  const body = formatBody(input.body, eol, PROMPT_ESCAPE_MARKER);
  return [marker, body, PROMPT_END_MARKER].join(eol);
}

/** 文字列の軽量ハッシュ。重複コピーの判定に使う。 */
export function promptHash(body: string): string {
  const text = normalizeNewlines(body).trim();
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** セッション全体を解析する。 */
export function parsePromptLog(content: string): ParsedPromptLog {
  const eol = detectEol(content);
  const lines = splitTextLines(content);
  const frontmatter = scanFrontmatter(content);
  const diagnostics: PromptDiagnostic[] = [];
  const prompts: PromptItem[] = [];
  let draft: PromptDraft | null = null;
  let title = "";

  if (frontmatter.present && !frontmatter.closed) {
    diagnostics.push(
      diagnostic(
        "frontmatter-unclosed",
        "error",
        1,
        "frontmatter の終端（---）が見つかりません。"
      )
    );
    return { diagnostics, draft, eol, frontmatter, prompts, title };
  }

  let currentPrompt: PromptCurrent | null = null;
  let currentDraft: DraftCurrent | null = null;
  let fence: FenceState | null = null;
  let hasDraft = false;
  const startIndex = frontmatter.present ? frontmatter.bodyStartLine : 0;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const text = index === 0 ? stripBom(line.text) : line.text;

    if (currentPrompt) {
      if (PROMPT_ESCAPE_PATTERN.test(text)) {
        const next = lines[index + 1];
        if (!next) {
          diagnostics.push(
            diagnostic(
              "unclosed-entry",
              "error",
              currentPrompt.startLine.number,
              "escape マーカーの直後に本文行がありません。",
              currentPrompt.id
            )
          );
          currentPrompt = null;
          break;
        }
        currentPrompt.bodyLines.push(next.text);
        index += 1;
        continue;
      }
      if (PROMPT_END_PATTERN.test(text)) {
        const attributes = currentPrompt.attributes;
        prompts.push({
          at: attributes.at ?? "",
          attributes,
          body: currentPrompt.bodyLines.join("\n"),
          endLine: line.number,
          endOffset: line.textEnd,
          eol: currentPrompt.eol || eol,
          hash: attributes.hash ?? null,
          id: currentPrompt.id,
          startLine: currentPrompt.startLine.number,
          startOffset: currentPrompt.startLine.start,
        });
        currentPrompt = null;
        continue;
      }
      currentPrompt.bodyLines.push(line.text);
      continue;
    }

    if (currentDraft) {
      if (DRAFT_ESCAPE_PATTERN.test(text)) {
        const next = lines[index + 1];
        if (!next) {
          diagnostics.push(
            diagnostic(
              "unclosed-draft",
              "error",
              currentDraft.startLine.number,
              "draft の escape マーカーの直後に本文行がありません。"
            )
          );
          currentDraft = null;
          break;
        }
        currentDraft.bodyLines.push(next.text);
        index += 1;
        continue;
      }
      if (DRAFT_END_PATTERN.test(text)) {
        draft = {
          body: currentDraft.bodyLines.join("\n"),
          endLine: line.number,
          endOffset: line.textEnd,
          eol: currentDraft.eol || eol,
          startLine: currentDraft.startLine.number,
          startOffset: currentDraft.startLine.start,
        };
        currentDraft = null;
        continue;
      }
      currentDraft.bodyLines.push(line.text);
      continue;
    }

    if (fence) {
      if (isFenceCloser(text, fence)) {
        fence = null;
      }
      continue;
    }

    const opener = fenceOpener(text);
    if (opener) {
      fence = opener;
      continue;
    }

    if (PROMPT_END_PATTERN.test(text) || DRAFT_END_PATTERN.test(text)) {
      diagnostics.push(
        diagnostic(
          "orphan-end",
          "warning",
          line.number,
          "開始マーカーのない終了マーカーがあります。"
        )
      );
      continue;
    }

    if (DRAFT_START_PATTERN.test(text)) {
      if (hasDraft) {
        diagnostics.push(
          diagnostic(
            "invalid-marker",
            "warning",
            line.number,
            "下書きブロックが複数あります。最初のものだけを使います。"
          )
        );
        continue;
      }
      hasDraft = true;
      currentDraft = {
        bodyLines: [],
        eol: line.eol || eol,
        startLine: line,
      };
      continue;
    }

    if (PROMPT_START_PATTERN.test(text)) {
      const marker = parsePromptStart(text);
      if (!marker) {
        diagnostics.push(
          diagnostic(
            "invalid-marker",
            "error",
            line.number,
            "開始マーカーに id または at がありません。"
          )
        );
        continue;
      }
      currentPrompt = {
        attributes: marker.attributes,
        bodyLines: [],
        eol: line.eol || eol,
        id: marker.id,
        startLine: line,
      };
      continue;
    }

    const titleMatch = TITLE_PATTERN.exec(text);
    if (!title && titleMatch?.[1]) {
      title = titleMatch[1].trim();
    }
  }

  if (currentPrompt) {
    diagnostics.push(
      diagnostic(
        "unclosed-entry",
        "error",
        currentPrompt.startLine.number,
        "終了マーカーのない指示があります。",
        currentPrompt.id
      )
    );
  }
  if (currentDraft) {
    diagnostics.push(
      diagnostic(
        "unclosed-draft",
        "error",
        currentDraft.startLine.number,
        "終了マーカーのない下書きがあります。"
      )
    );
  }
  if (fence) {
    diagnostics.push(
      diagnostic(
        "unclosed-fence",
        "error",
        lines[startIndex]?.number ?? 1,
        "閉じていないコードフェンスがあります。"
      )
    );
  }

  for (const prompt of prompts) {
    if (!isValidAt(prompt.at)) {
      diagnostics.push(
        diagnostic(
          "invalid-at",
          "error",
          prompt.startLine,
          "指示の日時（at）が ISO 8601 として不正です。",
          prompt.id
        )
      );
    }
  }

  const counts = new Map<string, number>();
  for (const prompt of prompts) {
    counts.set(prompt.id, (counts.get(prompt.id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      diagnostics.push(
        diagnostic(
          "duplicate-id",
          "error",
          prompts.find((prompt) => prompt.id === id)?.startLine ?? 1,
          `同じID（${id}）の指示が ${count} 件あります。`,
          id
        )
      );
    }
  }

  diagnostics.sort((left, right) => left.line - right.line);
  return { diagnostics, draft, eol, frontmatter, prompts, title };
}

function blockingDiagnostic(
  parsed: ParsedPromptLog
): PromptDiagnostic | undefined {
  return parsed.diagnostics.find(
    (item) => item.severity === "error" && APPEND_BLOCKING.has(item.code)
  );
}

function assertAppendable(parsed: ParsedPromptLog): void {
  const blocking = blockingDiagnostic(parsed);
  if (blocking) {
    throw new SeitonError(
      "MEMO_FORMAT",
      `プロンプトセッションを安全に更新できない構造です（${blocking.line}行目: ${blocking.message}）。`,
      { detail: blocking.code }
    );
  }
  const duplicate = parsed.diagnostics.find(
    (item) => item.code === "duplicate-id"
  );
  if (duplicate) {
    throw new SeitonError(
      "MEMO_ID_DUPLICATE",
      "同じIDの指示が複数あるため、安全に更新できません。"
    );
  }
}

/** コピー履歴を下書きの直前へ追記する。 */
export function appendPromptItem(
  content: string,
  input: PromptItemInput
): string {
  const parsed = parsePromptLog(content);
  assertAppendable(parsed);
  const eol = parsed.eol;
  const item = formatPromptItem(input, eol);

  if (parsed.draft) {
    let prefix = content.slice(0, parsed.draft.startOffset);
    if (!prefix.endsWith("\n") && !prefix.endsWith("\r")) {
      prefix += eol;
    }
    if (!prefix.endsWith(`${eol}${eol}`)) {
      prefix += eol;
    }
    return `${prefix}${item}${eol}${eol}${content.slice(
      parsed.draft.startOffset
    )}`;
  }

  let output = content;
  if (!output.endsWith("\n") && !output.endsWith("\r")) {
    output += eol;
  }
  if (!output.endsWith(`${eol}${eol}`)) {
    output += eol;
  }
  return `${output}${item}${eol}`;
}

/** 下書きを更新する。ブロックがなければ末尾に作る。 */
export function updatePromptDraft(content: string, body: string): string {
  const parsed = parsePromptLog(content);
  assertAppendable(parsed);
  const eol = parsed.eol;
  const formatted = formatDraft(body, eol);

  if (parsed.draft) {
    return [
      content.slice(0, parsed.draft.startOffset),
      formatted,
      content.slice(parsed.draft.endOffset),
    ].join("");
  }

  let output = content;
  if (!output.endsWith("\n") && !output.endsWith("\r")) {
    output += eol;
  }
  if (!output.endsWith(`${eol}${eol}`)) {
    output += eol;
  }
  return `${output}${formatted}${eol}`;
}

/** セッション状態を frontmatter に書く。 */
export function setPromptSessionState(
  content: string,
  state: "open" | "closed"
): string {
  return setFrontmatterScalar(content, "session_state", state);
}

/** 最新の指示と同一内容かを判定する。 */
export function isDuplicateOfLatest(
  parsed: ParsedPromptLog,
  body: string
): boolean {
  const latest = parsed.prompts.at(-1);
  return latest !== undefined && latest.body.trim() === body.trim();
}

/** 日時と本文の一覧を、Markdownの会話形式で返す。 */
export function exportPromptHistory(parsed: ParsedPromptLog): string {
  return parsed.prompts
    .map((prompt) => [`### ${prompt.at}`, "", prompt.body, ""].join("\n"))
    .join("\n");
}
