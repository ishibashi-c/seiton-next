import type { App, WorkspaceLeaf } from "obsidian";
import {
  VIEW_TYPE_BOOKSHELF,
  VIEW_TYPE_HOME,
  VIEW_TYPE_LIBRARY,
  VIEW_TYPE_PROJECTS,
  VIEW_TYPE_PROMPT,
  VIEW_TYPE_TSUBUYAKI,
} from "../config";
import { beginTabMotion, clearTabMotion } from "./tabMotion";
import { saveTabScroll } from "./tabScroll";

export type SeitonTopTab =
  | "bookshelf"
  | "home"
  | "library"
  | "projects"
  | "prompt"
  | "tsubuyaki";

export const TOP_TABS: Array<{
  id: SeitonTopTab;
  label: string;
  type: string;
}> = [
  { id: "home", label: "ホーム", type: VIEW_TYPE_HOME },
  { id: "tsubuyaki", label: "つぶやき", type: VIEW_TYPE_TSUBUYAKI },
  { id: "library", label: "ライブラリ", type: VIEW_TYPE_LIBRARY },
  { id: "bookshelf", label: "本棚", type: VIEW_TYPE_BOOKSHELF },
  { id: "projects", label: "プロジェクト", type: VIEW_TYPE_PROJECTS },
  { id: "prompt", label: "Prompt", type: VIEW_TYPE_PROMPT },
];

const TAB_INDEX = new Map(TOP_TABS.map((tab, index) => [tab.type, index]));
const SEITON_TYPES = new Set(TOP_TABS.map((tab) => tab.type));

export interface OpenSeitonViewOptions {
  /** Cmd/Ctrl押下時など、いまのリーフを残して別のタブに開く。 */
  forceNewLeaf?: boolean;
  /** ナビを押したリーフ。分割表示でも正しい面を差し替える。 */
  sourceLeaf?: WorkspaceLeaf;
}

/** 主要ビューを、いまのSeitonリーフを再利用して開く。 */
export async function openSeitonView(
  app: App,
  type: string,
  state?: Record<string, unknown>,
  options: OpenSeitonViewOptions = {}
): Promise<void> {
  const activeLeaf =
    options.sourceLeaf ??
    app.workspace.activeLeaf ??
    app.workspace.getMostRecentLeaf();
  const activeType = activeLeaf?.view.getViewType() ?? null;

  if (
    !options.forceNewLeaf &&
    activeLeaf &&
    activeType !== null &&
    SEITON_TYPES.has(activeType)
  ) {
    if (activeType === type) {
      await app.workspace.revealLeaf(activeLeaf);
      app.workspace.setActiveLeaf(activeLeaf, { focus: true });
      return;
    }
    const contentEl = (
      activeLeaf.view as unknown as { contentEl?: HTMLElement }
    ).contentEl;
    if (contentEl) {
      saveTabScroll(activeType, contentEl);
    }
    beginTabMotion(
      activeType,
      type,
      TAB_INDEX.get(activeType) ?? 0,
      TAB_INDEX.get(type) ?? 0
    );
    try {
      await activeLeaf.setViewState({ active: true, state, type });
      await app.workspace.revealLeaf(activeLeaf);
      app.workspace.setActiveLeaf(activeLeaf, { focus: true });
      return;
    } catch {
      clearTabMotion();
    }
  }

  const existing = options.forceNewLeaf
    ? undefined
    : app.workspace.getLeavesOfType(type)[0];
  if (existing) {
    if (state) {
      await existing.setViewState({ active: true, state, type });
    }
    await app.workspace.revealLeaf(existing);
    app.workspace.setActiveLeaf(existing, { focus: true });
    return;
  }

  const leaf = app.workspace.getLeaf("tab");
  await leaf.setViewState({
    active: true,
    state,
    type,
  });
  await app.workspace.revealLeaf(leaf);
  app.workspace.setActiveLeaf(leaf, { focus: true });
}

export function renderSeitonNav(
  app: App,
  parent: HTMLElement,
  active: SeitonTopTab | null,
  sourceLeaf?: WorkspaceLeaf
): void {
  const nav = parent.createDiv({ cls: "seiton-top-nav" });
  nav.setAttribute("aria-label", "Seitonのタブ");
  nav.setAttribute("role", "tablist");
  const buttons: HTMLButtonElement[] = [];

  for (const tab of TOP_TABS) {
    const isActive = tab.id === active;
    const button = nav.createEl("button", {
      cls: `seiton-top-tab${isActive ? " is-active" : ""}`,
      text: tab.label,
    });
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
    if (isActive) {
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", (event) => {
      const forceNewLeaf = event.metaKey || event.ctrlKey;
      if (tab.id !== active || forceNewLeaf) {
        void openSeitonView(app, tab.type, undefined, {
          forceNewLeaf,
          sourceLeaf,
        });
      }
    });
    button.addEventListener("focus", () => {
      for (const other of buttons) {
        other.tabIndex = other === button ? 0 : -1;
      }
      button.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    buttons.push(button);
    if (isActive) {
      window.setTimeout(() => {
        button.scrollIntoView({ block: "nearest", inline: "nearest" });
      }, 0);
    }
  }

  nav.addEventListener("keydown", (event) => {
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement
    );
    if (current < 0) {
      return;
    }
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % buttons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = buttons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  });
}
