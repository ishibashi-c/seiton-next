/**
 * ホームのショートカット一覧。
 * 保存先は設定ではなく Vault 内のノート1枚（`Seiton/System/Links.md`）で、
 * ここは表示と操作だけを持つ。
 */

import type { App } from "obsidian";
import { Notice, normalizePath, setIcon, TFile } from "obsidian";
import type { LinkEditStatus, LinkEntry } from "../../domain/linkList";
import {
  addGroup,
  addLink,
  moveLink,
  moveLinkAfter,
  moveLinkBefore,
  moveLinkToGroup,
  removeGroup,
  removeLink,
  renameGroup,
  updateLink,
} from "../../domain/linkList";
import type { LinkListService } from "../../services/linkListService";
import { showCardMenu } from "../cardMenu";
import { ShortcutAddModal } from "../shortcutAddModal";
import { ShortcutFolderModal } from "../shortcutFolderModal";
import { type ShortcutInput, ShortcutModal } from "../shortcutModal";
import { ShortcutDrag } from "./dragSort";

export interface HomeShortcutsOptions {
  app: App;
  favicons: () => boolean;
  links: LinkListService;
  openPath: (path: string) => void;
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

function statusMessage(status: LinkEditStatus, label: string): string | null {
  if (status === "added") {
    return `「${label}」を追加しました。`;
  }
  if (status === "duplicate") {
    return "同じリンクがすでにあります。";
  }
  if (status === "exists") {
    return "同じ名前のグループがあります。";
  }
  if (status === "missing") {
    return "見つかりませんでした。ノートを開いて確認してください。";
  }
  if (status === "removed") {
    return `「${label}」を削除しました。`;
  }
  return null;
}

export class HomeShortcuts {
  private readonly app: App;
  private readonly favicons: () => boolean;
  private readonly links: LinkListService;
  private readonly openPath: (path: string) => void;
  private drag: ShortcutDrag | null = null;
  private hostEl: HTMLElement | null = null;
  private openGroup: string | null = null;
  private sections: Array<{
    items: LinkEntry[];
    name: string | null;
  }> = [];

  constructor(options: HomeShortcutsOptions) {
    this.app = options.app;
    this.favicons = options.favicons;
    this.links = options.links;
    this.openPath = options.openPath;
  }

  render(host: HTMLElement): void {
    this.hostEl = host;
    this.drag?.destroy();
    this.drag = new ShortcutDrag(host, {
      onGroup: (source, group) => {
        void this.dropToGroup(source, group);
      },
      onItem: (source, target, before) => {
        void this.dropOnItem(source, target, before);
      },
    });
    this.renderList();
    void this.reload();
  }

  clear(): void {
    this.hostEl = null;
  }

  reset(): void {
    this.drag?.destroy();
    this.drag = null;
    this.hostEl = null;
    this.openGroup = null;
  }

  async reload(): Promise<void> {
    try {
      const list = await this.links.load();
      this.sections = list.sections.map((section) => ({
        items: section.items,
        name: section.name,
      }));
    } catch {
      this.sections = [];
    }
    this.renderList();
  }

  private groupNames(): string[] {
    return this.sections
      .map((section) => section.name)
      .filter((name): name is string => name !== null);
  }

  private itemsOf(group: string | null): LinkEntry[] {
    const section = this.sections.find((entry) => entry.name === group);
    return section?.items ?? [];
  }

  private groupOf(entry: LinkEntry): string | null {
    const section = this.sections.find((item) =>
      item.items.some((link) => link.target === entry.target)
    );
    return section?.name ?? null;
  }

