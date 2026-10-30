/**
 * ホームのショートカット一覧。設定の読み書きと、タイル・フォルダの表示を担当する。
 */

import type { App } from "obsidian";
import { normalizePath, setIcon, TFile } from "obsidian";
import { createId } from "../../domain/ids";
import type {
  SeitonSettings,
  SeitonShortcut,
  SeitonShortcutFolder,
} from "../../services/settings";
import { showCardMenu } from "../cardMenu";
import { ShortcutAddModal } from "../shortcutAddModal";
import { ShortcutFolderModal } from "../shortcutFolderModal";
import { ShortcutModal } from "../shortcutModal";

export interface HomeShortcutsOptions {
  app: App;
  getSettings: () => SeitonSettings;
  openPath: (path: string) => void;
  saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>;
}

function shortcutHost(target: string): string | null {
  if (!/^https?:\/\//iu.test(target)) {
    return null;
  }
  try {
    return new URL(target).hostname;
  } catch {
    return null;
  }
}

export class HomeShortcuts {
  private readonly app: App;
  private readonly getSettings: () => SeitonSettings;
  private readonly openPath: (path: string) => void;
  private readonly saveSettings: (
    patch: Partial<SeitonSettings>
  ) => Promise<void>;
  private hostEl: HTMLElement | null = null;
  private openFolderId: string | null = null;

  constructor(options: HomeShortcutsOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.openPath = options.openPath;
    this.saveSettings = options.saveSettings;
  }

  render(host: HTMLElement): void {
    this.hostEl = host;
    this.renderShortcuts();
  }

  clear(): void {
    this.hostEl = null;
  }

  reset(): void {
    this.hostEl = null;
    this.openFolderId = null;
  }

  private renderShortcuts(): void {
    const host = this.hostEl;
    if (!host) {
      return;
    }
    host.empty();
    const settings = this.getSettings();
    const folder = this.openFolderId
      ? settings.shortcutFolders.find((item) => item.id === this.openFolderId)
      : undefined;
    if (this.openFolderId && !folder) {
      this.openFolderId = null;
    }

    if (folder) {
      this.renderFolderHeader(host, folder);
      const items = settings.shortcuts.filter(
        (item) => item.folderId === folder.id
      );
      if (items.length === 0) {
        host.createDiv({
          cls: "seiton-shortcuts-empty",
          text: "このフォルダは空です。",
        });
      }
      for (const item of items) {
        host.appendChild(this.renderShortcutTile(item));
      }
      host.appendChild(this.renderShortcutAddTile(folder.id));
      return;
    }

    if (
      settings.shortcuts.length === 0 &&
      settings.shortcutFolders.length === 0
    ) {
      host.createDiv({
        cls: "seiton-shortcuts-empty",
        text: "よく開くサイトやノートを追加できます。",
      });
    }
    for (const item of settings.shortcutFolders) {
      host.appendChild(this.renderShortcutFolderTile(item));
    }
    for (const item of settings.shortcuts.filter(
      (entry) => entry.folderId === null
    )) {
      host.appendChild(this.renderShortcutTile(item));
    }
    host.appendChild(this.renderShortcutAddTile(null));
  }

  private renderFolderHeader(
    host: HTMLElement,
    folder: SeitonShortcutFolder
  ): void {
    const head = host.createDiv({ cls: "seiton-shortcuts-folder-head" });
    const back = head.createEl("button", {
      attr: {
        "aria-label": "ショートカット一覧に戻る",
        type: "button",
      },
      cls: "seiton-shortcuts-back",
    });
    setIcon(back, "arrow-left");
    back.createSpan({ text: "戻る" });
    back.addEventListener("click", () => {
      this.openFolderId = null;
      this.renderShortcuts();
    });
    head.createSpan({
      cls: "seiton-shortcuts-folder-title",
      text: folder.name,
    });
  }

