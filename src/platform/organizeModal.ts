import type { App } from "obsidian";
import { ButtonComponent, Modal, Setting, type TextComponent } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { wikiLink } from "../domain/links";
import type { VocabularyEntry } from "../domain/vocabulary";
import type { PropertyService } from "../services/propertyService";
import {
  appendVocabularyValue,
  renderVocabularyChips,
} from "./vocabularyChips";

export interface OrganizeVocabulary {
  lists: VocabularyEntry[];
  projects: VocabularyEntry[];
  tags: VocabularyEntry[];
}

export interface OrganizeTarget {
  archived: boolean;
  kind: string;
  lists: string[];
  path: string;
  pinned: boolean;
  projects: string[];
  review: boolean;
  tags: string[];
  title: string;
}

/** ノートの分類はPropertiesだけを変える。フォルダ移動はしない。 */
export class OrganizeModal extends Modal {
  private readonly target: OrganizeTarget;
  private readonly properties: PropertyService;
  private readonly onSaved: () => void;
  private readonly vocabulary: OrganizeVocabulary;
  private kind: string;
  private tags: string;
  private lists: string;
  private projects: string;
  private pinned: boolean;
  private archived: boolean;
  private review: boolean;
  private statusEl: HTMLElement | null = null;
  private busy = false;

  constructor(
    app: App,
    properties: PropertyService,
    target: OrganizeTarget,
    onSaved: () => void,
    vocabulary: OrganizeVocabulary = { lists: [], projects: [], tags: [] }
  ) {
    super(app);
    this.properties = properties;
    this.target = target;
    this.onSaved = onSaved;
    this.vocabulary = vocabulary;
    this.kind = target.kind;
    this.tags = target.tags.join(", ");
    this.lists = target.lists.join(", ");
    this.projects = target.projects.join(", ");
    this.pinned = target.pinned;
    this.archived = target.archived;
    this.review = target.review;
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-organize-modal");
    this.setTitle("整理");
    this.contentEl.createEl("p", {
      cls: "seiton-prompt-hint",
      text: `${this.target.title} のPropertiesだけを変更します。ファイルは移動しません。`,
    });

    new Setting(this.contentEl)
      .setName("種類")
      .addText((text: TextComponent) => {
        text.setValue(this.kind).onChange((value) => {
          this.kind = value;
        });
      });
    let tagsText: TextComponent | null = null;
    new Setting(this.contentEl)
      .setName("タグ")
      .addText((text: TextComponent) => {
        tagsText = text;
        text
          .setPlaceholder("例: 認知科学, 読書")
          .setValue(this.tags)
          .onChange((value) => {
            this.tags = value;
          });
      });
    this.renderVocabRow(
      "タグ",
      this.vocabulary.tags,
      () => this.tags,
      (value) => {
        this.tags = value;
        tagsText?.setValue(value);
      }
    );
    let listsText: TextComponent | null = null;
    new Setting(this.contentEl)
      .setName("リスト")
      .addText((text: TextComponent) => {
        listsText = text;
        text
          .setPlaceholder("例: あとで読む")
          .setValue(this.lists)
          .onChange((value) => {
            this.lists = value;
          });
      });
    this.renderVocabRow(
      "リスト",
      this.vocabulary.lists,
      () => this.lists,
      (value) => {
        this.lists = value;
        listsText?.setValue(value);
      }
    );
    let projectsText: TextComponent | null = null;
    new Setting(this.contentEl)
      .setName("プロジェクト")
      .setDesc("プロジェクト名をカンマ区切りで入力します。")
      .addText((text: TextComponent) => {
        projectsText = text;
        text.setValue(this.projects).onChange((value) => {
          this.projects = value;
        });
      });
    this.renderVocabRow(
      "プロジェクト",
      this.vocabulary.projects,
      () => this.projects,
      (value) => {
        this.projects = value;
        projectsText?.setValue(value);
      }
    );
    new Setting(this.contentEl).setName("ピン留め").addToggle((toggle) => {
      toggle.setValue(this.pinned).onChange((value) => {
        this.pinned = value;
      });
    });
    new Setting(this.contentEl).setName("アーカイブ").addToggle((toggle) => {
      toggle.setValue(this.archived).onChange((value) => {
        this.archived = value;
      });
    });
    new Setting(this.contentEl)
      .setName("整理トレイ")
      .setDesc("あとで整理したい独立ノートだけオンにします。")
      .addToggle((toggle) => {
        toggle.setValue(this.review).onChange((value) => {
          this.review = value;
        });
      });

    this.statusEl = this.contentEl.createDiv({ cls: "seiton-modal-status" });
    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    new ButtonComponent(footer)
      .setButtonText("キャンセル")
      .onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText("保存")
      .setCta()
      .onClick(() => {
        void this.submit();
      });
  }

  private renderVocabRow(
    label: string,
    entries: VocabularyEntry[],
    current: () => string,
    apply: (value: string) => void
  ): void {
    const row = this.contentEl.createDiv({ cls: "seiton-vocab-row" });
    renderVocabularyChips(row, entries, {
      current: current().split(","),
      label: `既存の${label}`,
      onPick: (value) => apply(appendVocabularyValue(current(), value)),
    });
  }

  private async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.setStatus("保存中…");
    try {
      await this.properties.update(this.target.path, {
        archived: this.archived,
        kind: this.kind.trim() || null,
        lists: splitValues(this.lists),
        pinned: this.pinned,
        projects: splitValues(this.projects).map((value) => wikiLink(value)),
        review: this.review,
        tags: splitValues(this.tags).map((value) => value.replace(/^#/u, "")),
      });
      this.onSaved();
      this.close();
    } catch (error) {
      this.busy = false;
      this.setStatus(userMessageOf(error), true);
    }
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }
}

function splitValues(value: string): string[] {
  return value
    .split(/[,、]/u)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}
