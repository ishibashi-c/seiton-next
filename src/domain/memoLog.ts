/**
 * 週次一言メモのファイル文法。
 *
 * ```markdown
 * ---
 * kind: memo-log
 * week: 2026-W44
 * created: "2026-10-26T09:32:00+09:00"
 * ---
 *
 * ## 2026-10-26
 *
 * <!-- seiton:memo:start id="m_..." at="2026-10-26T09:32:00+09:00" state="active" v="1" -->
 * 本文
 * <!-- seiton:memo:end -->
 * ```
 *
 * - エントリ境界はHTMLコメントの開始/終了マーカー。見出しは構造の正本にしない。
 * - 本文中の予約マーカー行は escape マーカーで1行エスケープし、読み込み時に復元する。
 * - 未完了マーカー・コードフェンス・重複IDを検出したら、構造を壊す書き込みを拒否する。
 */

import { SeitonError } from "./errors";
import type { FrontmatterScan } from "./frontmatter";
import { buildFrontmatter, scanFrontmatter, yamlQuoted } from "./frontmatter";
import type { TextLine } from "./text";
import {
  detectEol,
  escapeHtmlAttribute,
  normalizeNewlines,
  splitTextLines,
  stripBom,
  unescapeHtmlAttribute,
} from "./text";
import { dateKeyOf, isValidAt } from "./time";

export type MemoState = "active" | "deleted" | "promoted" | "unknown";

export type MemoDiagnosticCode =
  | "duplicate-id"
  | "frontmatter-duplicate"
  | "frontmatter-unclosed"
  | "invalid-at"
  | "invalid-marker"
  | "orphan-end"
  | "unclosed-entry"
  | "unclosed-escape"
  | "unclosed-fence"
  | "unknown-state";

export interface MemoDiagnostic {
  code: MemoDiagnosticCode;
  entryId?: string;
  line: number;
  message: string;
  severity: "error" | "warning";
}

export interface MemoEntry {
  /** 記録した端末のローカル時刻 + オフセット */
  at: string;
  /** 開始マーカーの全属性（未知の属性も保持） */
  attributes: Record<string, string>;
  body: string;
  deletedAt: string | null;
  endLine: number;
  /** 終了マーカーの `-->` 直後（排他） */
  endOffset: number;
  eol: string;
  id: string;
  promotedTo: string | null;
  startLine: number;
  startOffset: number;
  state: MemoState;
}

export interface MemoDayHeading {
  date: string;
  line: number;
  offset: number;
}

export interface ParsedMemoLog {
  dayHeadings: MemoDayHeading[];
  diagnostics: MemoDiagnostic[];
  entries: MemoEntry[];
  eol: string;
  frontmatter: FrontmatterScan;
}

export interface MemoEntryWrite {
  at: string;
  attributes?: Record<string, string>;
  body: string;
  deletedAt?: string | null;
  id: string;
  promotedTo?: string | null;
  state?: string;
}

export interface MemoEntryPatch {
  attributes?: Record<string, string>;
  body?: string;
  deletedAt?: string | null;
  promotedTo?: string | null;
  state?: string;
}

export const MEMO_END_MARKER = "<!-- seiton:memo:end -->";

/** 週次ファイルの初期内容。既存ファイルには使わない。 */
export function createMemoLogDocument(
  week: string,
  createdAt: string,
  eol = "\n"
): string {
  const frontmatter = buildFrontmatter(
    {
      created: yamlQuoted(createdAt),
      kind: "memo-log",
      week,
    },
    eol
  );
  return `${frontmatter}${eol}`;
}
export const MEMO_ESCAPE_MARKER = "<!-- seiton:memo:escape -->";

const START_PATTERN = /^<!--\s*seiton:memo:start(?:\s+(.*?))?\s*-->$/u;
const END_PATTERN = /^<!--\s*seiton:memo:end\s*-->$/u;
const ESCAPE_PATTERN = /^<!--\s*seiton:memo:escape\s*-->$/u;
const ATTRIBUTE_PATTERN = /([A-Za-z_][\w-]*)="([^"]*)"/gu;
const DAY_HEADING_PATTERN = /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/u;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/u;
const RESERVED_LINE_PATTERN = /^<!--\s*seiton:/u;

/** 追記を止めるべき構造エラー。 */
const APPEND_BLOCKING = new Set<MemoDiagnosticCode>([
  "frontmatter-duplicate",
  "frontmatter-unclosed",
  "unclosed-entry",
  "unclosed-escape",
  "unclosed-fence",
]);

/** 既存項目の変更を止めるべき構造エラー。 */
const MUTATE_BLOCKING = new Set<MemoDiagnosticCode>([
  ...APPEND_BLOCKING,
  "duplicate-id",
]);

