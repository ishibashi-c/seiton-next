export type QueryStatus = "archived" | "pinned" | "review";

export interface ParsedQuery {
  kinds: string[];
  list: string | null;
  project: string | null;
  status: QueryStatus | null;
  tags: string[];
  text: string;
}

const EMPTY: ParsedQuery = {
  kinds: [],
  list: null,
  project: null,
  status: null,
  tags: [],
  text: "",
};

function unquote(value: string): string {
  return value.replace(/^"|"$/gu, "").trim();
}

/**
 * 検索窓のクエリ文法。
 * `kind:book tag:積読 project:"新Seiton" list:あとで is:review` と全文語を混在できる。
 * 否定（-）と保存ビューは未対応。
 */
export function parseQuery(input: string): ParsedQuery {
  const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/gu) ?? [];
  const result: ParsedQuery = { ...EMPTY, kinds: [], tags: [] };
  const text: string[] = [];

  for (const raw of tokens) {
    if (raw.startsWith("-")) {
      continue;
    }
    const token = unquote(raw);
    const separator = token.indexOf(":");
    if (separator > 0) {
      const key = token.slice(0, separator).toLowerCase();
      const value = unquote(token.slice(separator + 1));
      if (value === "") {
        continue;
      }
      if (key === "kind") {
        result.kinds.push(
          ...value
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
        );
        continue;
      }
      if (key === "tag") {
        result.tags.push(value.replace(/^#/u, ""));
        continue;
      }
      if (key === "project") {
        result.project = value;
        continue;
      }
      if (key === "list") {
        result.list = value;
        continue;
      }
      if (key === "is") {
        const status = value.toLowerCase();
        if (
          status === "archived" ||
          status === "pinned" ||
          status === "review"
        ) {
          result.status = status;
        }
        continue;
      }
    }
    if (token.startsWith("#") && token.length > 1) {
      result.tags.push(token.slice(1));
      continue;
    }
    text.push(token);
  }

  result.text = text.join(" ").trim();
  return result;
}
