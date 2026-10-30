/** Obsidian Bases のビュー定義を作る。Basesが使えない環境でもMarkdownは読める。 */

import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import { NOTES_FOLDER, VIEWS_FOLDER } from "../config";

const NOTES_BASE = `filters: 'file.inFolder("${NOTES_FOLDER}")'
views:
  - type: table
    name: Seiton notes
    order:
      - file.name
      - kind
      - tags
      - projects
      - file.mtime
`;

export interface BasesResult {
  created: string[];
  paths: string[];
}

/** Seiton/System/Views にBasesの定義を用意する。既存ファイルは上書きしない。 */
export async function ensureBasesViews(app: App): Promise<BasesResult> {
  await ensureFolder(app, VIEWS_FOLDER);
  const path = normalizePath(`${VIEWS_FOLDER}/Seiton Notes.base`);
  const created: string[] = [];
  if (!app.vault.getAbstractFileByPath(path)) {
    await app.vault.create(path, NOTES_BASE);
    created.push(path);
  }
  return { created, paths: [path] };
}

/** Basesのビューを開く。Markdownの場合は通常のタブで開く。 */
export async function openBasesView(app: App, path: string): Promise<void> {
  await app.workspace.openLinkText(path, "", true);
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const segments = normalizePath(path)
    .split("/")
    .filter((segment) => segment !== "");
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    if (app.vault.getAbstractFileByPath(current)) {
      continue;
    }
    await app.vault.createFolder(current);
  }
}