interface FenceState {
  character: "`" | "~";
  length: number;
}

interface CurrentEntry {
  attributes: Record<string, string>;
  bodyLines: string[];
  eol: string;
  id: string;
  startLine: TextLine;
}

function normalizeState(value: string): MemoState {
  if (value === "active" || value === "deleted" || value === "promoted") {
    return value;
  }
  return "unknown";
}

function parseStartMarker(
  text: string
): { attributes: Record<string, string>; id: string; at: string } | null {
  const match = START_PATTERN.exec(text);
  if (!match) {
    return null;
  }

  const attributes: Record<string, string> = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let attributeMatch = ATTRIBUTE_PATTERN.exec(match[1] ?? "");
  while (attributeMatch) {
    const key = attributeMatch[1];
    const value = attributeMatch[2];
    if (key && value !== undefined) {
      attributes[key] = unescapeHtmlAttribute(value);
    }
    attributeMatch = ATTRIBUTE_PATTERN.exec(match[1] ?? "");
  }

  const id = attributes.id ?? "";
  const at = attributes.at ?? "";
  if (id === "" || at === "") {
    return null;
  }
  return { at, attributes, id };
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

function makeDiagnostic(
  code: MemoDiagnosticCode,
  severity: "error" | "warning",
  line: number,
  message: string,
  entryId?: string
): MemoDiagnostic {
  const diagnostic: MemoDiagnostic = { code, line, message, severity };
  if (entryId) {
    diagnostic.entryId = entryId;
  }
  return diagnostic;
}

/**
 * 文書全体を解析する。未知のテキストは変更しない。
 * 壊れた構造は diagnostics に残し、entries には安全に読めたものだけを返す。
 */
export function parseMemoLog(content: string): ParsedMemoLog {
  const eol = detectEol(content);
  const lines = splitTextLines(content);
  const frontmatter = scanFrontmatter(content);
  const diagnostics: MemoDiagnostic[] = [];
  const entries: MemoEntry[] = [];
  const dayHeadings: MemoDayHeading[] = [];

  if (frontmatter.present && !frontmatter.closed) {
    diagnostics.push(
      makeDiagnostic(
        "frontmatter-unclosed",
        "error",
        1,
        "frontmatter の終端（---）が見つかりません。"
      )
    );
    return { dayHeadings, diagnostics, entries, eol, frontmatter };
  }

  for (const key of frontmatter.duplicateKeys) {
    if (key === "kind" || key === "week" || key === "created") {
      diagnostics.push(
        makeDiagnostic(
          "frontmatter-duplicate",
          "error",
          1,
          `frontmatter の ${key} が重複しています。`
        )
      );
    }
  }

  const startIndex = frontmatter.present ? frontmatter.bodyStartLine : 0;
  let current: CurrentEntry | null = null;
  let fence: FenceState | null = null;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const text = index === 0 ? stripBom(line.text) : line.text;

    if (current) {
      if (ESCAPE_PATTERN.test(text)) {
        const next = lines[index + 1];
        if (!next) {
          diagnostics.push(
            makeDiagnostic(
              "unclosed-escape",
              "error",
              line.number,
              "escape マーカーの直後に本文行がありません。",
              current.id
            )
          );
          current = null;
          break;
        }
        current.bodyLines.push(next.text);
        index += 1;
        continue;
      }

      if (END_PATTERN.test(text)) {
        entries.push({
          at: current.attributes.at ?? "",
          attributes: current.attributes,
          body: current.bodyLines.join("\n"),
          deletedAt: current.attributes.deleted_at ?? null,
          endLine: line.number,
          endOffset: line.textEnd,
          eol: current.eol || eol,
          id: current.id,
          promotedTo: current.attributes.promoted_to ?? null,
          startLine: current.startLine.number,
          startOffset: current.startLine.start,
          state: normalizeState(current.attributes.state ?? "active"),
        });
        current = null;
        continue;
      }

      current.bodyLines.push(line.text);
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

    if (END_PATTERN.test(text)) {
      diagnostics.push(
        makeDiagnostic(
          "orphan-end",
          "warning",
          line.number,
          "開始マーカーのない終了マーカーがあります。"
        )
      );
      continue;
    }

    if (START_PATTERN.test(text)) {
      const parsedMarker = parseStartMarker(text);
      if (!parsedMarker) {
        diagnostics.push(
          makeDiagnostic(
            "invalid-marker",
            "error",
            line.number,
            "開始マーカーに id または at がありません。"
          )
        );
        continue;
      }
      current = {
        attributes: parsedMarker.attributes,
        bodyLines: [],
        eol: line.eol || eol,
        id: parsedMarker.id,
        startLine: line,
      };
      continue;
    }

    const heading = DAY_HEADING_PATTERN.exec(text);
    if (heading?.[1]) {
      dayHeadings.push({
        date: heading[1],
        line: line.number,
        offset: line.start,
      });
    }
  }

  if (current) {
    diagnostics.push(
      makeDiagnostic(
        "unclosed-entry",
        "error",
        current.startLine.number,
        "終了マーカーのないメモ項目があります。",
        current.id
      )
    );
  }

  if (fence) {
    diagnostics.push(
      makeDiagnostic(
        "unclosed-fence",
        "error",
        lines[startIndex]?.number ?? 1,
        "閉じていないコードフェンスがあります。"
      )
    );
  }

  for (const entry of entries) {
    if (!isValidAt(entry.at)) {
      diagnostics.push(
        makeDiagnostic(
          "invalid-at",
          "error",
          entry.startLine,
          "メモの日時（at）が ISO 8601 として不正です。",
          entry.id
        )
      );
    }
    if (entry.state === "unknown") {
      diagnostics.push(
        makeDiagnostic(
          "unknown-state",
          "warning",
          entry.startLine,
          `未知の状態「${entry.attributes.state ?? ""}」です。`,
          entry.id
        )
      );
    }
  }

  const byId = new Map<string, MemoEntry[]>();
  for (const entry of entries) {
    const group = byId.get(entry.id) ?? [];
    group.push(entry);
    byId.set(entry.id, group);
  }
  for (const [id, group] of byId) {
    if (group.length > 1) {
      diagnostics.push(
        makeDiagnostic(
          "duplicate-id",
          "error",
          group[0]?.startLine ?? 1,
          `同じID（${id}）のメモが ${group.length} 件あります。`,
          id
        )
      );
    }
  }

  diagnostics.sort((left, right) => {
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.code.localeCompare(right.code);
  });

  return { dayHeadings, diagnostics, entries, eol, frontmatter };
}

function blockingDiagnostic(
  parsed: ParsedMemoLog,
  codes: Set<MemoDiagnosticCode>
): MemoDiagnostic | undefined {
  return parsed.diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === "error" && codes.has(diagnostic.code)
  );
}

