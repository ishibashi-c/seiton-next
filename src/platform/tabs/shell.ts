/**
 * 各タブの共通シェル。ヘッダー、ナビ、本文、FAB、スクロール復元、入場モーションを
 * 1か所にまとめ、ビュー側は本文の中身だけを作る。
 */

import type { ItemView } from "obsidian";
import {
  addFloatingAction,
  type FloatingActionOptions,
} from "../floatingAction";
import {
  type PageHeaderAction,
  type PageHeaderHandle,
  renderPageHeader,
} from "../pageHeader";
import { renderSeitonNav, type SeitonTopTab } from "../seitonNav";
import { applyTabEnter } from "../tabMotion";
import { restoreTabScroll, saveTabScrollOnClose } from "../tabScroll";

export interface TabShellOptions {
  actions?: PageHeaderAction[];
  fab?: FloatingActionOptions;
  rootClasses?: string[];
  subline?: string;
  tab: SeitonTopTab;
  title: string;
}

export interface TabShellHandle {
  body: HTMLElement;
  header: PageHeaderHandle;
  shell: HTMLElement;
}

export function mountTabShell(
  view: ItemView,
  options: TabShellOptions
): TabShellHandle {
  view.contentEl.empty();
  view.contentEl.addClass(...(options.rootClasses ?? ["seiton-home"]));
  const shell = view.contentEl.createDiv({ cls: "seiton-home-inner" });
  const header = renderPageHeader(shell, {
    actions: options.actions,
    subline: options.subline,
    title: options.title,
  });
  renderSeitonNav(view.app, shell, options.tab, view.leaf);
  const body = shell.createDiv({ cls: "seiton-tab-body" });
  if (options.fab) {
    addFloatingAction(view, options.fab);
  }
  return { body, header, shell };
}

/** 本文の描画後に、スクロール位置と入場モーションを適用する。 */
export function finishTabShell(view: ItemView, type: string): void {
  restoreTabScroll(type, view.contentEl);
  applyTabEnter(view.contentEl, type);
}

/** ビューを閉じるときの共通処理。 */
export function closeTabShell(view: ItemView, type: string): void {
  saveTabScrollOnClose(type, view.contentEl);
  view.contentEl.empty();
}
