import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import { userMessageOf } from "../domain/errors";
import type { PropertyValue } from "../services/propertyService";
import type { TriageService } from "../services/triageService";
import type { NoteRecord } from "../services/vaultIndex";

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

  constructor(app: App, triage: TriageService, onChanged: () => void) {
    super(app);
    this.triage = triage;
    this.onChanged = onChanged;
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-triage-modal");
    this.setTitle("未整理を1件ずつ");
    this.bodyEl = this.contentEl.createDiv({ cls: "seiton-triage-body" });
    this.statusEl = this.contentEl.createDiv({ cls: "seiton-triage-status" });
    this.statusEl.setAttribute("aria-live", "polite");
    this.registerKeys();
    void this.reload();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.bodyEl = null;
    this.statusEl = null;
    this.queue = [];
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
    if (note.excerpt) {
      host.createDiv({ cls: "seiton-triage-excerpt", text: note.excerpt });
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
      this.render();
    } catch (error) {
      new Notice(userMessageOf(error));
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
        await this.reload(path);
      }
    } catch (error) {
      new Notice(userMessageOf(error));
    } finally {
      this.busy = false;
      this.render();
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
