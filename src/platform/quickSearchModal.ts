/**
 * 一覧をスクロールしたまま開ける統合クイックスイッチャー＆コマンドランチャー。
 * 入力に合わせてアクション・ノート・メモ・本・プロンプトを横断して絞り込み、ワンタップで実行・ジャンプする。
 */

import { type App, Modal, setIcon } from "obsidian";
import {
  VIEW_TYPE_ASSETS,
  VIEW_TYPE_BOOKSHELF,
  VIEW_TYPE_HOME,
  VIEW_TYPE_LIBRARY,
  VIEW_TYPE_PROJECTS,
  VIEW_TYPE_PROMPT,
  VIEW_TYPE_TSUBUYAKI,
} from "../config";
import { openSeitonView } from "./seitonNav";
import { markSeitonModal } from "./ui/modal";

export interface QuickSearchItem {
  action: () => void;
  category?: "action" | "note" | "memo" | "book" | "prompt";
  icon?: string;
  meta?: string;
  title: string;
}

export interface QuickSearchOptions {
  actions?: QuickSearchItem[];
  emptyText?: string;
  includeActions?: boolean;
  items: QuickSearchItem[];
  placeholder: string;
  title: string;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function executeCommand(app: App, id: string): void {
  const commands = (
    app as unknown as {
      commands?: {
        executeCommandById: (commandId: string) => boolean | Promise<unknown>;
      };
    }
  ).commands;
  if (commands && !commands.executeCommandById(`seiton-next:${id}`)) {
    commands.executeCommandById(id);
  }
}

function buildDefaultActions(app: App): QuickSearchItem[] {
  return [
    {
      action: () => executeCommand(app, "new-note"),
      category: "action",
      icon: "file-plus",
      meta: "コマンド",
      title: "新規ノート作成",
    },
    {
      action: () => executeCommand(app, "add-memo"),
      category: "action",
      icon: "square-pen",
      meta: "コマンド",
      title: "メモを追加",
    },
    {
      action: () => executeCommand(app, "start-triage"),
      category: "action",
      icon: "inbox",
      meta: "コマンド",
      title: "1件ずつ整理（Triage）を開始",
    },
    {
      action: () => executeCommand(app, "preview-active-webclip"),
      category: "action",
      icon: "globe",
      meta: "コマンド",
      title: "Webクリップ追加・更新",
    },
    {
      action: () => executeCommand(app, "add-book"),
      category: "action",
      icon: "book",
      meta: "コマンド",
      title: "本を検索して追加",
    },
    {
      action: () => executeCommand(app, "scan-barcode"),
      category: "action",
      icon: "scan",
      meta: "コマンド",
      title: "バーコードで本を追加",
    },
    {
      action: () => void openSeitonView(app, VIEW_TYPE_ASSETS),
      category: "action",
      icon: "wallet",
      meta: "コマンド",
      title: "資産スナップショットを記録",
    },
    {
      action: () => void openSeitonView(app, VIEW_TYPE_HOME),
      category: "action",
      icon: "home",
      meta: "タブ移動",
      title: "タブ移動: ホーム",
    },
    {
      action: () => void openSeitonView(app, VIEW_TYPE_TSUBUYAKI),
      category: "action",
      icon: "message-square",
      meta: "タブ移動",
      title: "タブ移動: つぶやき",
    },
    {
      action: () => void openSeitonView(app, VIEW_TYPE_LIBRARY),
      category: "action",
      icon: "library",
      meta: "タブ移動",
      title: "タブ移動: ライブラリ",
    },
    {
      action: () => void openSeitonView(app, VIEW_TYPE_BOOKSHELF),
      category: "action",
      icon: "book-open",
      meta: "タブ移動",
      title: "タブ移動: 本棚",
    },
    {
      action: () => void openSeitonView(app, VIEW_TYPE_PROJECTS),
      category: "action",
      icon: "folder-kanban",
      meta: "タブ移動",
      title: "タブ移動: プロジェクト",
    },
    {
      action: () => void openSeitonView(app, VIEW_TYPE_ASSETS),
      category: "action",
      icon: "line-chart",
      meta: "タブ移動",
      title: "タブ移動: 資産",
    },
    {
      action: () => void openSeitonView(app, VIEW_TYPE_PROMPT),
      category: "action",
      icon: "terminal",
      meta: "タブ移動",
      title: "タブ移動: Prompt",
    },
  ];
}

export class QuickSearchModal extends Modal {
  private readonly options: QuickSearchOptions;
  private readonly allActions: QuickSearchItem[];
  private query = "";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private buttons: HTMLButtonElement[] = [];

