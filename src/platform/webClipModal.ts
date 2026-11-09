import { type App, Modal, Notice, TFile } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { bodyAfterFrontmatter } from "../domain/frontmatter";
import { isAllowedRemoteUrl } from "../domain/network";
import type { WebClipMetadata } from "../domain/webclip";
import { MemoService } from "../services/memoService";
import type { WebClipNote, WebClipService } from "../services/webClipService";
import { ObsidianVaultPort } from "./obsidianVaultPort";
import { markSeitonModal } from "./ui/modal";
import { ButtonComponent, Setting, type TextComponent } from "./ui/setting";

import { showToast } from "./ui/toast";
export interface WebClipPreviewOptions {
  initialUrl?: string;
  memoService?: MemoService;
  notePath?: string;
  onChanged?: (path: string) => void;
}

/** 明示操作時だけURLを取得し、プレビューを確認してから反映する。 */
export class WebClipPreviewModal extends Modal {
  private readonly service: WebClipService;
  private readonly options: WebClipPreviewOptions;
  private url: string;
  private preview: WebClipMetadata | null = null;
  private previewEl: HTMLElement | null = null;
  private readerHostEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private applyButton: ButtonComponent | null = null;
  private clipTitle = "";
  private busy = false;

  constructor(
    app: App,
    service: WebClipService,
    options: WebClipPreviewOptions = {}
  ) {
    super(app);
    this.service = service;
    this.options = options;
    this.url = options.initialUrl ?? "";
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.modalEl.addClass("seiton-webclip-modal");
    this.setTitle(
      this.options.notePath
        ? "Webクリップのプレビュー"
        : "URLからWebクリップを作成"
    );
    this.contentEl.createEl("p", {
      cls: "seiton-prompt-hint",
      text: "取得はこの操作のときだけ行います。外部取得に失敗しても、既存のノート本文はそのまま読めます。",
    });

    new Setting(this.contentEl)
      .setName("URL")
      .setDesc("http/httpsのみ。localhostやプライベートIPは拒否します。")
      .addText((text: TextComponent) => {
        text
          .setPlaceholder("https://…")
          .setValue(this.url)
          .onChange((value) => {
            this.url = value;
          });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });

    const buttonRow = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const previewButton = new ButtonComponent(buttonRow)
      .setButtonText("プレビュー取得")
      .setCta()
      .onClick(() => {
        void this.fetchPreview();
      });
    this.applyButton = new ButtonComponent(buttonRow)
      .setButtonText(
        this.options.notePath ? "このノートに反映" : "クリップを作成"
      )
      .setDisabled(true)
      .onClick(() => {
        void this.apply();
      });

    this.statusEl = this.contentEl.createDiv({ cls: "seiton-modal-status" });
    this.previewEl = this.contentEl.createDiv({
      cls: "seiton-webclip-preview",
    });
    this.readerHostEl = this.contentEl.createDiv({
      cls: "seiton-webclip-reader-container",
    });

    if (this.options.notePath) {
      void this.loadNoteReader();
    } else {
      this.previewEl.createDiv({
        cls: "seiton-empty",
        text: "URLを入力して「プレビュー取得」を押してください。",
      });
    }
    void previewButton;
  }

