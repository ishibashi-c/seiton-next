/**
 * 旧Seitonデータの読み取り専用解析と、新形式へのコピー変換計画。
 *
 * - Obsidian API に依存しない。ユニットテストできる純関数だけを置く。
 * - 元ファイルの内容は変更しない。変換後の文書・パス・ログだけを組み立てる。
 * - 不明な値は捨てず、そのまま保持して「要確認」として報告する。
 */

import {
  bodyAfterFrontmatter,
  scanFrontmatter,
  yamlQuoted,
} from "./frontmatter";
import { ID_ALPHABET } from "./ids";
import { weekIdOf } from "./isoWeek";
import { sanitizeNoteTitle } from "./notes";
import { detectEol, normalizeNewlines, splitTextLines } from "./text";
import { formatLocalIso, isValidDateKey } from "./time";

/** 移行先ノートに残す、移行元の識別子。再変換時の冪等キー。 */
export const MIGRATION_SOURCE_KEY = "migration_source";
export const MIGRATION_HASH_KEY = "migration_hash";
export const MIGRATION_LOG_KIND = "migration-log";

/** 旧Propertiesのうち、新形式へ写像する、または読み取り対象にするキー。 */
export const LEGACY_PROPERTY_KEYS: readonly string[] = [
  "baseTags",
  "bookAuthor",
  "bookCategory",
  "bookCover",
  "bookFinished",
  "bookIsbn",
  "bookOwnership",
  "bookRating",
  "bookSeries",
  "month",
  "readingStatus",
  "sourceTags",
  "status",
  "type",
];

/** 旧 `type` から新 `kind` への対応表。ここにない値はそのまま保持する。 */
export const LEGACY_TYPE_TO_KIND: Readonly<Record<string, string>> = {
  article: "article",
  book: "book",
  class: "class",
  clip: "webclip",
  collection: "collection",
  idea: "idea",
  note: "note",
  profile: "profile",
  project: "project",
  reading: "reading",
  task: "task",
  webclip: "webclip",
};

/** 旧書誌キーから新書誌キーへの対応表。ISBNは文字列のまま保持する。 */
export const LEGACY_BOOK_KEY_MAP: Readonly<Record<string, string>> = {
  bookAuthor: "book_author",
  bookCategory: "book_category",
  bookCover: "book_cover",
  bookFinished: "book_finished",
  bookIsbn: "book_isbn",
  bookOwnership: "book_ownership",
  bookRating: "book_rating",
  bookSeries: "book_series",
  readingStatus: "reading_status",
};

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const OFFSET_PATTERN = /^[+-]\d{2}:\d{2}$/u;
const SIMPLE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DAY_HEADING_PATTERN = /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/u;
const ANY_HEADING_PATTERN = /^#{1,6}[ \t]/u;
const LEGACY_MEMO_LINE_PATTERN =
  /^[ \t]*[-*+][ \t]+(\d{1,2}):(\d{2})(?:[ \t]+(.*))?$/u;
const YAML_KEY_PATTERN = /^([A-Za-z0-9_-]+):(.*)$/u;
const LOG_FIELD_PATTERN =
  /^-[ \t]+(元|新|元ハッシュ|変換日時|結果|件数|ISBN|備考):[ \t]*(.*)$/u;