  constructor(app: App, options: QuickSearchOptions) {
    super(app);
    this.options = options;
    const include = options.includeActions ?? true;
    this.allActions = include
      ? (options.actions ?? buildDefaultActions(app))
      : (options.actions ?? []);
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.modalEl.addClass("seiton-quick-search-modal");
    this.setTitle(this.options.title);

    const input = this.contentEl.createEl("input", {
      attr: {
        "aria-label": this.options.title,
        placeholder: this.options.placeholder,
        type: "search",
      },
      cls: "seiton-quick-search-input",
    });
    this.inputEl = input;
    this.countEl = this.contentEl.createDiv({
      cls: "seiton-quick-search-count",
    });
    this.listEl = this.contentEl.createDiv({
      cls: "seiton-quick-search-list",
    });

    input.addEventListener("input", () => {
      this.query = input.value;
      this.render();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.buttons[0]?.focus();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.buttons[0]?.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });

    this.render();
    window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.buttons = [];
    this.listEl = null;
    this.countEl = null;
    this.inputEl = null;
  }

  private render(): void {
    const host = this.listEl;
    if (!host) {
      return;
    }
    host.empty();
    this.buttons = [];
    const query = normalize(this.query.trim());

    let matches: QuickSearchItem[];

    if (query === "") {
      // クエリ空のときは、主要クイックアクション上位7件 + 最新アイテム40件
      const topActions = this.allActions.slice(0, 7);
      const topItems = this.options.items.slice(0, 40);
      matches = [...topActions, ...topItems];
    } else {
      const matchFilter = (item: QuickSearchItem) =>
        normalize(`${item.title} ${item.meta ?? ""}`).includes(query);

      const matchedActions = this.allActions.filter(matchFilter);
      const matchedItems = this.options.items.filter(matchFilter);
      matches = [...matchedActions, ...matchedItems].slice(0, 50);
    }

    if (this.countEl) {
      this.countEl.setText(`${matches.length}件`);
    }

    if (matches.length === 0) {
      host.createDiv({
        cls: "seiton-empty",
        text: this.options.emptyText ?? "一致する項目がありません。",
      });
      return;
    }

    for (const item of matches) {
      const isAction = item.category === "action";
      const button = host.createEl("button", {
        attr: { type: "button" },
        cls: `seiton-quick-search-item${isAction ? " is-action" : ""}`,
      });

      if (item.icon) {
        const iconWrap = button.createSpan({
          cls: "seiton-quick-search-icon",
        });
        setIcon(iconWrap, item.icon);
      }

      button.createSpan({
        cls: "seiton-quick-search-title",
        text: item.title,
      });

      if (item.meta) {
        button.createSpan({
          cls: "seiton-quick-search-meta",
          text: item.meta,
        });
      }

      button.addEventListener("click", () => {
        this.close();
        item.action();
      });

      button.addEventListener("keydown", (event) => {
        const index = this.buttons.indexOf(button);
        if (event.key === "ArrowDown") {
          event.preventDefault();
          this.buttons[index + 1]?.focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          if (index === 0) {
            this.inputEl?.focus();
          } else {
            this.buttons[index - 1]?.focus();
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.close();
        }
      });

      this.buttons.push(button);
    }
  }
}