  private async loadNoteReader(): Promise<void> {
    const notePath = this.options.notePath;
    if (!notePath || !this.readerHostEl) {
      return;
    }
    this.readerHostEl.empty();
    try {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!(file instanceof TFile)) {
        return;
      }
      const content = await this.app.vault.cachedRead(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const title =
        (typeof cache?.frontmatter?.title === "string" &&
          cache.frontmatter.title.trim()) ||
        file.basename;
      this.clipTitle = title;
      const body = bodyAfterFrontmatter(content).trim();

      const section = this.readerHostEl.createDiv({
        cls: "seiton-webclip-reader-zone",
      });

      // ひとこと抜粋・感想メモ入力欄
      const memoWrap = section.createDiv({
        cls: "seiton-webclip-memo-input-wrap",
      });
      memoWrap.createEl("h3", {
        cls: "seiton-webclip-memo-title",
        text: "ひとこと抜粋・感想メモを追加",
      });
      const inputRow = memoWrap.createDiv({
        cls: "seiton-webclip-memo-row",
      });
      const memoInput = inputRow.createEl("input", {
        attr: {
          placeholder: "気になるフレーズや要約・感想を入力...",
          type: "text",
        },
        cls: "st-input seiton-webclip-memo-input",
      });
      const submitBtn = inputRow.createEl("button", {
        attr: { type: "button" },
        cls: "st-btn is-primary seiton-webclip-memo-btn",
        text: "つぶやきに記録",
      });

      const handleAddMemo = async () => {
        const val = memoInput.value.trim();
        if (!val) {
          return;
        }
        submitBtn.disabled = true;
        try {
          const memoService =
            this.options.memoService ??
            new MemoService({ vault: new ObsidianVaultPort(this.app) });
          await memoService.addMemo(
            `\`${this.clipTitle}\` より: ${val} #webクリップ`
          );
          memoInput.value = "";
          new Notice("つぶやきに抜粋メモを保存しました");
        } catch (error) {
          showToast(userMessageOf(error));
        } finally {
          submitBtn.disabled = false;
        }
      };

      submitBtn.addEventListener("click", () => void handleAddMemo());
      memoInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void handleAddMemo();
        }
      });

      // クリーンリーダー領域
      const reader = section.createDiv({ cls: "seiton-webclip-reader" });
      reader.createEl("h3", {
        cls: "seiton-webclip-reader-title",
        text: title,
      });
      const bodyEl = reader.createDiv({
        cls: "seiton-webclip-reader-body",
      });
      bodyEl.setText(body || "（ノート本文はありません）");
    } catch (error) {
      this.readerHostEl.createDiv({
        cls: "st-status is-error",
        text: userMessageOf(error),
      });
    }
  }

  private async fetchPreview(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.setStatus("取得中…");
    try {
      this.preview = await this.service.preview(this.url);
      this.renderPreview(this.preview);
      this.applyButton?.setDisabled(false);
      this.setStatus(
        "プレビューを取得しました。内容を確認して反映してください。"
      );
    } catch (error) {
      this.setStatus(userMessageOf(error), true);
      this.applyButton?.setDisabled(true);
    } finally {
      this.busy = false;
    }
  }

  private async apply(): Promise<void> {
    if (!this.preview || this.busy) {
      return;
    }
    this.busy = true;
    try {
      if (this.options.notePath) {
        await this.service.applyPreviewToNote(
          this.options.notePath,
          this.preview
        );
        this.options.onChanged?.(this.options.notePath);
        showToast("WebクリップのPropertiesを更新しました。");
      } else {
        const path = await this.service.createClip(this.preview);
        this.options.onChanged?.(path);
        showToast("Webクリップを作成しました。");
      }
      this.close();
    } catch (error) {
      this.setStatus(userMessageOf(error), true);
    } finally {
      this.busy = false;
    }
  }

  private renderPreview(preview: WebClipMetadata): void {
    if (!this.previewEl) {
      return;
    }
    this.previewEl.empty();
    if (preview.imageUrl) {
      const image = this.previewEl.createEl("img", {
        cls: "seiton-webclip-preview-image",
      });
      image.src = preview.imageUrl;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => image.remove());
    }
    this.previewEl.createDiv({
      cls: "seiton-webclip-domain",
      text: preview.domain,
    });
    this.previewEl.createDiv({
      cls: "seiton-li-title",
      text: preview.title,
    });
    if (preview.description) {
      this.previewEl.createDiv({
        cls: "seiton-li-excerpt",
        text: preview.description,
      });
    }
    this.previewEl.createDiv({
      cls: "seiton-webclip-source",
      text: preview.source,
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.previewEl = null;
    this.readerHostEl = null;
    this.statusEl = null;
    this.applyButton = null;
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }
}

/** Libraryのカード。画像取得に失敗してもドメイン表示で読める。 */
export function renderWebClipCard(
  container: HTMLElement,
  note: WebClipNote,
  onOpen: () => void,
  onPreview: () => void,
  dateText?: string
): void {
  const article = document.createElement("article");
  article.className = "seiton-item seiton-webclip-item";
  article.dataset.kind = "webclip";

  const head = article.createDiv({ cls: "seiton-item-head" });
  if (note.image && isAllowedRemoteUrl(note.image)) {
    const image = head.createEl("img", { cls: "seiton-item-cover" });
    image.src = note.image;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove());
  }
  head.createSpan({ cls: "seiton-item-type", text: "Web" });
  if (dateText) {
    head.createSpan({
      cls: "seiton-item-updated",
      text: `更新 ${dateText}`,
    });
  }

  const content = article.createDiv({ cls: "seiton-item-content" });
  if (note.duplicates > 1) {
    const markers = content.createDiv({ cls: "seiton-item-markers" });
    markers.createSpan({
      cls: "seiton-item-marker is-warm",
      text: `同じURL ${note.duplicates}件`,
    });
  }
  const title = content.createEl("button", {
    cls: "seiton-item-title",
    text: note.title,
  });
  title.type = "button";
  title.addEventListener("click", onOpen);
  content.createDiv({
    cls: "seiton-item-source",
    text: note.domain || note.source,
  });
  if (note.description) {
    content.createDiv({ cls: "seiton-item-excerpt", text: note.description });
  }

  const side = article.createDiv({ cls: "seiton-item-side" });
  const more = article.createEl("button", {
    attr: {
      "aria-expanded": "false",
      "aria-label": "操作を表示",
    },
    cls: "seiton-item-more",
    text: "⋯",
  });
  more.type = "button";
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = article.classList.toggle("is-actions-open");
    more.setAttribute("aria-expanded", String(open));
  });
  const actions = side.createDiv({ cls: "seiton-item-actions" });
  addClipAction(actions, "開く", onOpen);
  addClipAction(actions, "プレビュー", onPreview);
  container.appendChild(article);
}

function addClipAction(
  parent: HTMLElement,
  label: string,
  action: () => void
): void {
  const button = parent.createEl("button", {
    cls: "st-btn is-secondary seiton-item-action",
    text: label,
  });
  button.type = "button";
  button.addEventListener("click", action);
}