const LOG_RESULT_PATTERN = /(converted|skipped|failed)/u;
const QUOTED_VALUE_PATTERN = /`([^`]*)`/gu;
const MONTHLY_TYPES: ReadonlySet<string> = new Set([
  "memo",
  "memo-month",
  "monthly",
  "monthly-memo",
]);

const HASH_SEED = 0x81_1c_9d_c5;
const HASH_MULTIPLIER = 0x01_00_01_93;

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, HASH_MULTIPLIER) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/** 軽量な文字列ハッシュ（FNV-1a 32bit を2回）。16桁の16進文字列。 */
export function stableHash(value: string): string {
  const first = hex8(fnv1a32(value, HASH_SEED));
  const second = hex8(fnv1a32(value, HASH_SEED ^ 0x9e_37_79_b9));
  return `${first}${second}`;
}

/** 元ファイル内容のハッシュ。改行コードも含めて比較する。 */
export function contentHash(content: string): string {
  return stableHash(content);
}

function base32FromSeed(value: string, length: number): string {
  let output = "";
  let block = 0;
  while (output.length < length) {
    let number = fnv1a32(value, (HASH_SEED + block * HASH_MULTIPLIER) >>> 0);
    for (let index = 0; index < 6 && output.length < length; index += 1) {
      output += ID_ALPHABET[number % 32] ?? "0";
      number = Math.floor(number / 32);
    }
    block += 1;
  }
  return output;
}

export interface MigrationEntryIdInput {
  at: string;
  body: string;
  line: number;
  sourcePath: string;
}

/**
 * 月次メモ1行分の安定ID。同じ元ファイル・行・日時・本文からは常に同じIDになる。
 * 失敗後の再試行で同じ項目を二重に追記しないための冪等キー。
 */
export function migrationEntryId(input: MigrationEntryIdInput): string {
  const seed = [
    input.sourcePath,
    String(input.line),
    input.at,
    input.body,
  ].join("\n");
  return `m_${base32FromSeed(seed, 26)}`;
}

export type LegacyStatusKind =
  | "active"
  | "archive"
  | "inbox"
  | "none"
  | "other";

export interface LegacyFlags {
  archived: boolean;
  pinned: boolean;
  review: boolean;
}

export interface LegacyPropertyMapping {
  /** 新書誌キー（`book_isbn` など）だけを持つ */
  book: Record<string, string>;
  flags: LegacyFlags;
  kind: string;
  /** 旧キーの生値（読み取り専用。ログ・調査用） */
  legacy: Record<string, string>;
  month: string;
  needsReview: boolean;
  reviewReasons: string[];
  status: string;
  statusKind: LegacyStatusKind;
  type: string;
  warnings: string[];
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

function booleanValue(value: string | undefined): boolean {
  const normalized = trimmed(value).toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "1";
}

function statusKindOf(status: string): LegacyStatusKind {
  if (status === "") {
    return "none";
  }
  if (status === "active") {
    return "active";
  }
  if (status === "archive") {
    return "archive";
  }
  if (status === "inbox") {
    return "inbox";
  }
  return "other";
}

/**
 * 旧Propertiesを新形式へ写像する。読み取り専用で、入力は変更しない。
 *
 * - `status: inbox` は旧デフォルトなので `review: true` を作らない。
 * - `status: archive` だけ `archived: true` にする。
 * - `status: active` は特別扱いしない。
 * - 対応表にない `type` は値と意味を保ったまま `kind` に残す。
 */
export function mapLegacyProperties(
  fields: Record<string, string>
): LegacyPropertyMapping {
  const type = trimmed(fields.type);
  const status = trimmed(fields.status);
  const statusKind = statusKindOf(status);
  const rawType = type.toLowerCase();
  const mappedKind = LEGACY_TYPE_TO_KIND[rawType] ?? "";

  const book: Record<string, string> = {};
  for (const [legacyKey, newKey] of Object.entries(LEGACY_BOOK_KEY_MAP)) {
    const value = trimmed(fields[legacyKey]);
    if (value !== "") {
      book[newKey] = value;
    }
  }
  const hasBookField = Object.keys(book).length > 0;

  const reviewReasons: string[] = [];
  let kind = mappedKind;
  if (rawType === "reading" && hasBookField) {
    kind = "book";
  } else if (kind === "") {
    if (type === "") {
      kind = "note";
    } else {
      // 意味が不明な type は捨てず、そのまま kind として保持して要確認にする。
      kind = type;
      reviewReasons.push(
        `旧 type「${type}」に対応する kind がないため、値をそのまま保持しました。`
      );
    }
  }

  const warnings: string[] = [];
  const rawMonth = trimmed(fields.month);
  let month = "";
  if (rawMonth !== "") {
    if (MONTH_PATTERN.test(rawMonth)) {
      month = rawMonth;
    } else {
      warnings.push(
        `month プロパティ「${rawMonth}」は YYYY-MM 形式ではないため、コピーしません。`
      );
    }
  }
  if (statusKind === "other") {
    warnings.push(
      `未知の status「${status}」は archived などへ変換せず、変換ログにだけ残します。`
    );
  }

  const legacy: Record<string, string> = {};
  for (const key of LEGACY_PROPERTY_KEYS) {
    const value = trimmed(fields[key]);
    if (value !== "") {
      legacy[key] = value;
    }
  }

  return {
    book,
    flags: {
      archived: statusKind === "archive",
      pinned: booleanValue(fields.pinned),
      // 旧ファイルに `review: true` が明示されている場合だけ引き継ぐ。
      review: booleanValue(fields.review),
    },
    kind,
    legacy,
    month,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    status,
    statusKind,
    type,
    warnings,
  };
}

/** 旧書誌キーに ISBN があるか。文字列のまま扱い、先頭の 0 を落とさない。 */
export function isbnsOf(mapping: LegacyPropertyMapping): string[] {
  const value = mapping.book.book_isbn ?? "";
  return value === "" ? [] : [value];
}

export type MigrationCategory =
  | "already-new"
  | "legacy-memo"
  | "legacy-note"
  | "unsupported";

export interface LegacyClassification {
  category: MigrationCategory;
  kind: string;
  month: string;
  reason: string;
  status: string;
  type: string;
}

function hasDayHeading(content: string): boolean {
  for (const line of splitTextLines(content)) {
    if (DAY_HEADING_PATTERN.test(line.text)) {
      return true;
    }
  }
  return false;
}

function isMonthlyMemoFile(
  fields: Record<string, string>,
  content: string
): boolean {
  const type = trimmed(fields.type).toLowerCase();
  if (MONTHLY_TYPES.has(type)) {
    return true;
  }
  if (type !== "") {
    return false;
  }
  return MONTH_PATTERN.test(trimmed(fields.month)) && hasDayHeading(content);
}

/**
 * 文書を「旧形式のノート / 月次メモ / 既に新形式 / 対象外」に分類する。
 * 書込みは行わない。
 */
export function classifyLegacyDocument(content: string): LegacyClassification {
  const scan = scanFrontmatter(content);
  const type = trimmed(scan.fields.type);
  const status = trimmed(scan.fields.status);
  const rawMonth = trimmed(scan.fields.month);
  const month = MONTH_PATTERN.test(rawMonth) ? rawMonth : "";
  const base = { kind: "", month, reason: "", status, type };

  if (!scan.present) {
    return {
      ...base,
      category: "unsupported",
      reason: "frontmatter がないため旧Seitonのデータとして扱いません。",
    };
  }
  if (!scan.closed) {
    return {
      ...base,
      category: "unsupported",
      reason: "frontmatter の終端（---）がないため変換しません。",
    };
  }
  if (trimmed(scan.fields.kind) !== "") {
    return { ...base, category: "already-new" };
  }
  if (isMonthlyMemoFile(scan.fields, content)) {
    const mapping = mapLegacyProperties(scan.fields);
    return { ...base, category: "legacy-memo", kind: mapping.kind };
  }
  const hasLegacyKey = LEGACY_PROPERTY_KEYS.some(
    (key) => trimmed(scan.fields[key]) !== ""
  );
  if (hasLegacyKey) {
    const mapping = mapLegacyProperties(scan.fields);
    return { ...base, category: "legacy-note", kind: mapping.kind };
  }
  return {
    ...base,
    category: "unsupported",
    reason: "旧Seitonのプロパティが見つかりません。",
  };
}

export interface FrontmatterBlocks {
  /** キーごとの元のYAML行（キー行 + インデント継続行） */
  blocks: Map<string, string[]>;
  closed: boolean;
  duplicateKeys: string[];
  /** どのキーにも属さない行（コメント等）。失わないため末尾へ回す */
  extras: string[];
  fields: Record<string, string>;
  present: boolean;
}

/** frontmatter をキー単位の生ブロックへ分ける。値の再生成はしない。 */
export function splitFrontmatterBlocks(content: string): FrontmatterBlocks {
  const scan = scanFrontmatter(content);
  const lines = splitTextLines(content);
  const blocks = new Map<string, string[]>();
  const extras: string[] = [];
  if (!(scan.present && scan.closed)) {
    return {
      blocks,
      closed: scan.closed,
      duplicateKeys: scan.duplicateKeys,
      extras,
      fields: scan.fields,
      present: scan.present,
    };
  }

  const closeIndex = (scan.closeLineNumber ?? 1) - 1;
  let currentKey = "";
  for (let index = 1; index < closeIndex; index += 1) {
    const text = lines[index]?.text ?? "";
    const keyMatch = YAML_KEY_PATTERN.exec(text);
    if (keyMatch?.[1]) {
      currentKey = keyMatch[1];
      blocks.set(currentKey, [text]);
      continue;
    }
    if (text.startsWith(" ") || text.startsWith("\t")) {
      const block = blocks.get(currentKey);
      if (block) {
        block.push(text);
      } else {
        extras.push(text);
      }
      continue;
    }
    extras.push(text);
  }

  return {
    blocks,
    closed: scan.closed,
    duplicateKeys: scan.duplicateKeys,
    extras,
    fields: scan.fields,
    present: scan.present,
  };
}

export interface NoteConversionPlan {
  archived: boolean;
  book: Record<string, string>;
  /** 新規ノートの全文（書込みはしない） */
  document: string;
  /** 検証用のISBN（先頭の 0 を保持した文字列） */
  isbn: string[];
  kind: string;
  preservedKeys: string[];
  /** 明示選択または旧ファイルの指定で review: true を付ける */
  review: boolean;
  warnings: string[];
}

export interface NoteConversionFailure {
  ok: false;
  reason: string;
}

export interface NoteConversionSuccess {
  ok: true;
  plan: NoteConversionPlan;
}

export type NoteConversionResult =
  | NoteConversionFailure
  | NoteConversionSuccess;

const CONSUMED_KEYS: ReadonlySet<string> = new Set([
  ...LEGACY_PROPERTY_KEYS,
  "archived",
  "created",
  "pinned",
  "review",
]);

function yamlScalar(key: string, value: string): string {
  if (key === "kind" && SIMPLE_TOKEN_PATTERN.test(value)) {
    return value;
  }
  return yamlQuoted(value);
}

interface NoteDocumentInput {
  body: string;
  eol: string;
  extras: string[];
  fields: [string, string][];
  preserved: string[];
}

function buildNoteDocument(input: NoteDocumentInput): string {
  const lines = ["---"];
  for (const [key, value] of input.fields) {
    if (value !== "") {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(...input.preserved);
  lines.push(...input.extras);
  lines.push("---");
  const frontmatter = `${lines.join(input.eol)}${input.eol}`;
  const body = input.body;
  if (body === "") {
    return frontmatter;
  }
  const bodyWithEol =
    body.endsWith("\n") || body.endsWith("\r") ? body : `${body}${input.eol}`;
  return `${frontmatter}${input.eol}${bodyWithEol}`;
}

export interface NoteConversionInput {
  content: string;
  /** 変換日時（ISO 8601）。created がない旧ノートにだけ使う */
  convertedAt: string;
  eol?: string;
  /** 明示選択した場合だけ true。inbox からは自動で作らない */
  review?: boolean;
  sourceHash?: string;
  sourcePath: string;
}

/**
 * 旧形式の通常ノートを、新形式のコピーへ変換する計画を作る。
 * 元の本文は変更せず、未知のfrontmatterキーはそのまま保持する。
 */
export function planLegacyNoteConversion(
  input: NoteConversionInput
): NoteConversionResult {
  const scan = scanFrontmatter(input.content);
  if (!scan.present) {
    return {
      ok: false,
      reason: "frontmatter がないため旧Seitonのノートとして変換できません。",
    };
  }
  if (!scan.closed) {
    return {
      ok: false,
      reason: "frontmatter の終端（---）がないため変換しません。",
    };
  }
  if (scan.duplicateKeys.length > 0) {
    return {
      ok: false,
      reason: `frontmatter のキーが重複しています（${scan.duplicateKeys.join(
        ", "
      )}）。`,
    };
  }

  const blocks = splitFrontmatterBlocks(input.content);
  const mapping = mapLegacyProperties(scan.fields);
  const eol = input.eol ?? detectEol(input.content);
  const hash = input.sourceHash ?? contentHash(input.content);
  const warnings = [...mapping.warnings, ...mapping.reviewReasons];

  const created = trimmed(scan.fields.created);
  const fields: [string, string][] = [
    ["created", yamlQuoted(created === "" ? input.convertedAt : created)],
    ["kind", yamlScalar("kind", mapping.kind)],
  ];
  if (mapping.flags.archived) {
    fields.push(["archived", "true"]);
  }
  if (mapping.flags.pinned) {
    fields.push(["pinned", "true"]);
  }
  const review = input.review === true || mapping.flags.review;
  if (review) {
    // 旧 inbox からは自動で作らない。明示選択か、旧ファイルの指定だけ残す。
    fields.push(["review", "true"]);
  }
  for (const [key, value] of Object.entries(mapping.book)) {
    fields.push([key, yamlQuoted(value)]);
  }
  fields.push([MIGRATION_SOURCE_KEY, yamlQuoted(input.sourcePath)]);
  fields.push([MIGRATION_HASH_KEY, yamlQuoted(hash)]);

  if (trimmed(scan.fields.month) !== "") {
    warnings.push(
      "month プロパティは月次メモ用の旧キーのため、コピーしません（元ファイルには残ります）。"
    );
  }

  const preserved: string[] = [];
  const preservedKeys: string[] = [];
  for (const [key, blockLines] of blocks.blocks) {
    if (CONSUMED_KEYS.has(key)) {
      continue;
    }
    preserved.push(...blockLines);
    preservedKeys.push(key);
  }

  const document = buildNoteDocument({
    body: bodyAfterFrontmatter(input.content),
    eol,
    extras: blocks.extras,
    fields,
    preserved,
  });

  return {
    ok: true,
    plan: {
      archived: mapping.flags.archived,
      book: mapping.book,
      document,
      isbn: isbnsOf(mapping),
      kind: mapping.kind,
      preservedKeys,
      review,
      warnings,
    },
  };
}

export type LegacyMemoDiagnosticCode =
  | "duplicate-entry"
  | "empty-body"
  | "entry-before-date"
  | "frontmatter-missing"
  | "frontmatter-unclosed"
  | "invalid-date"
  | "invalid-time"
  | "month-mismatch"
  | "unparsed-line";

export interface LegacyMemoDiagnostic {
  code: LegacyMemoDiagnosticCode;
  line: number;
  message: string;
  severity: "error" | "warning";
}

export interface LegacyMemoEntry {
  /** ローカル時刻 + オフセット */
  at: string;
  /** 行内タグを含む本文（複数行は改行で連結） */
  body: string;
  id: string;
  /** 元ファイルでの1始まり行番号 */
  line: number;
  week: string;
}

export interface LegacyMemoParse {
  diagnostics: LegacyMemoDiagnostic[];
  entries: LegacyMemoEntry[];
  eol: string;
  month: string;
  weeks: string[];
}

export interface LegacyMemoParseOptions {
  createEntryId?: (input: MigrationEntryIdInput) => string;
  /** 旧データの記録タイムゾーン。既定は実行環境のローカル */
  offset?: string;
  sourcePath: string;
}

interface WorkingEntry {
  body: string;
  date: string;
  hour: number;
  line: number;
  minute: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function localOffsetAt(date: Date): string {
  return formatLocalIso(date).slice(19);
}

function memoDiagnostic(
  code: LegacyMemoDiagnosticCode,
  severity: "error" | "warning",
  line: number,
  message: string
): LegacyMemoDiagnostic {
  return { code, line, message, severity };
}

function dateParts(dateKey: string): [number, number, number] {
  return [
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(5, 7)),
    Number(dateKey.slice(8, 10)),
  ];
}

/**
 * 旧月次メモ（`## YYYY-MM-DD` と `- HH:MM 内容 #タグ`）を、ISO週ごとの
 * 新形式エントリへ変換するデータを作る。行内タグは本文に残す。
 *
 * 解釈できない行は捨てずに診断として報告する。元ファイルは変更しない。
 */
