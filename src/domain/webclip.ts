/** WebクリップのHTMLメタデータ抽出。DOMParserに依存しない。 */

import { domainOf, isAllowedRemoteUrl, normalizeSourceUrl } from "./network";

export interface WebClipMetadata {
  description: string;
  domain: string;
  imageUrl: string;
  source: string;
  title: string;
}

export interface WebClipCardModel extends WebClipMetadata {
  path?: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#(\d+);/gu, (_match, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    );
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function attributeMap(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern =
    /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;
  let match = pattern.exec(raw);
  while (match) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key) {
      attributes[key] = decodeEntities(value);
    }
    match = pattern.exec(raw);
  }
  return attributes;
}

function metaValue(html: string): Map<string, string> {
  const values = new Map<string, string>();
  const pattern = /<meta\b[^>]*>/giu;
  let match = pattern.exec(html);
  while (match) {
    const attributes = attributeMap(match[0]);
    const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
    const content = attributes.content ?? "";
    if (key !== "" && content !== "" && !values.has(key)) {
      values.set(key, content);
    }
    match = pattern.exec(html);
  }
  return values;
}

function firstTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return match?.[1] ? stripTags(match[1]) : "";
}

export function resolveUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

/** HTMLからタイトル・概要・OG画像を取り出す。失敗しても空文字で返す。 */
export function parseHtmlMetadata(
  html: string,
  source: string
): WebClipMetadata {
  const meta = metaValue(html);
  const title =
    meta.get("og:title") ||
    meta.get("twitter:title") ||
    firstTitle(html) ||
    domainOf(source);
  const description =
    meta.get("og:description") ||
    meta.get("twitter:description") ||
    meta.get("description") ||
    "";
  const rawImage =
    meta.get("og:image") ||
    meta.get("og:image:url") ||
    meta.get("twitter:image") ||
    "";
  const imageUrl = rawImage ? resolveUrl(rawImage, source) : "";

  return {
    description: stripTags(description),
    domain: domainOf(source),
    imageUrl: isAllowedRemoteUrl(imageUrl) ? imageUrl : "",
    source: normalizeSourceUrl(source) ?? source,
    title: stripTags(title),
  };
}

/** ドメインをObsidianタグとして有効な形（例: zenn.dev → zenn）にする。 */
export function domainTagOf(source: string): string {
  const host = domainOf(normalizeSourceUrl(source) ?? source);
  const base = host.replace(/^www\./u, "").split(".")[0] ?? "";
  const tag = base
    .replace(/[^\p{L}\p{N}_-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return tag === "" ? "web" : tag;
}

/** Defuddleが改行で壊したリンクを、通常のMarkdownリンクへ戻す。 */
export function tidyMarkdownLinks(markdown: string): string {
  let result = markdown.replace(
    /\[(!\[[^\]]*\]\([^)]*\))\s*\n+([\s\S]*?)\n+\s*\]\((https?:\/\/[^)]+)\)/gu,
    (_match, image: string, text: string, url: string) =>
      `[${image} ${text.replace(/\s+/gu, " ").trim()}](${url})`
  );
  result = result.replace(
    /\[\s*\n+([\s\S]*?)\n+\s*\]\((https?:\/\/[^)\s]+)\)/gu,
    (_match, text: string, url: string) =>
      `[${text.replace(/\s+/gu, " ").trim()}](${url})`
  );
  result = result.replace(/\]\((https?:\/\/[^)\s]+)\)\[/gu, "]($1)\n\n[");
  return result;
}

/** sourceの重複判定キー。クエリとハッシュを落としたURL。 */
export function webClipDuplicateKey(source: string): string {
  try {
    const url = new URL(source);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/u, "").toLowerCase();
  } catch {
    return source.trim().toLowerCase();
  }
}

/** カード表示用のフォールバック。 */
export function webClipCardFromProperties(
  source: string,
  title: string,
  description: string,
  image: string
): WebClipCardModel {
  const normalized = normalizeSourceUrl(source) ?? source;
  return {
    description,
    domain: domainOf(normalized),
    imageUrl: image,
    source: normalized,
    title: title || domainOf(normalized) || "Webクリップ",
  };
}

export interface SharedWebText {
  note: string;
  title: string;
  url: string;
}

/** 共有シートの「タイトル＋URL」からURLとタイトルを取り出す。 */
export function parseSharedWebText(text: string): SharedWebText {
  const match = /https?:\/\/[^\s<>"']+/u.exec(text);
  if (!match) {
    return { note: "", title: "", url: "" };
  }
  const url = match[0].replace(/[.,;、。]+$/u, "");
  const index = match.index ?? 0;
  const before = text.slice(0, index).trim();
  const after = text.slice(index + match[0].length).trim();
  const title = (before || "")
    .replace(/^[-–—\s]+/u, "")
    .replace(/[-–—\s]+$/u, "")
    .slice(0, 200);
  return {
    note: after.slice(0, 1500),
    title,
    url,
  };
}

/** PC用ブックマークレット。ObsidianのURIで取り込みモーダルを開く。 */
export const WEB_CLIP_BOOKMARKLET =
  'javascript:(()=>{const e=encodeURIComponent;const url=location.href;const title=document.title||"";const selection=window.getSelection?String(window.getSelection()).trim():"";let target="obsidian://seiton-next?action=webclip&capture=bookmarklet&url="+e(url)+"&title="+e(title);if(selection)target+="&note="+e(selection.slice(0,1500));location.href=target;})();';
