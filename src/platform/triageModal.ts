import { type App, Modal, TFile } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { bodyAfterFrontmatter } from "../domain/frontmatter";
import type { PropertyValue } from "../services/propertyService";
import type { TriageService } from "../services/triageService";
import type { NoteRecord } from "../services/vaultIndex";
import { markSeitonModal } from "./ui/modal";

import { showToast } from "./ui/toast";

const KIND_CHOICES = [
  { key: "1", kind: "note", label: "ノート" },
  { key: "2", kind: "idea", label: "アイデア" },
  { key: "3", kind: "article", label: "記事" },
  { key: "4", kind: "task", label: "タスク" },
];

/** 未整理を1件ずつ確認し、種類・ピン・アーカイブを決める。 */
export class TriageModal extends Modal {
  private readonly triage: TriageService;
  private readonly onChanged: () => void;
  private queue: NoteRecord[] = [];
  private position = 0;
  private busy = false;
  private bodyEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private showFullText = false;
  private topTags: string[] = [];
  private projectList: Array<{ path: string; title: string }> = [];

  constructor(app: App, triage: TriageService, onChanged: () => void) {
    super(app);
    this.triage = triage;
    this.onChanged = onChanged;
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.modalEl.addClass("seiton-triage-modal");
    this.setTitle("未整理を1件ずつ");
    this.bodyEl = this.contentEl.createDiv({ cls: "seiton-triage-body" });
    this.statusEl = this.contentEl.createDiv({ cls: "seiton-triage-status" });
    this.statusEl.setAttribute("aria-live", "polite");
    this.registerKeys();
    void this.loadMetadataCache().then(() => this.reload());
  }

  override onClose(): void {
    this.contentEl.empty();
    this.bodyEl = null;
    this.statusEl = null;
    this.queue = [];
    this.showFullText = false;
  }

  private registerKeys(): void {
    this.scope.register([], "1", (event) => {
      event.preventDefault();
      void this.decideKind(KIND_CHOICES[0]?.kind ?? "note");
      return false;
    });
    this.scope.register([], "2", (event) => {
      event.preventDefault();
      void this.decideKind(KIND_CHOICES[1]?.kind ?? "idea");
      return false;
    });
    this.scope.register([], "3", (event) => {
      event.preventDefault();
      void this.decideKind(KIND_CHOICES[2]?.kind ?? "article");
      return false;
    });
    this.scope.register([], "4", (event) => {
      event.preventDefault();
      void this.decideKind(KIND_CHOICES[3]?.kind ?? "task");
      return false;
    });
    this.scope.register([], "p", (event) => {
      event.preventDefault();
      void this.decide({ pinned: true });
      return false;
    });
    this.scope.register([], "a", (event) => {
      event.preventDefault();
      void this.decide({ archived: true });
      return false;
    });
    this.scope.register([], "s", (event) => {
      event.preventDefault();
      this.advance();
      return false;
    });
    this.scope.register([], "u", (event) => {
      event.preventDefault();
      void this.undo();
      return false;
    });
    this.scope.register([], "Enter", (event) => {
      event.preventDefault();
      void this.openCurrent();
      return false;
    });
  }

  private async reload(targetPath?: string): Promise<void> {
    this.queue = await this.triage.queue();
    this.position = targetPath
      ? Math.max(
          0,
          this.queue.findIndex((note) => note.path === targetPath)
        )
      : Math.min(this.position, Math.max(0, this.queue.length - 1));
    this.render();
  }

  private current(): NoteRecord | null {
    return this.queue[this.position] ?? null;
  }