export function parseLegacyMonthlyMemo(
  content: string,
  options: LegacyMemoParseOptions
): LegacyMemoParse {
  const eol = detectEol(content);
  const scan = scanFrontmatter(content);
  const rawMonth = trimmed(scan.fields.month);
  const month = MONTH_PATTERN.test(rawMonth) ? rawMonth : "";
  const diagnostics: LegacyMemoDiagnostic[] = [];
  const working: WorkingEntry[] = [];

  if (!scan.present) {
    diagnostics.push(
      memoDiagnostic(
        "frontmatter-missing",
        "error",
        1,
        "frontmatter がないため月次メモとして変換できません。"
      )
    );
    return { diagnostics, entries: [], eol, month, weeks: [] };
  }
  if (!scan.closed) {
    diagnostics.push(
      memoDiagnostic(
        "frontmatter-unclosed",
        "error",
        1,
        "frontmatter の終端（---）がないため変換しません。"
      )
    );
    return { diagnostics, entries: [], eol, month, weeks: [] };
  }
  if (options.offset !== undefined && !OFFSET_PATTERN.test(options.offset)) {
    throw new RangeError(
      `タイムゾーンオフセット「${options.offset}」が不正です。`
    );
  }

  const lines = splitTextLines(content);
  let currentDate = "";
  let open: WorkingEntry | null = null;

  for (let index = scan.bodyStartLine; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const text = line.text;
    if (text.trim() === "") {
      open = null;
      continue;
    }

    const heading = DAY_HEADING_PATTERN.exec(text);
    if (heading?.[1]) {
      const date = heading[1];
      if (isValidDateKey(date)) {
        currentDate = date;
        open = null;
        if (month !== "" && date.slice(0, 7) !== month) {
          diagnostics.push(
            memoDiagnostic(
              "month-mismatch",
              "warning",
              line.number,
              `日付 ${date} は month（${month}）と一致しません。`
            )
          );
        }
      } else {
        currentDate = "";
        open = null;
        diagnostics.push(
          memoDiagnostic(
            "invalid-date",
            "error",
            line.number,
            `日付見出し「${date}」が実在しない日付です。`
          )
        );
      }
      continue;
    }

    if (ANY_HEADING_PATTERN.test(text)) {
      // 日付以外の見出しは構造として扱わない（本文へ混ぜない）。
      open = null;
      continue;
    }

    const memoLine = LEGACY_MEMO_LINE_PATTERN.exec(text);
    if (memoLine) {
      const hour = Number(memoLine[1]);
      const minute = Number(memoLine[2]);
      const body = (memoLine[3] ?? "").trimEnd();
      if (currentDate === "") {
        diagnostics.push(
          memoDiagnostic(
            "entry-before-date",
            "error",
            line.number,
            "日付見出し（## YYYY-MM-DD）より前のメモ行は変換できません。"
          )
        );
        open = null;
        continue;
      }
      if (hour > 23 || minute > 59) {
        diagnostics.push(
          memoDiagnostic(
            "invalid-time",
            "error",
            line.number,
            `時刻「${pad2(hour)}:${pad2(minute)}」が不正です。`
          )
        );
        open = null;
        continue;
      }
      const entry: WorkingEntry = {
        body,
        date: currentDate,
        hour,
        line: line.number,
        minute,
      };
      working.push(entry);
      open = entry;
      continue;
    }

    if (open) {
      // 箇条書きの継続行などは直前のメモ本文へ含める。
      open.body =
        open.body === "" ? text.trim() : `${open.body}\n${text.trim()}`;
      continue;
    }

    diagnostics.push(
      memoDiagnostic(
        "unparsed-line",
        "warning",
        line.number,
        "メモ行として解釈できない行のため変換しません（元ファイルには残ります）。"
      )
    );
  }

  working.sort((left, right) => {
    if (left.date !== right.date) {
      return left.date.localeCompare(right.date);
    }
    const leftMinutes = left.hour * 60 + left.minute;
    const rightMinutes = right.hour * 60 + right.minute;
    if (leftMinutes !== rightMinutes) {
      return leftMinutes - rightMinutes;
    }
    return left.line - right.line;
  });

  const entries: LegacyMemoEntry[] = [];
  const weeks = new Set<string>();
  const createId = options.createEntryId ?? migrationEntryId;

  for (const entry of working) {
    const body = entry.body.trim();
    if (body === "") {
      diagnostics.push(
        memoDiagnostic(
          "empty-body",
          "warning",
          entry.line,
          "本文が空のメモ行は変換しません。"
        )
      );
      continue;
    }
    const [year, monthNumber, day] = dateParts(entry.date);
    const date = new Date(year, monthNumber - 1, day, entry.hour, entry.minute);
    const offset = options.offset ?? localOffsetAt(date);
    const at = `${entry.date}T${pad2(entry.hour)}:${pad2(entry.minute)}:00${offset}`;
    const week = weekIdOf(date);
    entries.push({
      at,
      body,
      id: createId({
        at,
        body,
        line: entry.line,
        sourcePath: options.sourcePath,
      }),
      line: entry.line,
      week,
    });
    weeks.add(week);
  }

  const seen = new Map<string, LegacyMemoEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.id);
    if (existing) {
      diagnostics.push(
        memoDiagnostic(
          "duplicate-entry",
          "error",
          entry.line,
          `同じID（${entry.id}）のメモが ${existing.line} 行目にもあります。`
        )
      );
      continue;
    }
    seen.set(entry.id, entry);
  }

  diagnostics.sort((left, right) => {
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.code.localeCompare(right.code);
  });

  return {
    diagnostics,
    entries,
    eol,
    month,
    weeks: [...weeks].sort(),
  };
}