  private renderList(): void {
    const host = this.hostEl;
    if (!host) {
      return;
    }
    host.empty();
    const groups = this.groupNames();
    if (this.openGroup !== null && !groups.includes(this.openGroup)) {
      this.openGroup = null;
    }
    if (this.openGroup !== null) {
      this.renderGroupHeader(host, this.openGroup);
      const items = this.itemsOf(this.openGroup);
      if (items.length === 0) {
        host.createDiv({
          cls: "seiton-shortcuts-empty",
          text: "このグループは空です。",
        });
      }
      for (const item of items) {
        host.appendChild(this.renderItemTile(item));
      }
      host.appendChild(this.renderAddTile(this.openGroup));
      return;
    }

    if (groups.length === 0 && this.itemsOf(null).length === 0) {
      host.createDiv({
        cls: "seiton-shortcuts-empty",
        text: "よく開くサイトやノートを追加できます。",
      });
    }
    for (const name of groups) {
      host.appendChild(this.renderGroupTile(name));
    }
    for (const item of this.itemsOf(null)) {
      host.appendChild(this.renderItemTile(item));
    }
    host.appendChild(this.renderAddTile(null));
  }

  private renderGroupHeader(host: HTMLElement, name: string): void {
    const head = host.createDiv({ cls: "seiton-shortcuts-folder-head" });
    const back = head.createEl("button", {
      attr: { "aria-label": "ショートカット一覧に戻る", type: "button" },
      cls: "seiton-shortcuts-back",
    });
    setIcon(back, "arrow-left");
    back.createSpan({ text: "戻る" });
    back.addEventListener("click", () => {
      this.openGroup = null;
      this.renderList();
    });
    head.createSpan({ cls: "seiton-shortcuts-folder-title", text: name });
  }