/** 追記してよい構造か。 */
export function assertMemoAppendable(parsed: ParsedMemoLog): void {
  const blocking = blockingDiagnostic(parsed, APPEND_BLOCKING);
  if (!blocking) {
    return;
  }
  throw new SeitonError(
    "MEMO_FORMAT",
    `週次メモを安全に追記できない構造です（${blocking.line}行目: ${blocking.message}）。ファイルを確認してください。`,
    { detail: blocking.code }
  );
}

/** 既存項目を変更してよい構造か。 */
export function assertMemoMutable(parsed: ParsedMemoLog): void {
  const blocking = blockingDiagnostic(parsed, MUTATE_BLOCKING);
  if (!blocking) {
    return;
  }
  throw new SeitonError(
    "MEMO_FORMAT",
    `週次メモを安全に更新できない構造です（${blocking.line}行目: ${blocking.message}）。ファイルを確認してください。`,
    { detail: blocking.code }
  );
}

/** IDで1件だけ取得する。重複IDは安全のため拒否する。 */
export function findMemoEntry(parsed: ParsedMemoLog, id: string): MemoEntry {
  const matches = parsed.entries.filter((entry) => entry.id === id);
  if (matches.length === 0) {
    throw new SeitonError(
      "MEMO_NOT_FOUND",
      "対象のメモが見つかりませんでした。ファイルが変更された可能性があります。"
    );
  }
  if (matches.length > 1) {
    throw new SeitonError(
      "MEMO_ID_DUPLICATE",
      "同じIDのメモが複数あるため、安全に更新できません。"
    );
  }
  const entry = matches[0];
  if (!entry) {
    throw new SeitonError(
      "MEMO_NOT_FOUND",
      "対象のメモが見つかりませんでした。"
    );
  }
  return entry;
}

function escapeBodyLine(line: string, eol: string): string {
  if (RESERVED_LINE_PATTERN.test(line)) {
    return `${MEMO_ESCAPE_MARKER}${eol}${line}`;
  }
  return line;
}