export interface NoteTargetPathOptions {
  basename: string;
  exists: (path: string) => boolean;
  notesFolder: string;
  sourcePath: string;
}

/**
 * 移行先ノートのパスを決める。既存ファイルとは衝突しない別名を使う。
 * 同じ元パスからは常に同じ別名になる（再スキャンで揺れない）。
 */
export function resolveNoteTargetPath(
  options: NoteTargetPathOptions
): string | null {
  const folder = options.notesFolder.replace(/\/+$/u, "");
  const name = sanitizeNoteTitle(options.basename);
  const base = `${folder}/${name}.md`;
  if (!options.exists(base)) {
    return base;
  }

  const suffix = stableHash(options.sourcePath).slice(0, 8);
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const candidateName =
      attempt === 1 ? `${name}-${suffix}` : `${name}-${suffix}-${attempt}`;
    const candidate = `${folder}/${candidateName}.md`;
    if (!options.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 本文の比較用正規化。改行コードと前後の空行だけを吸収する。 */
export function normalizedBodyForCompare(value: string): string {
  return normalizeNewlines(value)
    .replace(/^(?:\n)+/u, "")
    .replace(/\s+$/u, "");
}

export type MigrationResultStatus = "converted" | "failed" | "skipped";

export interface MigrationLogRecord {
  convertedAt: string;
  entryCount: number;
  isbn: string[];
  message: string;
  result: MigrationResultStatus;
  sourceHash: string;
  sourcePath: string;
  targetPaths: string[];
}

export interface MigrationLogFormatOptions {
  eol?: string;
  /** 新規ログの created に使う日時 */
  headerAt?: string;
}

const RESULT_LABELS: Record<MigrationResultStatus, string> = {
  converted: "変換済み",
  failed: "失敗",
  skipped: "スキップ",
};

function singleLine(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, " / ").trim();
}

function codeList(values: string[]): string {
  if (values.length === 0) {
    return "（なし）";
  }
  return values.map((value) => `\`${singleLine(value)}\``).join(", ");
}

/** 変換ログの1件分。元パス・新パス・元ハッシュ・変換日時・結果を必ず含む。 */
export function formatMigrationLogRecord(
  record: MigrationLogRecord,
  eol = "\n"
): string {
  const lines = [
    `### \`${singleLine(record.sourcePath)}\``,
    "",
    `- 元: \`${singleLine(record.sourcePath)}\``,
    `- 新: ${codeList(record.targetPaths)}`,
    `- 元ハッシュ: \`${record.sourceHash}\``,
    `- 変換日時: \`${record.convertedAt}\``,
    `- 結果: ${record.result}（${RESULT_LABELS[record.result]}）`,
    `- 件数: ${record.entryCount}`,
    `- ISBN: ${codeList(record.isbn)}`,
  ];
  if (record.message !== "") {
    lines.push(`- 備考: ${singleLine(record.message)}`);
  }
  lines.push("");
  return lines.join(eol);
}

/** 変換ログの新規文書。追記専用で、既存の記録を書き換えない。 */
export function createMigrationLogDocument(
  createdAt: string,
  eol = "\n"
): string {
  const lines = [
    "---",
    `created: ${yamlQuoted(createdAt)}`,
    `kind: ${MIGRATION_LOG_KIND}`,
    "---",
    "",
    "# 旧Seitonからの移行ログ",
    "",
    "- 変換はコピーのみです。元ファイルの削除・移動は行いません。",
    "- 巻き戻す場合は「新」のファイルを削除し、元ファイルを確認してください。",
    "- 同じ元ファイルは、このログに記録がある限り既定で再変換しません。",
    "",
  ];
  return lines.join(eol);
}

/** 既存ログの末尾へ記録を追記する。既存の文字列は変更しない。 */
export function appendMigrationLogRecords(
  existing: string,
  records: MigrationLogRecord[],
  options: MigrationLogFormatOptions = {}
): string {
  if (records.length === 0) {
    return existing;
  }
  const eol = options.eol ?? (existing === "" ? "\n" : detectEol(existing));
  const first = records[0];
  const headerAt = options.headerAt ?? first?.convertedAt ?? "";
  let output =
    existing === "" ? createMigrationLogDocument(headerAt, eol) : existing;
  if (!(output.endsWith("\n") || output.endsWith("\r"))) {
    output += eol;
  }
  if (!output.endsWith(`${eol}${eol}`)) {
    output += eol;
  }
  for (const record of records) {
    output += `${formatMigrationLogRecord(record, eol)}${eol}`;
  }
  return output;
}

function quotedValues(value: string): string[] {
  const values: string[] = [];
  QUOTED_VALUE_PATTERN.lastIndex = 0;
  let match = QUOTED_VALUE_PATTERN.exec(value);
  while (match) {
    if (match[1] !== undefined) {
      values.push(match[1]);
    }
    match = QUOTED_VALUE_PATTERN.exec(value);
  }
  return values;
}

function resultStatusOf(value: string): MigrationResultStatus | null {
  const match = LOG_RESULT_PATTERN.exec(value);
  const code = match?.[1];
  if (code === "converted" || code === "skipped" || code === "failed") {
    return code;
  }
  return null;
}

interface LogRecordBuilder {
  convertedAt: string;
  entryCount: number;
  isbn: string[];
  message: string;
  result: string;
  sourceHash: string;
  sourcePath: string;
  targetPaths: string[];
}

function emptyLogBuilder(): LogRecordBuilder {
  return {
    convertedAt: "",
    entryCount: 0,
    isbn: [],
    message: "",
    result: "",
    sourceHash: "",
    sourcePath: "",
    targetPaths: [],
  };
}

function applyLogField(
  builder: LogRecordBuilder,
  label: string,
  value: string
): void {
  if (label === "元") {
    builder.sourcePath = quotedValues(value)[0] ?? value.trim();
    return;
  }
  if (label === "新") {
    builder.targetPaths = quotedValues(value);
    return;
  }
  if (label === "元ハッシュ") {
    builder.sourceHash = quotedValues(value)[0] ?? "";
    return;
  }
  if (label === "変換日時") {
    builder.convertedAt = quotedValues(value)[0] ?? "";
    return;
  }
  if (label === "結果") {
    builder.result = resultStatusOf(value) ?? "";
    return;
  }
  if (label === "件数") {
    const parsed = Number.parseInt(value.trim(), 10);
    builder.entryCount = Number.isNaN(parsed) ? 0 : parsed;
    return;
  }
  if (label === "ISBN") {
    builder.isbn = quotedValues(value);
    return;
  }
  if (label === "備考") {
    builder.message = value.trim();
  }
}

/** 変換ログを読み、記録済みの変換を取り出す。壊れた記録は読み飛ばす。 */
export function parseMigrationLog(content: string): MigrationLogRecord[] {
  const records: MigrationLogRecord[] = [];
  let builder: LogRecordBuilder | null = null;

  const flush = (): void => {
    if (!builder) {
      return;
    }
    const result = resultStatusOf(builder.result);
    if (builder.sourcePath !== "" && result) {
      records.push({
        convertedAt: builder.convertedAt,
        entryCount: builder.entryCount,
        isbn: builder.isbn,
        message: builder.message,
        result,
        sourceHash: builder.sourceHash,
        sourcePath: builder.sourcePath,
        targetPaths: builder.targetPaths,
      });
    }
    builder = null;
  };

  for (const line of splitTextLines(content)) {
    if (line.text.startsWith("### ")) {
      flush();
      builder = emptyLogBuilder();
      continue;
    }
    if (!builder) {
      continue;
    }
    const field = LOG_FIELD_PATTERN.exec(line.text);
    if (field?.[1]) {
      applyLogField(builder, field[1], field[2] ?? "");
    }
  }
  flush();

  return records;
}

/**
 * 同じ元パスの「変換済み」記録を新しい順に探す。
 * 失敗・スキップの記録は二重取り込み防止の根拠にしない。
 */
export function findConvertedMigrationRecord(
  records: MigrationLogRecord[],
  sourcePath: string
): MigrationLogRecord | null {
  let found: MigrationLogRecord | null = null;
  for (const record of records) {
    if (record.sourcePath !== sourcePath || record.result !== "converted") {
      continue;
    }
    found = record;
  }
  return found;
}
