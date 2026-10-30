/**
 * frontmatter の読み取り専用スキャン。
 * 重要データを書き換えないため、既存ファイルの frontmatter は再生成しない。
 * 新規ファイル作成時だけ buildFrontmatter を使う。
 */

import { splitTextLines, stripBom } from "./text";

export interface FrontmatterScan {
  /** 終端行の次（0始まり） */
  bodyStartLine: number;
  /** 本文開始オフセット（終端行の改行直後） */
  bodyStartOffset: number;
  /** 終端の `---` または `...` があるか */
  closed: boolean;
  /** 終端行の1始まり行番号。閉じていなければ null */
  closeLineNumber: number | null;
  /** kind/week など、重複すると意味が曖昧になるキー */
  duplicateKeys: string[];
  /** トップレベルの単純なスカラー値だけを読む */
  fields: Record<string, string>;
  /** 先頭が `---` で始まるか */
  present: boolean;
}

const DELIMITER_PATTERN = /^(?:---|\.\.\.)[ \t]*$/u;
const FIELD_PATTERN = /^([A-Za-z0-9_-]+):(.*)$/u;

function unquoteDouble(raw: string): string | null {
  const match = /^"((?:[^"\\]|\\.)*)"/u.exec(raw);
  if (!match) {
    return null;
  }
  const body = match[1] ?? "";
  return body
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, "\\")
    .replace(/\\n/gu, "\n");
}

function unquoteSingle(raw: string): string | null {
  const match = /^'((?:[^']|'')*)'/u.exec(raw);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").replace(/''/gu, "'");
}

/** YAML の単純なスカラーだけを読み取る。複合値は空文字として扱う。 */
function parseScalar(rawValue: string): string {
  const raw = rawValue.trim();
  if (raw === "") {
    return "";
  }
  if (raw.startsWith("|") || raw.startsWith(">")) {
    return "";
  }
  if (raw.startsWith('"')) {
    return unquoteDouble(raw) ?? "";
  }
  if (raw.startsWith("'")) {
    return unquoteSingle(raw) ?? "";
  }

  // 引用符なしの行末コメントを落とす（`memo-log # note`）。
  return raw.replace(/[ \t]+#.*$/u, "").trim();
}

export function scanFrontmatter(content: string): FrontmatterScan {
  const empty: FrontmatterScan = {
    bodyStartLine: 0,
    bodyStartOffset: 0,
    closed: false,
    closeLineNumber: null,
    duplicateKeys: [],
    fields: {},
    present: false,
  };

  const lines = splitTextLines(content);
  const first = lines[0];
  if (!first || stripBom(first.text).trim() !== "---") {
    return empty;
  }

  let closeIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (DELIMITER_PATTERN.test(lines[index]?.text ?? "")) {
      closeIndex = index;
      break;
    }
  }

  if (closeIndex < 0) {
    return {
      ...empty,
      bodyStartLine: lines.length,
      bodyStartOffset: content.length,
      present: true,
    };
  }

  const fields: Record<string, string> = {};
  const duplicateKeys: string[] = [];

  for (let index = 1; index < closeIndex; index += 1) {
    const text = lines[index]?.text ?? "";
    if (text.startsWith(" ") || text.startsWith("\t") || text.trim() === "") {
      continue;
    }
    const match = FIELD_PATTERN.exec(text);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!key) {
      continue;
    }
    if (Object.hasOwn(fields, key)) {
      duplicateKeys.push(key);
      continue;
    }
    fields[key] = parseScalar(match[2] ?? "");
  }

  const closeLine = lines[closeIndex];

  return {
    bodyStartLine: closeIndex + 1,
    bodyStartOffset: closeLine?.end ?? content.length,
    closed: true,
    closeLineNumber: closeLine?.number ?? null,
    duplicateKeys,
    fields,
    present: true,
  };
}