/** 1件分のマーカー付きブロックを生成する。 */
export function formatMemoEntry(
  entry: MemoEntryWrite,
  options: { eol?: string } = {}
): string {
  const eol = options.eol ?? "\n";
  const attributes: Record<string, string> = { ...entry.attributes };
  attributes.id = entry.id;
  attributes.at = entry.at;

  if (entry.state !== undefined) {
    attributes.state = entry.state;
  } else if (attributes.state === undefined) {
    attributes.state = "active";
  }
  if (attributes.v === undefined) {
    attributes.v = "1";
  }

  if (entry.deletedAt !== undefined) {
    if (entry.deletedAt === null) {
      delete attributes.deleted_at;
    } else {
      attributes.deleted_at = entry.deletedAt;
    }
  }
  if (entry.promotedTo !== undefined) {
    if (entry.promotedTo === null) {
      delete attributes.promoted_to;
    } else {
      attributes.promoted_to = entry.promotedTo;
    }
  }

  const orderedKeys = ["id", "at", "state", "v", "deleted_at", "promoted_to"];
  const extraKeys = Object.keys(attributes)
    .filter((key) => !orderedKeys.includes(key))
    .sort();
  const keys = [
    ...orderedKeys.filter((key) => attributes[key] !== undefined),
    ...extraKeys,
  ];

  const markerAttributes = keys
    .map((key) => `${key}="${escapeHtmlAttribute(attributes[key] ?? "")}"`)
    .join(" ");
  const body = normalizeNewlines(entry.body)
    .split("\n")
    .map((line) => escapeBodyLine(line, eol))
    .join(eol);

  return [
    `<!-- seiton:memo:start ${markerAttributes} -->`,
    body,
    MEMO_END_MARKER,
  ].join(eol);
}

export interface MemoAppendInput {
  at: string;
  body: string;
  id: string;
}

/**
 * 文書末尾へ1件追記する。既存の本文・frontmatter・マーカーは書き換えない。
 * 追記位置は常に末尾。同じ日付の `## YYYY-MM-DD` が最後の日見出しなら再利用する。
 */
export function appendMemoEntry(
  content: string,
  entry: MemoAppendInput
): string {
  const parsed = parseMemoLog(content);
  assertMemoAppendable(parsed);

  const date = dateKeyOf(entry.at);
  if (date === "") {
    throw new SeitonError(
      "MEMO_FORMAT",
      "メモの日時が不正なため保存できません。"
    );
  }

  const eol = parsed.eol;
  const entryText = formatMemoEntry(entry, { eol });
  const lastHeading = parsed.dayHeadings.at(-1)?.date;
  const needsHeading = lastHeading !== date;

  if (content.length === 0) {
    return `## ${date}${eol}${eol}${entryText}${eol}`;
  }

  let output = content;
  if (!output.endsWith("\n") && !output.endsWith("\r")) {
    output += eol;
  }
  if (!output.endsWith(`${eol}${eol}`)) {
    output += eol;
  }
  if (needsHeading) {
    output += `## ${date}${eol}${eol}`;
  }
  output += `${entryText}${eol}`;
  return output;
}

/**
 * 1件の本文・状態を更新する。対象ブロック以外の文字列は変更しない。
 */
export function updateMemoEntry(
  content: string,
  id: string,
  patch: MemoEntryPatch
): string {
  const parsed = parseMemoLog(content);
  assertMemoMutable(parsed);
  const entry = findMemoEntry(parsed, id);
  const attributes: Record<string, string> = {
    ...entry.attributes,
    ...patch.attributes,
  };

  if (patch.state !== undefined) {
    attributes.state = patch.state;
  }
  if (patch.deletedAt !== undefined) {
    if (patch.deletedAt === null) {
      delete attributes.deleted_at;
    } else {
      attributes.deleted_at = patch.deletedAt;
    }
  }
  if (patch.promotedTo !== undefined) {
    if (patch.promotedTo === null) {
      delete attributes.promoted_to;
    } else {
      attributes.promoted_to = patch.promotedTo;
    }
  }

  const replacement = formatMemoEntry(
    {
      at: entry.at,
      attributes,
      body: patch.body ?? entry.body,
      id: entry.id,
    },
    { eol: entry.eol || parsed.eol }
  );

  return [
    content.slice(0, entry.startOffset),
    replacement,
    content.slice(entry.endOffset),
  ].join("");
}

/** 表示順: 記録日時の新しい順。同時刻はファイル内の順を保つ（安定ソート）。 */
export function compareMemoEntriesNewestFirst(
  left: MemoEntry,
  right: MemoEntry
): number {
  const leftTime = Date.parse(left.at);
  const rightTime = Date.parse(right.at);
  const leftValue = Number.isNaN(leftTime) ? 0 : leftTime;
  const rightValue = Number.isNaN(rightTime) ? 0 : rightTime;
  return rightValue - leftValue;
}

/** 通常タイムラインに表示する状態か。削除済みだけを除外する。 */
export function isMemoVisible(entry: MemoEntry): boolean {
  return entry.state !== "deleted";
}

/** 昇格済みのメモに付ける表示用リンク。 */
export function promotionLinkFor(entry: MemoEntry): string | null {
  if (!entry.promotedTo) {
    return null;
  }
  const target = entry.promotedTo.replace(/\.md$/u, "");
  return `[[${target}]]`;
}
