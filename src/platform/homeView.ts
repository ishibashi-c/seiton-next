/**
 * Seiton ホーム。常設の一言メモ入力と、複数週をまたぐタイムライン。
 * 主要3導線のうち、ライブラリ・プロジェクトは後続フェーズで追加する。
 */

import type { EventRef, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { ItemView, TFile } from "obsidian";
import {
  MEMOS_FOLDER,
  NOTES_FOLDER,
  PROMPTS_FOLDER,
  VIEW_TYPE_HOME,
  VIEW_TYPE_PROJECTS,
  VIEW_TYPE_PROMPT,
} from "../config";
import { userMessageOf } from "../domain/errors";
import { weekIdOf } from "../domain/isoWeek";
import { dateKeyOf } from "../domain/time";
import type { LinkListService } from "../services/linkListService";
import type { MemoService } from "../services/memoService";
import type { NoteService } from "../services/noteService";
import type { PromptService } from "../services/promptService";
import type { SeitonSettings } from "../services/settings";
import type { VaultIndexService } from "../services/vaultIndex";
import { HomeCapture } from "./home/capture";
import { HomeSections } from "./home/sections";
import { HomeShortcuts } from "./home/shortcuts";
import { MemoCaptureModal } from "./memoCaptureModal";
import { NewNoteModal } from "./newNoteModal";
import { SeitonProjectsView } from "./projectsView";
import { PromptWorkbenchView } from "./promptView";
import { openSeitonView } from "./seitonNav";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import { showToast } from "./ui/toast";

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  day: "numeric",
  month: "long",
  weekday: "long",
  year: "numeric",
});

export class SeitonHomeView extends ItemView {
  private readonly memoService: MemoService;
  private readonly indexService: VaultIndexService;
  private readonly promptService: PromptService;
  private readonly notes: NoteService;
  private starterEl: HTMLElement | null = null;
  private sublineEl: HTMLElement | null = null;
  private sublineText = "";
  private readonly capture: HomeCapture;
  private readonly shortcuts: HomeShortcuts;
  private readonly sections: HomeSections;
  private refreshing = false;
  private refreshAgain = false;
  private refreshTimer: number | null = null;
  private eventRefs: EventRef[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    memoService: MemoService,
    indexService: VaultIndexService,
    promptService: PromptService,
    notes: NoteService,
    getSettings: () => SeitonSettings,
    links: LinkListService
  ) {
    super(leaf);
    this.memoService = memoService;
    this.indexService = indexService;
    this.promptService = promptService;
    this.notes = notes;
    this.shortcuts = new HomeShortcuts({
      app: this.app,
      favicons: () => getSettings().shortcutFavicons,
      links,
      openPath: (path) => {
        void this.openPath(path);
      },
    });
    this.sections = new HomeSections({
      app: this.app,
      openPath: (path) => {
        void this.openPath(path);
      },
      openProject: (path) => {
        void this.openProject(path);
      },
      openPromptSession: (path) => {
        void this.openPromptSession(path);
      },
    });
    this.capture = new HomeCapture({
      app: this.app,
      memoService,
      onCleared: () => this.shortcuts.clear(),
      onRefresh: () => this.refresh(),
    });
  }

  override getViewType(): string {
    return VIEW_TYPE_HOME;
  }

  override getDisplayText(): string {
    return "Seiton ホーム";
  }

  override getIcon(): string {
    return "notebook";
  }

  override async onOpen(): Promise<void> {
    const week = weekIdOf(new Date());
    const subline = `${LONG_DATE_FORMATTER.format(new Date())} · ${week}`;
    const { body: content, header } = mountTabShell(this, {
      actions: [
        {
          kind: "text",
          label: "新規ノート",
          onClick: () => {
            new NewNoteModal(
              this.app,
              this.notes,
              this.indexService,
              "",
              (path) => {
                void this.openPath(path);
                this.indexService.invalidate();
                this.scheduleRefresh();
              }
            ).open();
          },
        },
        {
          ariaLabel: "再読み込み",
          icon: "refresh-cw",
          kind: "icon",
          label: "再読み込み",
          onClick: () => {
            void this.refresh();
          },
        },
      ],
      fab: {
        icon: "square-pen",
        label: "メモを書く",
        onClick: () => {
          new MemoCaptureModal(this.app, this.memoService, {
            onSaved: () => {
              void this.refresh();
            },
          }).open();
        },
      },
      subline,
      tab: "home",
      title: "今日",
    });
    content.addClass("seiton-home-content");
    this.sublineEl = header.sublineEl;
    this.sublineText = subline;

    this.renderHomeBody(content);

    this.registerVaultEvents();
    await this.refresh();
    finishTabShell(this, VIEW_TYPE_HOME);
  }

  override async onClose(): Promise<void> {
    closeTabShell(this, VIEW_TYPE_HOME);
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];
    this.contentEl.empty();
    this.capture.reset();
    this.starterEl = null;
    this.sections.reset();
    this.shortcuts.reset();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const [result, index, sessionList] = await Promise.all([
        this.memoService.listAll(),
        this.indexService.get(),
        this.promptService.listSessions().catch(() => ({
          problems: [],
          sessions: [],
        })),
      ]);
      if (this.starterEl) {
        const isEmpty =
          index.notes.length === 0 &&
          result.items.filter((item) => item.entry.state !== "deleted")
            .length === 0;
        this.starterEl.style.display = isEmpty ? "" : "none";
      }
      void this.shortcuts.reload();
      this.setDayCount(result.items);
      this.sections.renderResume(index, sessionList.sessions);
      this.sections.renderFavorites(index);
      this.sections.renderRecent(index);
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

