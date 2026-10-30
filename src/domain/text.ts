/**
 * テキストの行分割・改行コード・HTML属性エスケープ。
 * Obsidian API に依存しない純関数だけを置く。
 */

export interface TextLine {
  /** 改行を含めた次の行の開始オフセット */
  end: number;
  /** この行の改行コード。最終行が改行なしなら空文字 */
  eol: string;
  /** 1始まりの行番号 */
  number: number;
  /** 行頭からのオフセット（行末改行を含まない） */
  start: number;
  /** 改行を除いた行内容 */
  text: string;
  /** 行末（改行を含まない）のオフセット */
  textEnd: number;
}

/**
 * 改行コードを保ったまま行へ分割する。
 * 末尾が改行で終わる場合、最後に空行は追加しない。
 */
export function splitTextLines(content: string): TextLine[] {
  const lines: TextLine[] = [];
  let offset = 0;
  let number = 1;

  while (offset < content.length) {
    const start = offset;
    let index = offset;

    while (
      index < content.length &&
      content[index] !== "\n" &&
      content[index] !== "\r"
    ) {
      index += 1;
    }

    const text = content.slice(start, index);
    const textEnd = index;
    let eol = "";

    if (content[index] === "\r" && content[index + 1] === "\n") {
      eol = "\r\n";
      index += 2;
    } else if (content[index] === "\r") {
      eol = "\r";
      index += 1;
    } else if (content[index] === "\n") {
      eol = "\n";
      index += 1;
    }

    lines.push({
      end: index,
      eol,
      number,
      start,
      text,
      textEnd,
    });
    number += 1;
    offset = index;
  }

  return lines;
}

/** 文書内で最も多い改行コードを返す。空文書は LF。 */
export function detectEol(content: string): string {
  let crlf = 0;
  let lf = 0;
  let cr = 0;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\r") {
      if (content[index + 1] === "\n") {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (character === "\n") {
      lf += 1;
    }
  }

  if (crlf >= lf && crlf >= cr && crlf > 0) {
    return "\r\n";
  }
  if (cr > lf && cr > 0) {
    return "\r";
  }
  return "\n";
}

/** 改行コードを LF に揃える。 */
export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 先頭の BOM を読み飛ばす（オフセットは変えない）。 */
export function stripBom(value: string): string {
  return value.startsWith("\uFEFF") ? value.slice(1) : value;
}

/** HTMLコメント属性値として安全な形へエスケープする。 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, "&#10;");
}

/** escapeHtmlAttribute の逆変換。 */
export function unescapeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

/** 表示用にHTML文字参照を戻す。データ自体は書き換えない。 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/giu,
    (
      match,
      decimal: string | undefined,
      hex: string | undefined,
      name: string | undefined
    ) => {
      if (decimal !== undefined) {
        const code = Number(decimal);
        return Number.isInteger(code) && code >= 0 && code <= 0x10_ff_ff
          ? String.fromCodePoint(code)
          : match;
      }
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return Number.isInteger(code) && code >= 0 && code <= 0x10_ff_ff
          ? String.fromCodePoint(code)
          : match;
      }
      return HTML_ENTITIES[name?.toLowerCase() ?? ""] ?? match;
    }
  );
}
