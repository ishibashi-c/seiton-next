/** Obsidian内部リンクの文字列操作。Obsidian APIに依存しない。 */

/** `[[Project]]` 形式のリンクを作る。 */
export function wikiLink(target: string): string {
  const clean = target.replace(/\.md$/u, "").replace(/^\[\[|\]\]$/gu, "");
  return `[[${clean}]]`;
}

/** リンク文字列から比較用の名前を取り出す。 */
export function normalizeLink(value: string): string {
  return (
    value
      .replace(/^\[\[|\]\]$/gu, "")
      .split("|")[0]
      ?.replace(/\.md$/u, "")
      .trim()
      .toLowerCase() ?? ""
  );
}

/** 表示用に、リンクの括弧・別名・拡張子だけを外す（大文字小文字は保つ）。 */
export function displayLink(value: string): string {
  return (
    value
      .replace(/^\[\[|\]\]$/gu, "")
      .split("|")[0]
      ?.replace(/\.md$/u, "")
      .trim() ?? ""
  );
}