/** frontmatter の 1 キーだけを読む。 */
export function frontmatterField(content: string, key: string): string | null {
  const scan = scanFrontmatter(content);
  return Object.hasOwn(scan.fields, key) ? (scan.fields[key] ?? null) : null;
}

/** frontmatter 終端より後ろの本文。先頭の空行1つを除く。 */
export function bodyAfterFrontmatter(content: string): string {
  const scan = scanFrontmatter(content);
  if (!(scan.present && scan.closed)) {
    return content;
  }
  return content.slice(scan.bodyStartOffset).replace(/^(?:\r\n|\n|\r)/u, "");
}

/** 新規ファイル用の YAML 文字列（ダブルクォート）。 */
export function yamlQuoted(value: string): string {
  const escaped = value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\r\n|\r|\n/gu, "\\n");
  return `"${escaped}"`;
}

/** 新規ファイル用の frontmatter ブロック。 */
export function buildFrontmatter(
  fields: Record<string, string>,
  eol = "\n"
): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return `${lines.join(eol)}${eol}`;
}

/**
 * frontmatter のトップレベルのスカラー1行だけを置き換える。
 * 未知のキーや本文は変更しない。セッション状態のような単純な値にだけ使う。
 */
export function setFrontmatterScalar(
  content: string,
  key: string,
  value: string
): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
    throw new Error(`frontmatterキーが不正です: ${key}`);
  }
  const scan = scanFrontmatter(content);
  if (!(scan.present && scan.closed) || scan.closeLineNumber === null) {
    throw new Error("frontmatterが閉じていないため更新できません");
  }

  const lines = splitTextLines(content);
  const closeIndex = scan.closeLineNumber - 1;
  let duplicate = false;
  let target: { start: number; textEnd: number } | null = null;

  for (let index = 1; index < closeIndex; index += 1) {
    const text = lines[index]?.text ?? "";
    if (text.startsWith(" ") || text.startsWith("\t")) {
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):(.*)$/u.exec(text);
    if (match?.[1] !== key) {
      continue;
    }
    if (target) {
      duplicate = true;
      continue;
    }
    target = {
      start: lines[index]?.start ?? 0,
      textEnd: lines[index]?.textEnd ?? 0,
    };
  }

  if (duplicate) {
    throw new Error(`frontmatterの${key}が重複しています`);
  }

  if (target) {
    return [
      content.slice(0, target.start),
      `${key}: ${value}`,
      content.slice(target.textEnd),
    ].join("");
  }

  const closeLine = lines[closeIndex];
  const eol = closeLine?.eol || "\n";
  const insertAt = closeLine?.start ?? content.length;
  return [
    content.slice(0, insertAt),
    `${key}: ${value}${eol}`,
    content.slice(insertAt),
  ].join("");
}

/**
 * frontmatter のリスト（`key:` の次の `  - value`）を読む。
 * プロンプトセッションの projects のような単純なリンクリストに使う。
 */
export function frontmatterList(content: string, key: string): string[] {
  const scan = scanFrontmatter(content);
  if (!(scan.present && scan.closed) || scan.closeLineNumber === null) {
    return [];
  }
  const lines = splitTextLines(content);
  const closeIndex = scan.closeLineNumber - 1;
  const values: string[] = [];

  for (let index = 1; index < closeIndex; index += 1) {
    const text = lines[index]?.text ?? "";
    if (!text.startsWith(" ") && !text.startsWith("\t")) {
      continue;
    }
    const item = /^\s*-\s+(.*)$/u.exec(text);
    if (!item?.[1]) {
      continue;
    }
    // key 行の直後から始まるリストだけを対象にする。
    let keyIndex = index - 1;
    while (keyIndex > 0) {
      const previous = lines[keyIndex]?.text ?? "";
      if (previous.startsWith(" ") || previous.startsWith("\t")) {
        keyIndex -= 1;
        continue;
      }
      if (previous.startsWith(`${key}:`)) {
        values.push(parseScalar(item[1]));
      }
      break;
    }
  }

  return values;
}