  private renderShortcutFolderTile(folder: SeitonShortcutFolder): HTMLElement {
    const tile = document.createElement("div");
    tile.className = "seiton-shortcut";

    const main = tile.createEl("button", {
      attr: { "aria-label": `${folder.name} を開く`, type: "button" },
      cls: "seiton-shortcut-main",
    });
    const icon = main.createSpan({ cls: "seiton-shortcut-icon" });
    setIcon(icon, "folder");
    main.createSpan({ cls: "seiton-shortcut-label", text: folder.name });
    main.addEventListener("click", () => {
      this.openFolderId = folder.id;
      this.renderShortcuts();
    });

    const more = tile.createEl("button", {
      attr: { "aria-label": `${folder.name} の操作`, type: "button" },
      cls: "seiton-shortcut-more",
      text: "⋯",
    });
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openFolderMenu(more, folder);
    });
    tile.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openFolderMenu(tile, folder);
    });
    return tile;
  }

  private openFolderMenu(
    anchor: HTMLElement,
    folder: SeitonShortcutFolder
  ): void {
    showCardMenu(anchor, [
      {
        label: "名前を変更",
        run: () => this.openFolderEditor(folder),
      },
      {
        label: "削除",
        run: () => {
          void this.removeFolder(folder);
        },
      },
    ]);
  }

  private openFolderEditor(initial?: SeitonShortcutFolder): void {
    new ShortcutFolderModal(this.app, {
      initialName: initial?.name ?? "",
      onSubmit: (name) => {
        void this.saveFolder(initial?.id ?? createId("f"), name);
      },
    }).open();
  }

  private async saveFolder(id: string, name: string): Promise<void> {
    const folders = [...this.getSettings().shortcutFolders];
    const index = folders.findIndex((item) => item.id === id);
    if (index >= 0) {
      folders[index] = { id, name };
    } else {
      folders.push({ id, name });
    }
    await this.saveSettings({ shortcutFolders: folders });
    this.renderShortcuts();
  }

  private async removeFolder(folder: SeitonShortcutFolder): Promise<void> {
    const settings = this.getSettings();
    const folders = settings.shortcutFolders.filter(
      (item) => item.id !== folder.id
    );
    const shortcuts = settings.shortcuts.map((item) =>
      item.folderId === folder.id ? { ...item, folderId: null } : item
    );
    if (this.openFolderId === folder.id) {
      this.openFolderId = null;
    }
    await this.saveSettings({ shortcutFolders: folders, shortcuts });
    this.renderShortcuts();
  }

  private renderShortcutTile(shortcut: SeitonShortcut): HTMLElement {
    const tile = document.createElement("div");
    tile.className = "seiton-shortcut";

    const main = tile.createEl("button", {
      attr: { "aria-label": `${shortcut.label} を開く`, type: "button" },
      cls: "seiton-shortcut-main",
    });
    const icon = main.createSpan({ cls: "seiton-shortcut-icon" });
    this.renderShortcutIcon(icon, shortcut);
    main.createSpan({ cls: "seiton-shortcut-label", text: shortcut.label });
    main.addEventListener("click", () => this.openShortcut(shortcut));

    const more = tile.createEl("button", {
      attr: {
        "aria-label": `${shortcut.label} の操作`,
        type: "button",
      },
      cls: "seiton-shortcut-more",
      text: "⋯",
    });
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openShortcutMenu(more, shortcut);
    });
    tile.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openShortcutMenu(tile, shortcut);
    });
    return tile;
  }

  private renderShortcutAddTile(folderId: string | null): HTMLElement {
    const tile = document.createElement("div");
    tile.className = "seiton-shortcut";
    const main = tile.createEl("button", {
      attr: { "aria-label": "追加", type: "button" },
      cls: "seiton-shortcut-main seiton-shortcut-add",
    });
    const icon = main.createSpan({ cls: "seiton-shortcut-icon" });
    setIcon(icon, "plus");
    main.createSpan({ cls: "seiton-shortcut-label", text: "追加" });
    main.addEventListener("click", (event) => {
      event.stopPropagation();
      if (folderId) {
        this.openShortcutEditor(undefined, folderId);
        return;
      }
      new ShortcutAddModal(this.app, {
        onFolder: () => this.openFolderEditor(),
        onShortcut: () => this.openShortcutEditor(undefined, null),
      }).open();
    });
    return tile;
  }

  private renderShortcutIcon(
    parent: HTMLElement,
    shortcut: SeitonShortcut
  ): void {
    const showLetter = (): void => {
      parent.empty();
      parent.createSpan({
        cls: "seiton-shortcut-letter",
        text: [...shortcut.label][0] ?? "?",
      });
    };
    const host = shortcutHost(shortcut.target);
    if (host && this.getSettings().shortcutFavicons) {
      const image = parent.createEl("img", {
        attr: { alt: "" },
        cls: "seiton-shortcut-favicon",
      });
      image.src = `https://icons.duckduckgo.com/ip3/${host}.ico`;
      image.addEventListener("error", showLetter);
      return;
    }
    showLetter();
  }

  private openShortcutMenu(
    anchor: HTMLElement,
    shortcut: SeitonShortcut
  ): void {
    showCardMenu(anchor, [
      {
        label: "編集",
        run: () => this.openShortcutEditor(shortcut),
      },
      {
        label: "左へ移動",
        run: () => {
          void this.moveShortcut(shortcut, -1);
        },
      },
      {
        label: "右へ移動",
        run: () => {
          void this.moveShortcut(shortcut, 1);
        },
      },
      {
        label: "削除",
        run: () => {
          void this.removeShortcut(shortcut.id);
        },
      },
    ]);
  }

  private openShortcutEditor(
    initial?: SeitonShortcut,
    folderId: string | null = null
  ): void {
    const settings = this.getSettings();
    new ShortcutModal(this.app, {
      folders: settings.shortcutFolders,
      initial: initial
        ? {
            folderId: initial.folderId,
            label: initial.label,
            target: initial.target,
          }
        : undefined,
      initialFolderId: initial?.folderId ?? folderId,
      onSubmit: (input) => {
        void this.saveShortcut(initial?.id ?? createId("s"), input);
      },
    }).open();
  }

  private async saveShortcut(
    id: string,
    input: { folderId: string | null; label: string; target: string }
  ): Promise<void> {
    const shortcuts = [...this.getSettings().shortcuts];
    const index = shortcuts.findIndex((item) => item.id === id);
    const next = {
      folderId: input.folderId,
      id,
      label: input.label,
      target: input.target,
    };
    if (index >= 0) {
      shortcuts[index] = next;
    } else {
      shortcuts.push(next);
    }
    await this.saveSettings({ shortcuts });
    this.renderShortcuts();
  }

  private async removeShortcut(id: string): Promise<void> {
    const shortcuts = this.getSettings().shortcuts.filter(
      (item) => item.id !== id
    );
    await this.saveSettings({ shortcuts });
    this.renderShortcuts();
  }

  private async moveShortcut(
    shortcut: SeitonShortcut,
    delta: number
  ): Promise<void> {
    const shortcuts = [...this.getSettings().shortcuts];
    const siblings = shortcuts.filter(
      (item) => item.folderId === shortcut.folderId
    );
    const current = siblings.findIndex((item) => item.id === shortcut.id);
    const target = siblings[current + delta];
    if (!target) {
      return;
    }
    const from = shortcuts.findIndex((item) => item.id === shortcut.id);
    const to = shortcuts.findIndex((item) => item.id === target.id);
    const fromItem = shortcuts[from];
    const toItem = shortcuts[to];
    if (!(fromItem && toItem)) {
      return;
    }
    shortcuts[from] = toItem;
    shortcuts[to] = fromItem;
    await this.saveSettings({ shortcuts });
    this.renderShortcuts();
  }

  private openShortcut(shortcut: SeitonShortcut): void {
    const target = shortcut.target.trim();
    if (/^https?:\/\//iu.test(target)) {
      window.open(target, "_blank");
      return;
    }
    const link =
      target
        .replace(/^\[\[|\]\]$/gu, "")
        .split("|")[0]
        ?.trim() ?? "";
    if (link === "") {
      return;
    }
    const path = normalizePath(link);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.openPath(path);
      return;
    }
    void this.app.workspace.openLinkText(link, "", false);
  }
}
