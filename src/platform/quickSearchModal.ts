/**
 * 一覧をスクロールしたまま開ける簡易検索。
 * 入力に合わせて候補を絞り、選ぶと既存の画面で開く。
 */

import type { App } from "obsidian";
import { Modal } from "obsidian";
import { markSeitonModal } from "./ui/modal";

export interface QuickSearchItem {
  action: () => void;
  meta?: string;
  title: string;
}

export interface QuickSearchOptions {
  emptyText?: string;
  items: QuickSearchItem[];
  placeholder: string;
  title: string;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export class QuickSearchModal extends Modal {
  private readonly options: QuickSearchOptions;
  private query = "";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private buttons: HTMLButtonElement[] = [];

  constructor(app: App, options: QuickSearchOptions) {
    super(app);
    this.options = options;
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
  }

  private render(): void {
    const host = this.listEl;
    if (!host) {
      return;
    }
    host.empty();
    this.buttons = [];
    const query = normalize(this.query.trim());
    const matched = this.options.items.filter((item) => {
      if (query === "") {
        return true;
      }
      return normalize(`${item.title} ${item.meta ?? ""}`).includes(query);
    });
    const matches = matched.slice(0, 50);

    if (this.countEl) {
      this.countEl.setText(`${matched.length}件`);
    }

    if (matches.length === 0) {
      host.createDiv({
        cls: "seiton-empty",
        text: this.options.emptyText ?? "一致する項目がありません。",
      });
      return;
    }

    for (const item of matches) {
      const button = host.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-quick-search-item",
      });
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
          this.buttons[index - 1]?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.close();
        }
      });
      this.buttons.push(button);
    }
  }
}
