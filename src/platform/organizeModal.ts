import type { App } from "obsidian";
import { Modal } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { wikiLink } from "../domain/links";
import type { VocabularyEntry } from "../domain/vocabulary";
import type { PropertyService } from "../services/propertyService";
import { button, fieldRow, textField, toggleField } from "./ui/field";
import { buildSeitonModal } from "./ui/modal";
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
    const { body, footer } = buildSeitonModal(this, {
      description: `${this.target.title} のPropertiesだけを変更します。ファイルは移動しません。`,
      title: "整理",
    });

    textField(body, {
      label: "種類",
      onChange: (value) => {
        this.kind = value;
      },
      value: this.kind,
    });

    this.vocabularyField(
      body,
      "タグ",
      "例: 認知科学, 読書",
      () => this.tags,
      this.vocabulary.tags,
      (value) => {
        this.tags = value;
      }
    );
    this.vocabularyField(
      body,
      "リスト",
      "例: あとで読む",
      () => this.lists,
      this.vocabulary.lists,
      (value) => {
        this.lists = value;
      }
    );
    this.vocabularyField(
      body,
      "プロジェクト",
      "プロジェクト名をカンマ区切りで入力します。",
      () => this.projects,
      this.vocabulary.projects,
      (value) => {
        this.projects = value;
      }
    );

    toggleField(body, {
      label: "ピン留め",
      onChange: (value) => {
        this.pinned = value;
      },
      value: this.pinned,
    });
    toggleField(body, {
      label: "アーカイブ",
      onChange: (value) => {
        this.archived = value;
      },
      value: this.archived,
    });
    toggleField(body, {
      description: "あとで整理したい独立ノートだけオンにします。",
      label: "整理トレイ",
      onChange: (value) => {
        this.review = value;
      },
      value: this.review,
    });

    this.statusEl = body.createDiv({ cls: "st-status" });

    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });
    button(footer, {
      label: "保存",
      onClick: () => {
        void this.submit();
      },
      tone: "primary",
    });
  }

  private vocabularyField(
    parent: HTMLElement,
    label: string,
    placeholder: string,
    current: () => string,
    entries: VocabularyEntry[],
    apply: (value: string) => void
  ): HTMLInputElement {
    const row = fieldRow(parent, { label });
    const input = row.createEl("input", { cls: "st-input", type: "text" });
    input.placeholder = placeholder;
    input.value = current();
    input.addEventListener("input", () => apply(input.value));

    const chips = row.createDiv({ cls: "seiton-vocab-row" });
    renderVocabularyChips(chips, entries, {
      current: current().split(","),
      label: `既存の${label}`,
      onPick: (value) => {
        const next = appendVocabularyValue(current(), value);
        apply(next);
        input.value = next;
      },
    });
    return input;
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
