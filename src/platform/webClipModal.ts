import type { App } from "obsidian";
import { Modal } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { isAllowedRemoteUrl } from "../domain/network";
import type { WebClipMetadata } from "../domain/webclip";
import type { WebClipNote, WebClipService } from "../services/webClipService";
import { markSeitonModal } from "./ui/modal";
import { ButtonComponent, Setting, type TextComponent } from "./ui/setting";

import { showToast } from "./ui/toast";
export interface WebClipPreviewOptions {
  initialUrl?: string;
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
  private statusEl: HTMLElement | null = null;
  private applyButton: ButtonComponent | null = null;
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
    this.previewEl.createDiv({
      cls: "seiton-empty",
      text: "URLを入力して「プレビュー取得」を押してください。",
    });
    void previewButton;
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
    cls: "seiton-item-action",
    text: label,
  });
  button.type = "button";
  button.addEventListener("click", action);
}