  /** 今日のメモ件数を、補足行の右に1つだけ色付きで出す。 */
  private setDayCount(
    items: Array<{ entry: { at: string; state: string } }>
  ): void {
    const subline = this.sublineEl;
    if (!subline) {
      return;
    }
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const count = items.filter(
      (item) =>
        item.entry.state !== "deleted" && dateKeyOf(item.entry.at) === key
    ).length;
    subline.empty();
    subline.createSpan({ text: this.sublineText });
    if (count > 0) {
      subline.createSpan({
        cls: "seiton-page-count",
        text: `今日 ${count}件`,
      });
    }
  }

  private async runCommand(id: string): Promise<void> {
    const commands = (
      this.app as unknown as {
        commands?: {
          executeCommandById: (commandId: string) => Promise<unknown>;
        };
      }
    ).commands;
    await commands?.executeCommandById(id);
  }

  private renderHomeBody(content: HTMLElement): void {
    this.renderQuick(content);

    const shortcutsSection = content.createDiv({
      cls: "seiton-zone seiton-shortcuts-zone is-minor",
    });
    shortcutsSection.createEl("h2", { text: "ショートカット" });
    const shortcutsEl = shortcutsSection.createDiv({
      cls: "seiton-shortcuts",
    });
    this.shortcuts.render(shortcutsEl);

    const starter = content.createDiv({ cls: "seiton-starter" });
    // 索引の構築が終わるまでは「はじめに」を出さない。記録のあるVaultで
    // 一瞬だけ初回導線がちらつくのを防ぐ。
    starter.style.display = "none";
    starter.createEl("h2", { text: "はじめに" });
    starter.createDiv({
      cls: "seiton-starter-text",
      text: "メモを残す、ノートを作る、本を追加する。まずは1つから。",
    });
    const starterActions = starter.createDiv({ cls: "seiton-starter-actions" });
    const startMemo = starterActions.createEl("button", {
      cls: "seiton-primary-text",
      text: "メモを残す",
      type: "button",
    });
    startMemo.addEventListener("click", () => {
      this.capture.focus();
    });
    const startNote = starterActions.createEl("button", {
      cls: "seiton-text-action",
      text: "ノートを作る",
      type: "button",
    });
    startNote.addEventListener("click", () => {
      void this.runCommand("seiton-next:new-note");
    });
    const startBook = starterActions.createEl("button", {
      cls: "seiton-text-action",
      text: "本を追加",
      type: "button",
    });
    startBook.addEventListener("click", () => {
      void this.runCommand("seiton-next:add-book");
    });
    this.starterEl = starter;

    const resumeSection = content.createDiv({
      cls: "seiton-zone seiton-home-section seiton-home-resume",
    });
    const resumeHead = resumeSection.createDiv({ cls: "seiton-zone-head" });
    resumeHead.createEl("h2", { text: "続きから" });
    const resumeCount = resumeHead.createSpan({ cls: "seiton-zone-count" });
    const resumeBody = resumeSection.createDiv({
      cls: "seiton-home-section-body seiton-resume",
    });

    const recentSection = content.createDiv({
      cls: "seiton-zone seiton-home-section seiton-home-recent",
    });
    const recentHead = recentSection.createDiv({ cls: "seiton-zone-head" });
    recentHead.createEl("h2", { text: "最近の記録" });
    const recentCount = recentHead.createSpan({ cls: "seiton-zone-count" });
    const recentBody = recentSection.createDiv({
      cls: "seiton-home-section-body seiton-home-cards",
    });

    const favoritesSection = content.createDiv({
      cls: "seiton-zone seiton-home-section seiton-home-favorites is-minor",
    });
    const favoritesHead = favoritesSection.createDiv({
      cls: "seiton-zone-head",
    });
    favoritesHead.createEl("h2", { text: "よく使うもの" });
    const favoritesCount = favoritesHead.createSpan({
      cls: "seiton-zone-count",
    });
    const favoritesBody = favoritesSection.createDiv({
      cls: "seiton-home-section-body seiton-home-cards",
    });

    this.sections.attach({
      favoritesBody,
      favoritesCount,
      favoritesSection,
      recentBody,
      recentCount,
      recentSection,
      resumeBody,
      resumeCount,
      resumeSection,
    });
  }

  private renderQuick(parent: HTMLElement): void {
    const section = parent.createDiv({
      cls: "seiton-zone seiton-home-section seiton-home-quick",
    });
    section.createEl("h2", { text: "すぐ記録" });
    this.capture.render(section);
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private async openProject(path: string): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROJECTS);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
    const view = leaf?.view;
    if (view instanceof SeitonProjectsView) {
      await view.selectProject(path);
    }
  }

  private async openPromptSession(path: string): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROMPT);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROMPT)[0];
    const view = leaf?.view;
    if (view instanceof PromptWorkbenchView) {
      await view.openPath(path);
    }
  }

  private registerVaultEvents(): void {
    const onFileChange = (file: TAbstractFile): void => {
      if (
        file.path.startsWith(`${MEMOS_FOLDER}/`) ||
        file.path.startsWith(`${NOTES_FOLDER}/`) ||
        file.path.startsWith(`${PROMPTS_FOLDER}/`)
      ) {
        this.indexService.invalidate();
        this.scheduleRefresh();
      }
    };
    const onFileOpen = (file: TFile | null): void => {
      if (file?.path.startsWith(`${NOTES_FOLDER}/`)) {
        this.scheduleRefresh();
      }
    };
    this.eventRefs.push(
      this.app.vault.on("modify", onFileChange),
      this.app.vault.on("create", onFileChange),
      this.app.vault.on("delete", onFileChange),
      this.app.vault.on("rename", onFileChange),
      this.app.workspace.on("file-open", onFileOpen)
    );
    for (const ref of this.eventRefs) {
      this.registerEvent(ref);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 250);
  }
}