  private render(): void {
    const host = this.bodyEl;
    if (!host) {
      return;
    }
    host.empty();
    const note = this.current();
    if (!note) {
      host.createDiv({
        cls: "seiton-triage-done",
        text:
          this.queue.length === 0
            ? "未整理はありません。"
            : "この回の整理は完了しました。",
      });
      this.renderActions(host, false);
      this.setStatus("");
      return;
    }

    const progress = host.createDiv({ cls: "seiton-triage-progress" });
    progress.createSpan({
      text: `${this.position + 1} / ${this.queue.length}`,
    });
    progress.createSpan({ text: note.kind });

    host.createDiv({ cls: "seiton-triage-title", text: note.title });

    // 全文プレビュー / 抜粋トグル
    const textContainer = host.createDiv({ cls: "seiton-triage-content-box" });
    const toggleBtn = textContainer.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action seiton-triage-toggle-body",
      text: this.showFullText ? "抜粋表示に戻す" : "全文を表示",
    });
    const previewEl = textContainer.createDiv({
      cls: this.showFullText
        ? "seiton-triage-fulltext"
        : "seiton-triage-excerpt",
    });

    if (this.showFullText) {
      previewEl.setText("読み込み中…");
      void this.loadFullText(note, previewEl);
    } else {
      previewEl.setText(note.excerpt || "（本文なし）");
    }

    toggleBtn.addEventListener("click", () => {
      this.showFullText = !this.showFullText;
      this.render();
    });

    // タグ付与ピルバー（Vault頻出上位6件のトグル）
    if (this.topTags.length > 0) {
      const tagsSection = host.createDiv({
        cls: "seiton-triage-tags-section",
      });
      tagsSection.createSpan({
        cls: "seiton-triage-label",
        text: "タグ付与:",
      });
      const tagPills = tagsSection.createDiv({ cls: "seiton-triage-tags" });
      for (const tag of this.topTags) {
        const isActive = note.tags.includes(tag);
        const pill = tagPills.createEl("button", {
          attr: { "aria-pressed": String(isActive), type: "button" },
          cls: `seiton-triage-tag-pill${isActive ? " is-active" : ""}`,
          text: `#${tag}`,
        });
        pill.addEventListener("click", () => {
          void this.toggleTag(note, tag);
        });
      }
    }

    // プロジェクト割り当てセレクト
    if (this.projectList.length > 0) {
      const projectSection = host.createDiv({
        cls: "seiton-triage-project-section",
      });
      projectSection.createSpan({
        cls: "seiton-triage-label",
        text: "プロジェクト:",
      });
      const select = projectSection.createEl("select", {
        cls: "seiton-triage-project-select dropdown",
      });
      const emptyOption = select.createEl("option", {
        text: "プロジェクト未設定",
        value: "",
      });
      emptyOption.selected = note.projects.length === 0;

      const currentProject = note.projects[0] ?? "";
      for (const p of this.projectList) {
        const opt = select.createEl("option", {
          text: p.title,
          value: p.title,
        });
        if (currentProject === p.title) {
          opt.selected = true;
        }
      }
      select.addEventListener("change", () => {
        void this.setProject(note, select.value);
      });
    }

    const meta = [
      note.tags.length > 0 ? note.tags.map((tag) => `#${tag}`).join(" ") : "",
      note.projects.length > 0
        ? `プロジェクト: ${note.projects.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (meta) {
      host.createDiv({ cls: "seiton-triage-meta", text: meta });
    }

    this.renderActions(host, true);
    this.setStatus("1〜4: 種類 / p: ピン / a: アーカイブ / s: 保留 / u: 戻す");
  }

  private renderActions(host: HTMLElement, hasNote: boolean): void {
    const kinds = host.createDiv({ cls: "seiton-triage-kinds" });
    for (const choice of KIND_CHOICES) {
      const button = kinds.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-triage-kind",
        text: `${choice.label} ${choice.key}`,
      });
      button.disabled = !hasNote || this.busy;
      button.addEventListener("click", () => {
        void this.decideKind(choice.kind);
      });
    }

    const actions = host.createDiv({ cls: "seiton-triage-actions" });
    const decisions: Array<{
      label: string;
      patch: Record<string, PropertyValue>;
    }> = [
      { label: "整理済み", patch: {} },
      { label: "ピン", patch: { pinned: true } },
      { label: "アーカイブ", patch: { archived: true } },
    ];
    for (const decision of decisions) {
      const button = actions.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-triage-decision",
        text: decision.label,
      });
      button.disabled = !hasNote || this.busy;
      button.addEventListener("click", () => {
        void this.decide(decision.patch);
      });
    }
    const skip = actions.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "保留",
    });
    skip.disabled = !hasNote || this.busy;
    skip.addEventListener("click", () => this.advance());
    const undo = actions.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "戻す",
    });
    undo.disabled = this.busy || !this.triage.canUndo();
    undo.addEventListener("click", () => {
      void this.undo();
    });
    const close = actions.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "閉じる",
    });
    close.addEventListener("click", () => this.close());
  }

  private async decideKind(kind: string): Promise<void> {
    await this.decide({ kind });
  }

  private async decide(patch: Record<string, PropertyValue>): Promise<void> {
    if (this.busy) {
      return;
    }
    const note = this.current();
    if (!note) {
      return;
    }
    this.busy = true;
    this.setStatus("保存中…");
    try {
      await this.triage.decide(note, patch);
      this.onChanged();
      this.position += 1;
      this.showFullText = false;
      this.render();
    } catch (error) {
      showToast(userMessageOf(error));
      this.setStatus("保存できませんでした。");
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private advance(): void {
    if (!this.current()) {
      return;
    }
    this.showFullText = false;
    this.position += 1;
    this.render();
  }

  private async undo(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const path = await this.triage.undo();
      if (path) {
        this.onChanged();
        this.showFullText = false;
        await this.reload(path);
      }
    } catch (error) {
      showToast(userMessageOf(error));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async loadMetadataCache(): Promise<void> {
    const counts = new Map<string, number>();
    const rawTags = (
      this.app.metadataCache as unknown as {
        getTags?: () => Record<string, number>;
      }
    ).getTags?.();
    if (rawTags && Object.keys(rawTags).length > 0) {
      for (const [tag, count] of Object.entries(rawTags)) {
        const clean = tag.replace(/^#/u, "").trim();
        if (clean) {
          counts.set(clean, (counts.get(clean) ?? 0) + count);
        }
      }
    } else {
      for (const file of this.app.vault.getMarkdownFiles()) {
        const cache = this.app.metadataCache.getFileCache(file);
        const tags = cache?.frontmatter?.tags;
        if (Array.isArray(tags)) {
          for (const t of tags) {
            if (typeof t === "string") {
              const clean = t.replace(/^#/u, "").trim();
              if (clean) {
                counts.set(clean, (counts.get(clean) ?? 0) + 1);
              }
            }
          }
        }
      }
    }
    this.topTags = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map((e) => e[0]);

    const projects: Array<{ path: string; title: string }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (
        fm &&
        (fm.kind === "project" || fm.type === "project") &&
        !fm.archived
      ) {
        const title =
          typeof fm.title === "string" && fm.title.trim()
            ? fm.title.trim()
            : file.basename;
        projects.push({ path: file.path, title });
      }
    }
    this.projectList = projects.sort((a, b) =>
      a.title.localeCompare(b.title, "ja")
    );
  }

  private async loadFullText(note: NoteRecord, el: HTMLElement): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(note.path);
      if (file instanceof TFile) {
        const content = await this.app.vault.cachedRead(file);
        const body = bodyAfterFrontmatter(content).trim();
        el.setText(body || "（本文なし）");
      }
    } catch {
      el.setText(note.excerpt || "（読み込み失敗）");
    }
  }

  private async toggleTag(note: NoteRecord, tag: string): Promise<void> {
    const exists = note.tags.includes(tag);
    const nextTags = exists
      ? note.tags.filter((t) => t !== tag)
      : [...note.tags, tag];
    note.tags = nextTags;
    try {
      const file = this.app.vault.getAbstractFileByPath(note.path);
      if (file instanceof TFile) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          if (nextTags.length > 0) {
            fm.tags = nextTags;
          } else {
            delete fm.tags;
          }
        });
        showToast(`タグ「#${tag}」を${exists ? "解除" : "追加"}しました`);
        this.render();
      }
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  private async setProject(
    note: NoteRecord,
    projectName: string
  ): Promise<void> {
    const val = projectName.trim();
    note.projects = val ? [val] : [];
    try {
      const file = this.app.vault.getAbstractFileByPath(note.path);
      if (file instanceof TFile) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          if (val) {
            fm.project = val;
          } else {
            delete fm.project;
          }
        });
        showToast(
          val
            ? `プロジェクト「${val}」に割り当てました`
            : "プロジェクト設定を解除しました"
        );
        this.render();
      }
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  private async openCurrent(): Promise<void> {
    const note = this.current();
    if (!note) {
      return;
    }
    this.close();
    await this.triage.open(note);
  }

  private setStatus(message: string): void {
    this.statusEl?.setText(message);
  }
}