  private renderGroupTile(name: string): HTMLElement {
    const tile = document.createElement("div");
    tile.className = "seiton-shortcut";

    const main = tile.createEl("button", {
      attr: { "aria-label": `${name} を開く`, type: "button" },
      cls: "seiton-shortcut-main",
    });
    const icon = main.createSpan({ cls: "seiton-shortcut-icon" });
    setIcon(icon, "folder");
    main.createSpan({ cls: "seiton-shortcut-label", text: name });
    main.addEventListener("click", () => {
      this.openGroup = name;
      this.renderList();
    });

    const more = tile.createEl("button", {
      attr: { "aria-label": `${name} の操作`, type: "button" },
      cls: "seiton-shortcut-more",
      text: "⋯",
    });
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openGroupMenu(more, name);
    });
    tile.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openGroupMenu(tile, name);
    });
    tile.dataset.groupName = name;
    return tile;
  }

  private openGroupMenu(anchor: HTMLElement, name: string): void {
    showCardMenu(anchor, [
      {
        label: "名前を変更",
        run: () => this.openGroupEditor(name),
      },
      {
        label: "削除",
        run: () => {
          void this.deleteGroup(name);
        },
      },
    ]);
  }

  private openGroupEditor(initialName?: string): void {
    new ShortcutFolderModal(this.app, {
      initialName: initialName ?? "",
      onSubmit: (name) => {
        void this.saveGroup(initialName, name);
      },
    }).open();
  }

  private async saveGroup(
    initialName: string | undefined,
    name: string
  ): Promise<void> {
    if (initialName === name) {
      return;
    }
    const edit = await this.links.edit((content) =>
      initialName
        ? renameGroup(content, initialName, name)
        : addGroup(content, name)
    );
    if (initialName && this.openGroup === initialName) {
      this.openGroup = null;
    }
    this.notify(edit.status, name);
    await this.reload();
  }

  private async deleteGroup(name: string): Promise<void> {
    const edit = await this.links.edit((content) => removeGroup(content, name));
    if (this.openGroup === name) {
      this.openGroup = null;
    }
    this.notify(edit.status, name);
    await this.reload();
  }

  private renderItemTile(entry: LinkEntry): HTMLElement {
    const tile = document.createElement("div");
    tile.className = "seiton-shortcut";

    const main = tile.createEl("button", {
      attr: { "aria-label": `${entry.label} を開く`, type: "button" },
      cls: "seiton-shortcut-main",
    });
    const icon = main.createSpan({ cls: "seiton-shortcut-icon" });
    this.renderIcon(icon, entry);
    main.createSpan({ cls: "seiton-shortcut-label", text: entry.label });
    main.addEventListener("click", () => this.openEntry(entry));

    const more = tile.createEl("button", {
      attr: { "aria-label": `${entry.label} の操作`, type: "button" },
      cls: "seiton-shortcut-more",
      text: "⋯",
    });
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openItemMenu(more, entry);
    });
    tile.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openItemMenu(tile, entry);
    });
    tile.dataset.linkTarget = entry.target;
    return tile;
  }

  private renderAddTile(group: string | null): HTMLElement {
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
      if (group !== null) {
        this.openItemEditor(undefined, group);
        return;
      }
      new ShortcutAddModal(this.app, {
        onFolder: () => this.openGroupEditor(),
        onShortcut: () => this.openItemEditor(undefined, null),
      }).open();
    });
    return tile;
  }

  private renderIcon(parent: HTMLElement, entry: LinkEntry): void {
    const showLetter = (): void => {
      parent.empty();
      parent.createSpan({
        cls: "seiton-shortcut-letter",
        text: [...entry.label][0] ?? "?",
      });
    };
    const host = shortcutHost(entry.target);
    if (host && this.favicons()) {
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

  private openItemMenu(anchor: HTMLElement, entry: LinkEntry): void {
    showCardMenu(anchor, [
      {
        label: "編集",
        run: () => this.openItemEditor(entry),
      },
      {
        label: "左へ移動",
        run: () => {
          void this.moveItem(entry, -1);
        },
      },
      {
        label: "右へ移動",
        run: () => {
          void this.moveItem(entry, 1);
        },
      },
      {
        label: "削除",
        run: () => {
          void this.deleteItem(entry);
        },
      },
    ]);
  }

  private openItemEditor(initial?: LinkEntry, group?: string | null): void {
    new ShortcutModal(this.app, {
      groups: this.groupNames(),
      initial: initial
        ? {
            group: this.groupOf(initial),
            label: initial.label,
            target: initial.target,
          }
        : undefined,
      initialGroup: group ?? null,
      onSubmit: (input) => {
        void this.saveItem(initial, input);
      },
    }).open();
  }

  private async saveItem(
    initial: LinkEntry | undefined,
    input: ShortcutInput
  ): Promise<void> {
    if (
      initial &&
      initial.label === input.label.trim() &&
      initial.target === input.target.trim() &&
      this.groupOf(initial) === input.group
    ) {
      return;
    }
    const edit = await this.links.edit((content) =>
      initial
        ? updateLink(content, initial.target, input)
        : addLink(content, input)
    );
    this.notify(edit.status, input.label.trim());
    await this.reload();
  }

  private async deleteItem(entry: LinkEntry): Promise<void> {
    const edit = await this.links.edit((content) =>
      removeLink(content, entry.target)
    );
    this.notify(edit.status, entry.label);
    await this.reload();
  }

  /** グループのタイルへ落とすと、そのグループの末尾へ移す。 */
  private async dropToGroup(source: string, name: string): Promise<void> {
    const edit = await this.links.edit((content) =>
      moveLinkToGroup(content, source, name)
    );
    if (edit.status === "updated") {
      new Notice(`「${name}」へ移しました。`);
      await this.reload();
    }
  }

  /** タイルの左半分に落とすと前、右半分に落とすと後ろへ移す。 */
  private async dropOnItem(
    source: string,
    target: string,
    before: boolean
  ): Promise<void> {
    if (source === target) {
      return;
    }
    const edit = await this.links.edit((content) =>
      before
        ? moveLinkBefore(content, source, target)
        : moveLinkAfter(content, source, target)
    );
    if (edit.status === "updated") {
      await this.reload();
    }
  }

  private async moveItem(entry: LinkEntry, delta: number): Promise<void> {
    const edit = await this.links.edit((content) =>
      moveLink(content, entry.target, delta)
    );
    if (edit.status === "updated") {
      await this.reload();
    }
  }

  private notify(status: LinkEditStatus, label: string): void {
    const message = statusMessage(status, label);
    if (message) {
      new Notice(message);
    }
  }

  private openEntry(entry: LinkEntry): void {
    const target = entry.target.trim();
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
