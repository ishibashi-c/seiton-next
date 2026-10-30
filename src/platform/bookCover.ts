import type { App } from "obsidian";
import { TFile } from "obsidian";
import { isAllowedRemoteUrl } from "../domain/network";

/** `book_cover` の値（Vaultパス / 外部URL / リンク）を表示可能なURLへ。 */
export function resolveCover(app: App, value: string): string | null {
  if (value === "") {
    return null;
  }
  const link = value
    .replace(/^!?\[\[|\]\]$/gu, "")
    .split("|")[0]
    ?.trim();
  if (!link) {
    return null;
  }
  const file = app.vault.getAbstractFileByPath(link);
  if (file instanceof TFile) {
    return app.vault.getResourcePath(file);
  }
  if (/^https?:\/\//u.test(link) && isAllowedRemoteUrl(link)) {
    return link;
  }
  return null;
}

/** 表紙がない本の仮表紙。書名と補足（著者・状態）を出す。 */
export function renderBookCoverFallback(
  parent: HTMLElement,
  title: string,
  meta = ""
): void {
  const fallback = parent.createDiv({ cls: "seiton-book-cover-fallback" });
  fallback.setAttribute("aria-hidden", "true");
  fallback.createDiv({
    cls: "seiton-book-cover-fallback-title",
    text: title,
  });
  if (meta) {
    fallback.createDiv({
      cls: "seiton-book-cover-fallback-note",
      text: meta,
    });
  }
}
