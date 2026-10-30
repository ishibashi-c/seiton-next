import type { App, EventRef, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { ItemView, Modal, TFile } from "obsidian";
import { VIEW_TYPE_PROJECTS } from "../config";
import { userMessageOf } from "../domain/errors";
import { normalizeLink, wikiLink } from "../domain/links";
import type { NoteService } from "../services/noteService";
import type { PromptService } from "../services/promptService";
import type { PropertyService } from "../services/propertyService";
import type { NoteRecord, VaultIndex } from "../services/vaultIndex";
import { allProjects, type VaultIndexService } from "../services/vaultIndex";
import { ProjectsRenderer } from "./projects/view";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import { markSeitonModal } from "./ui/modal";
import { Setting, type TextComponent } from "./ui/setting";

import { showToast } from "./ui/toast";
export interface ProjectsHost {
  openPrompt(path: string): void;
}

export class SeitonProjectsView extends ItemView {
  private readonly indexService: VaultIndexService;
  private readonly properties: PropertyService;
  private readonly notes: NoteService;
  private readonly prompts: PromptService;
  private readonly host: ProjectsHost;
  private readonly renderer: ProjectsRenderer;
  private selectedPath: string | null = null;
  private bodyEl: HTMLElement | null = null;
  private eventRefs: EventRef[] = [];
  private refreshTimer: number | null = null;
  private refreshing = false;
  private refreshAgain = false;

  constructor(
    leaf: WorkspaceLeaf,
    indexService: VaultIndexService,
    properties: PropertyService,
    notes: NoteService,
    prompts: PromptService,
    host: ProjectsHost
  ) {
    super(leaf);
    this.indexService = indexService;
    this.properties = properties;
    this.notes = notes;
    this.prompts = prompts;
    this.host = host;
    this.renderer = new ProjectsRenderer({
      app: this.app,
      host,
      indexService,
      notes,
      onCreateSession: (project) => this.createSession(project),
      onInvalidate: () => this.invalidateAndRefresh(),
      onLinkNotes: (index, project) => this.openLinkNotes(index, project),
      onOpenPath: (path) => this.openPath(path),
      onSelect: (path) => {
        this.selectedPath = path;
        void this.refresh();
      },
      onToggleArchived: (project) => this.toggleArchived(project),
      onUnlink: (notePath, project) => this.unlink(notePath, project),
      prompts,
    });
  }

  override getViewType(): string {
    return "seiton-next-projects";
  }

  override getDisplayText(): string {
    return "Seiton プロジェクト";
  }

  override getIcon(): string {
    return "folder-kanban";
  }

  override async onOpen(): Promise<void> {
    const { body } = mountTabShell(this, {
      actions: [
        {
          kind: "primary",
          label: "新規プロジェクト",
          onClick: () => this.openNewProject(),
        },
      ],
      fab: {
        icon: "plus",
        label: "新規プロジェクト",
        onClick: () => this.openNewProject(),
      },
      rootClasses: ["seiton-home", "seiton-projects"],
      tab: "projects",
      title: "プロジェクト",
    });
    body.addClass("seiton-projects-body");
    this.bodyEl = body;
    this.registerVaultEvents();
    await this.refresh();
    finishTabShell(this, VIEW_TYPE_PROJECTS);
  }

  override async onClose(): Promise<void> {
    closeTabShell(this, VIEW_TYPE_PROJECTS);
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];
    this.contentEl.empty();
    this.bodyEl = null;
  }

  async selectProject(path: string): Promise<void> {
    this.selectedPath = path;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const index = await this.indexService.get();
      if (!this.bodyEl) {
        return;
      }
      const projects = allProjects(index);
      if (this.selectedPath) {
        const selected = projects.find(
          (project) => project.path === this.selectedPath
        );
        if (selected) {
          await this.renderer.renderDetail(this.bodyEl, index, selected);
          return;
        }
        this.selectedPath = null;
      }
      await this.renderer.renderList(this.bodyEl, index, projects);
    } catch (error) {
      showToast(userMessageOf(error));
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  private openNewProject(): void {
    new NewProjectModal(this.app, this.notes, (path) => {
      this.selectedPath = path;
      this.invalidateAndRefresh();
    }).open();
  }

  private openLinkNotes(index: VaultIndex, project: NoteRecord): void {
    new LinkNoteModal(this.app, index, project, this.properties, () =>
      this.invalidateAndRefresh()
    ).open();
  }

  private async createSession(project: NoteRecord): Promise<void> {
    try {
      const session = await this.prompts.createSession({
        project: project.title,
        title: `${project.title} セッション`,
      });
      this.host.openPrompt(session.path);
      this.invalidateAndRefresh();
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  private async toggleArchived(project: NoteRecord): Promise<void> {
    try {
      await this.properties.update(project.path, {
        archived: !project.archived,
      });
      this.invalidateAndRefresh();
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  private async unlink(notePath: string, project: NoteRecord): Promise<void> {
    try {
      await this.properties.removeLink(
        notePath,
        "projects",
        wikiLink(project.title)
      );
      this.invalidateAndRefresh();
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      showToast("ファイルが見つかりません。");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private invalidateAndRefresh(): void {
    this.indexService.invalidate();
    void this.refresh();
  }

  private registerVaultEvents(): void {
    const handler = (file: TAbstractFile): void => {
      if (!file.path.endsWith(".md")) {
        return;
      }
      this.indexService.invalidate();
      if (this.refreshTimer !== null) {
        window.clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        void this.refresh();
      }, 450);
    };
    this.eventRefs.push(
      this.app.vault.on("modify", handler),
      this.app.vault.on("create", handler),
      this.app.vault.on("delete", handler),
      this.app.vault.on("rename", handler)
    );
    for (const ref of this.eventRefs) {
      this.registerEvent(ref);
    }
  }
}

class NewProjectModal extends Modal {
  private readonly notes: NoteService;
  private readonly onCreated: (path: string) => void;
  private title = "";
  private statusEl: HTMLElement | null = null;
  private busy = false;

  constructor(app: App, notes: NoteService, onCreated: (path: string) => void) {
    super(app);
    this.notes = notes;
    this.onCreated = onCreated;
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.setTitle("新しいプロジェクト");
    this.contentEl.createEl("p", {
      cls: "seiton-prompt-hint",
      text: "1プロジェクト = 1 Markdown。目的や経緯は標準エディターで書きます。",
    });
    new Setting(this.contentEl)
      .setName("プロジェクト名")
      .addText((text: TextComponent) => {
        text.onChange((value) => {
          this.title = value;
        });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });
    this.statusEl = this.contentEl.createDiv({ cls: "seiton-modal-status" });
    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const cancel = footer.createEl("button", { text: "キャンセル" });
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    const create = footer.createEl("button", {
      cls: "mod-cta",
      text: "作成",
    });
    create.type = "button";
    create.addEventListener("click", () => {
      void this.submit();
    });
  }

  private async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (this.title.trim() === "") {
      this.setStatus("プロジェクト名を入力してください。", true);
      return;
    }
    this.busy = true;
    this.setStatus("作成中…");
    try {
      const path = await this.notes.createProject(this.title);
      this.onCreated(path);
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

class LinkNoteModal extends Modal {
  private readonly index: VaultIndex;
  private readonly project: NoteRecord;
  private readonly properties: PropertyService;
  private readonly onLinked: () => void;
  private query = "";

  constructor(
    app: App,
    index: VaultIndex,
    project: NoteRecord,
    properties: PropertyService,
    onLinked: () => void
  ) {
    super(app);
    this.index = index;
    this.project = project;
    this.properties = properties;
    this.onLinked = onLinked;
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.setTitle(`「${this.project.title}」に関連付ける`);
    const search = this.contentEl.createEl("input", {
      attr: { placeholder: "ノートを検索", type: "search" },
      cls: "seiton-library-search",
    });
    const list = this.contentEl.createDiv({ cls: "seiton-link-list" });
    const render = (): void => {
      list.empty();
      const query = this.query.toLowerCase();
      const notes = this.index.notes
        .filter((note) => note.path !== this.project.path)
        .filter((note) => note.kind !== "project")
        .filter(
          (note) =>
            query === "" ||
            note.title.toLowerCase().includes(query) ||
            note.path.toLowerCase().includes(query)
        )
        .slice(0, 50);
      if (notes.length === 0) {
        list.createDiv({ cls: "seiton-empty", text: "候補がありません。" });
        return;
      }
      for (const note of notes) {
        const row = list.createDiv({ cls: "seiton-link-row" });
        row.createDiv({ cls: "seiton-li-title", text: note.title });
        row.createDiv({ cls: "seiton-session-row-meta", text: note.path });
        const already = note.projects.some(
          (value) => normalizeLink(value) === normalizeLink(this.project.title)
        );
        const button = row.createEl("button", {
          cls: "seiton-li-action",
          text: already ? "関連付け済み" : "関連付ける",
        });
        button.type = "button";
        button.disabled = already;
        button.addEventListener("click", () => {
          void this.link(note.path, button);
        });
      }
    };
    search.addEventListener("input", () => {
      this.query = search.value;
      render();
    });
    render();
  }

  private async link(path: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await this.properties.appendLink(
        path,
        "projects",
        wikiLink(this.project.title)
      );
      button.setText("関連付け済み");
      this.onLinked();
    } catch (error) {
      button.disabled = false;
      showToast(userMessageOf(error));
    }
  }
}
