import { type App, TFile } from "obsidian";
import { normalizeLink } from "../../domain/links";
import { domainOf } from "../../domain/network";
import {
  countSessionsByProject,
  extractMarkdownTasks,
  extractProjectLinks,
  normalizeProjectStatus,
  type ProjectStatus,
  type ProjectTask,
  projectTagName,
  relatedMemosForProject,
  resolveNextAction,
} from "../../domain/projects";
import type { NoteService } from "../../services/noteService";
import type { PromptService } from "../../services/promptService";
import type {
  NoteRecord,
  VaultIndex,
  VaultIndexService,
} from "../../services/vaultIndex";
import { makeCardClickable } from "../cardClick";
import { NewNoteModal } from "../newNoteModal";

export interface ProjectsRendererHost {
  openPrompt(path: string): void;
}

export interface ProjectsRendererOptions {
  app: App;
  host: ProjectsRendererHost;
  indexService: VaultIndexService;
  notes: NoteService;
  onAddLink: (project: NoteRecord, label: string, url: string) => Promise<void>;
  onAddProjectMemo: (project: NoteRecord, text: string) => Promise<void>;
  onAddTask: (project: NoteRecord, text: string) => Promise<void>;
  onChangeStatus: (project: NoteRecord, status: ProjectStatus) => Promise<void>;
  onCreateSession: (project: NoteRecord) => Promise<void>;
  onInvalidate: () => void;
  onLinkNotes: (index: VaultIndex, project: NoteRecord) => void;
  onOpenPath: (path: string) => Promise<void>;
  onRemoveLink: (project: NoteRecord, url: string) => Promise<void>;
  onSelect: (path: string | null) => void;
  onSetNextAction: (project: NoteRecord, nextAction: string) => Promise<void>;
  onToggleTask: (task: ProjectTask) => Promise<void>;
  onUnlink: (notePath: string, project: NoteRecord) => Promise<void>;
  prompts: PromptService;
}

const KIND_LABEL: Record<string, string> = {
  article: "記事",
  book: "本",
  class: "授業",
  collection: "コレクション",
  idea: "アイデア",
  "migration-log": "移行ログ",
  note: "ノート",
  profile: "プロフィール",
  project: "プロジェクト",
  reading: "読書",
  task: "タスク",
  webclip: "Web",
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: "進行中",
  done: "完了",
  paused: "保留",
};

type ListStatusFilter = ProjectStatus | "all";

function shortMemoDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 10);
  }
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${m}/${d} ${hh}:${mm}`;
}

export class ProjectsRenderer {
  private readonly options: ProjectsRendererOptions;
  private listFilter: ListStatusFilter = "active";
  private userPickedFilter = false;

  constructor(options: ProjectsRendererOptions) {
    this.options = options;
  }

  async renderList(
    body: HTMLElement,
    index: VaultIndex,
    projects: NoteRecord[]
  ): Promise<void> {
    body.empty();
    if (projects.length === 0) {
      const empty = body.createDiv({ cls: "seiton-empty" });
      empty.setText(
        "プロジェクトがありません。ワンテーマごとに1つの箱を作って、タスク・リンク・メモを集められます。"
      );
      return;
    }

    let sessionsByProject = new Map<string, number>();
    try {
      const sessions = (await this.options.prompts.listSessions()).sessions;
      sessionsByProject = countSessionsByProject(sessions);
    } catch {
      // セッション数が取れなくてもプロジェクト一覧は表示する。
    }

    const withStatus = projects.map((project) => ({
      project,
      status: normalizeProjectStatus(project.frontmatter, project.archived),
    }));

    const counts: Record<ListStatusFilter, number> = {
      active: withStatus.filter((p) => p.status === "active").length,
      all: withStatus.length,
      done: withStatus.filter((p) => p.status === "done").length,
      paused: withStatus.filter((p) => p.status === "paused").length,
    };

    if (!this.userPickedFilter && counts.active === 0 && counts.all > 0) {
      this.listFilter = "all";
    }

    const toolbar = body.createDiv({ cls: "seiton-project-toolbar" });
    const termRow = toolbar.createDiv({ cls: "seiton-project-term-row" });
    const filterBar = termRow.createDiv({ cls: "seiton-project-term-tabs" });
    const filterChoices: Array<{ id: ListStatusFilter; label: string }> = [
      { id: "active", label: "進行中" },
      { id: "paused", label: "保留" },
      { id: "done", label: "完了" },
      { id: "all", label: "すべて" },
    ];
    for (const choice of filterChoices) {
      const btn = filterBar.createEl("button", {
        attr: { type: "button" },
        cls: `seiton-project-term-tab${this.listFilter === choice.id ? " is-active" : ""}`,
      });
      btn.createSpan({ text: choice.label });
      btn.createSpan({
        cls: "seiton-project-term-count",
        text: String(counts[choice.id]),
      });
      btn.addEventListener("click", () => {
        this.userPickedFilter = true;
        this.listFilter = choice.id;
        void this.renderList(body, index, projects);
      });
    }

    const visible = withStatus.filter(
      (entry) => this.listFilter === "all" || entry.status === this.listFilter
    );

    const summaryEl = termRow.createDiv({ cls: "seiton-project-summary" });
    summaryEl.createSpan({
      cls: "seiton-project-summary-num",
      text: String(visible.length),
    });
    const activeFilterLabel =
      filterChoices.find((c) => c.id === this.listFilter)?.label ?? "すべて";
    summaryEl.createSpan({
      cls: "seiton-project-summary-label",
      text: `件のプロジェクト（${activeFilterLabel}）`,
    });

    if (visible.length === 0) {
      body.createDiv({
        cls: "seiton-empty",
        text: "この状態のプロジェクトはありません。",
      });
      return;
    }

    const list = body.createDiv({ cls: "seiton-project-list" });
    for (const { project, status } of visible) {
      const article = document.createElement("article");
      article.className = `seiton-project-item is-${status}`;
      const content = article.createDiv({ cls: "seiton-item-content" });

      const kicker = content.createDiv({ cls: "seiton-item-kicker" });
      kicker.createSpan({
        cls: `seiton-project-status-badge is-${status}`,
        text: STATUS_LABEL[status],
      });

      const title = content.createEl("button", {
        cls: "seiton-item-title",
        text: project.title,
      });
      title.type = "button";
      title.addEventListener("click", () => {
        this.options.onSelect(project.path);
      });

      const nextAction =
        typeof project.frontmatter.next_action === "string"
          ? project.frontmatter.next_action.trim()
          : "";
      if (nextAction) {
        const nextRow = content.createDiv({ cls: "seiton-project-card-next" });
        nextRow.createSpan({
          cls: "seiton-project-card-next-label",
          text: "次",
        });
        nextRow.createSpan({ text: nextAction });
      }

      if (project.excerpt) {
        content.createDiv({
          cls: "seiton-item-excerpt",
          text: project.excerpt,
        });
      }

      const related = relatedNotes(index, project).length;
      const memoCount = relatedMemosForProject(
        index.memos,
        project.title
      ).length;
      const projectKey = normalizeLink(project.title);
      const sessions = sessionsByProject.get(projectKey) ?? 0;
      content.createDiv({
        cls: "seiton-item-meta",
        text: `ノート ${related}件 · つぶやき ${memoCount}件 · セッション ${sessions}件`,
      });

      const actions = content.createDiv({ cls: "seiton-item-actions" });
      const detail = actions.createEl("button", {
        cls: "seiton-item-action",
        text: "開く",
      });
      detail.type = "button";
      detail.addEventListener("click", () => {
        this.options.onSelect(project.path);
      });
      const open = actions.createEl("button", {
        cls: "seiton-item-action",
        text: "ノートを編集",
      });
      open.type = "button";
      open.addEventListener("click", () => {
        void this.options.onOpenPath(project.path);
      });
      makeCardClickable(article, () => {
        this.options.onSelect(project.path);
      });
      list.appendChild(article);
    }
  }

  async renderDetail(
    body: HTMLElement,
    index: VaultIndex,
    project: NoteRecord
  ): Promise<void> {
    body.empty();
    const back = body.createEl("button", {
      cls: "seiton-back",
      text: "← プロジェクト一覧",
    });
    back.type = "button";
    back.addEventListener("click", () => {
      this.options.onSelect(null);
    });

    const status = normalizeProjectStatus(
      project.frontmatter,
      project.archived
    );
    const related = relatedNotes(index, project);
    const relatedMemos = relatedMemosForProject(index.memos, project.title);
    const sessions = (
      await this.options.prompts.listSessions()
    ).sessions.filter(
      (session) =>
        session.project !== null &&
        normalizeLink(session.project) === normalizeLink(project.title)
    );

    const file = this.options.app.vault.getAbstractFileByPath(project.path);
    let noteContent = "";
    if (file instanceof TFile) {
      try {
        noteContent = await this.options.app.vault.cachedRead(file);
      } catch {
        // 読み込み失敗時は空
      }
    }

    const projectTasks = extractMarkdownTasks(
      noteContent,
      project.path,
      project.title
    );
    const relatedTaskGroups = await Promise.all(
      related.map(async (note) => {
        const relFile = this.options.app.vault.getAbstractFileByPath(note.path);
        if (!(relFile instanceof TFile)) {
          return [] as ProjectTask[];
        }
        try {
          const text = await this.options.app.vault.cachedRead(relFile);
          return extractMarkdownTasks(text, note.path, note.title).filter(
            (t) => !t.checked
          );
        } catch {
          return [] as ProjectTask[];
        }
      })
    );
    const relatedUncheckedTasks = relatedTaskGroups.flat();
    const allUncheckedPool = [...projectTasks, ...relatedUncheckedTasks];
    const nextAction = resolveNextAction(
      project.frontmatter.next_action,
      allUncheckedPool
    );

    // 1. ヘッダー＆Next Actionカード
    this.renderOverviewAndNextAction(
      body,
      index,
      project,
      status,
      nextAction,
      related.length,
      relatedMemos.length,
      sessions.length
    );

    // 2. タスクセクション
    this.renderTasksSection(
      body,
      project,
      projectTasks,
      relatedUncheckedTasks,
      nextAction
    );

    // 3. 関連リンク集セクション
    this.renderLinksSection(body, project, noteContent);

    // 4. クイックメモ＆関連つぶやきセクション
    this.renderMemosSection(body, project, relatedMemos);

    // 5. 関連ノートセクション
    this.renderRelatedNotesSection(body, project, related);

    // 6. Promptセッションセクション（折りたたみ）
    this.renderPromptDetailsSection(body, project, sessions);
  }

  private renderOverviewAndNextAction(
    body: HTMLElement,
    index: VaultIndex,
    project: NoteRecord,
    status: ProjectStatus,
    nextAction: ReturnType<typeof resolveNextAction>,
    relatedCount: number,
    memoCount: number,
    sessionCount: number
  ): void {
    const overview = body.createDiv({
      cls: "seiton-project-overview",
    });

    const headRow = overview.createDiv({ cls: "seiton-project-head-row" });
    const statusGroup = headRow.createDiv({
      attr: { "aria-label": "プロジェクトの状態", role: "group" },
      cls: "seiton-project-status-switch",
    });
    for (const candidate of ["active", "paused", "done"] as const) {
      const btn = statusGroup.createEl("button", {
        attr: { type: "button" },
        cls: `seiton-project-status-btn is-${candidate}${
          status === candidate ? " is-active" : ""
        }`,
        text: STATUS_LABEL[candidate],
      });
      btn.addEventListener("click", () => {
        if (status !== candidate) {
          void this.options.onChangeStatus(project, candidate);
        }
      });
    }

    const topActions = headRow.createDiv({ cls: "seiton-project-top-actions" });
    this.action(
      topActions,
      "ノートを開く",
      () => {
        void this.options.onOpenPath(project.path);
      },
      "is-primary"
    );
    this.action(topActions, "新規ノート", () => {
      new NewNoteModal(
        this.options.app,
        this.options.notes,
        this.options.indexService,
        project.title,
        (path) => {
          void this.options.onOpenPath(path);
          this.options.onInvalidate();
        }
      ).open();
    });

    const more = topActions.createEl("details", {
      cls: "seiton-project-more",
    });
    more.createEl("summary", { text: "その他" });
    const moreActions = more.createDiv({ cls: "seiton-project-more-actions" });
    this.action(moreActions, "既存ノートを関連付ける", () => {
      this.options.onLinkNotes(index, project);
    });

    overview.createEl("h1", {
      cls: "seiton-project-title",
      text: project.title,
    });
    overview.createDiv({
      cls: "seiton-project-description",
      text: project.excerpt || "目的や背景はプロジェクトノートに書けます。",
    });
    overview.createDiv({
      cls: "seiton-project-stats",
      text: `関連ノート ${relatedCount}件 · つぶやき ${memoCount}件 · セッション ${sessionCount}件`,
    });

    // Next Action カード
    const nextCard = overview.createDiv({ cls: "seiton-project-next-card" });
    const nextHead = nextCard.createDiv({ cls: "seiton-project-next-head" });
    nextHead.createSpan({
      cls: "seiton-project-next-label",
      text: "次にやること（Next Action）",
    });
    if (nextAction) {
      nextHead.createSpan({
        cls: "seiton-project-next-source",
        text: nextAction.isPinned ? "ピン留め" : "未完了タスク先頭",
      });
    }

    const nextDisplay = nextCard.createDiv({
      cls: "seiton-project-next-display",
    });
    const nextEditWrap = nextCard.createDiv({
      cls: "seiton-project-next-edit",
    });
    nextEditWrap.style.display = "none";

    const nextInput = nextEditWrap.createEl("input", {
      attr: { placeholder: "次にやる1ステップを入力", type: "text" },
      cls: "st-input",
    });
    nextInput.value =
      typeof project.frontmatter.next_action === "string"
        ? project.frontmatter.next_action
        : (nextAction?.text ?? "");

    const openEdit = () => {
      nextDisplay.style.display = "none";
      nextEditWrap.style.display = "";
      nextInput.focus();
      nextInput.select();
    };
    const closeEdit = () => {
      nextEditWrap.style.display = "none";
      nextDisplay.style.display = "";
    };

    const saveNextBtn = nextEditWrap.createEl("button", {
      attr: { type: "button" },
      cls: "st-btn is-primary is-sm",
      text: "保存",
    });
    saveNextBtn.addEventListener("click", () => {
      void this.options.onSetNextAction(project, nextInput.value);
    });
    nextInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.options.onSetNextAction(project, nextInput.value);
      } else if (event.key === "Escape") {
        closeEdit();
      }
    });
    if (nextAction?.isPinned) {
      const clearPinBtn = nextEditWrap.createEl("button", {
        attr: { type: "button" },
        cls: "st-btn is-ghost is-sm",
        text: "固定解除",
      });
      clearPinBtn.addEventListener("click", () => {
        void this.options.onSetNextAction(project, "");
      });
    }
    const cancelNextBtn = nextEditWrap.createEl("button", {
      attr: { type: "button" },
      cls: "st-btn is-ghost is-sm",
      text: "キャンセル",
    });
    cancelNextBtn.addEventListener("click", closeEdit);

    if (nextAction) {
      nextDisplay.createDiv({
        cls: "seiton-project-next-text",
        text: nextAction.text,
      });
      const btns = nextDisplay.createDiv({
        cls: "seiton-project-next-actions",
      });
      const doneBtn = btns.createEl("button", {
        attr: { type: "button" },
        cls: "st-btn is-secondary is-sm",
        text: "完了",
      });
      doneBtn.addEventListener("click", () => {
        if (nextAction.isPinned) {
          void this.options.onSetNextAction(project, "");
        } else if (nextAction.task) {
          void this.options.onToggleTask(nextAction.task);
        }
      });
      const editBtn = btns.createEl("button", {
        attr: { type: "button" },
        cls: "st-btn is-ghost is-sm",
        text: "変更",
      });
      editBtn.addEventListener("click", openEdit);
    } else {
      nextDisplay.createDiv({
        cls: "seiton-project-next-empty",
        text: "次にやることを1行決めておくと、一覧やホームからすぐ再開できます。",
      });
      const setBtn = nextDisplay.createEl("button", {
        attr: { type: "button" },
        cls: "st-btn is-secondary is-sm",
        text: "設定する",
      });
      setBtn.addEventListener("click", openEdit);
    }
  }

  private renderTasksSection(
    body: HTMLElement,
    project: NoteRecord,
    projectTasks: ProjectTask[],
    relatedUncheckedTasks: ProjectTask[],
    nextAction: ReturnType<typeof resolveNextAction>
  ): void {
    const tasksSection = body.createDiv({
      cls: "seiton-section seiton-project-tasks",
    });
    const tasksHead = tasksSection.createDiv({ cls: "seiton-section-head" });
    tasksHead.createEl("h2", { text: "タスク" });
    const completedCount = projectTasks.filter((t) => t.checked).length;
    tasksHead.createSpan({
      cls: "seiton-section-count",
      text: `${completedCount}/${projectTasks.length}`,
    });

    const addBar = tasksSection.createDiv({
      cls: "seiton-project-inline-form",
    });
    const taskInput = addBar.createEl("input", {
      attr: {
        placeholder: "タスクを追加（Enterで保存）",
        type: "text",
      },
      cls: "st-input",
    });
    const addBtn = addBar.createEl("button", {
      attr: { type: "button" },
      cls: "st-btn is-secondary is-sm",
      text: "追加",
    });
    const submitTask = () => {
      const value = taskInput.value.trim();
      if (!value) {
        return;
      }
      taskInput.value = "";
      void this.options.onAddTask(project, value);
    };
    addBtn.addEventListener("click", submitTask);
    taskInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitTask();
      }
    });

    if (projectTasks.length === 0) {
      tasksSection.createDiv({
        cls: "seiton-section-empty",
        text: "まだタスクはありません。上から1つ追加できます。",
      });
    } else {
      const taskList = tasksSection.createDiv({
        cls: "seiton-project-task-list",
      });
      const pinnedText = nextAction?.isPinned ? nextAction.text : "";
      for (const task of projectTasks) {
        const item = taskList.createDiv({
          cls: `seiton-project-task-item${task.checked ? " is-completed" : ""}`,
        });
        const checkbox = item.createEl("input", {
          attr: {
            "aria-label": task.text,
            type: "checkbox",
          },
          cls: "seiton-project-task-checkbox",
        });
        checkbox.checked = task.checked;
        checkbox.addEventListener("change", () => {
          void this.options.onToggleTask(task);
        });
        item.createSpan({
          cls: "seiton-project-task-text",
          text: task.text,
        });
        if (!task.checked) {
          const isCurrentNext = pinnedText === task.text;
          const pinBtn = item.createEl("button", {
            attr: {
              title: isCurrentNext
                ? "現在の Next Action です"
                : "このタスクを Next Action にする",
              type: "button",
            },
            cls: `seiton-project-task-pin${isCurrentNext ? " is-active" : ""}`,
            text: isCurrentNext ? "次にやる中" : "次にやる",
          });
          pinBtn.addEventListener("click", () => {
            void this.options.onSetNextAction(
              project,
              isCurrentNext ? "" : task.text
            );
          });
        }
      }
    }

    if (relatedUncheckedTasks.length > 0) {
      const relWrap = tasksSection.createDiv({
        cls: "seiton-project-related-tasks",
      });
      relWrap.createDiv({
        cls: "seiton-project-subhead",
        text: `関連ノートの未完了タスク (${relatedUncheckedTasks.length})`,
      });
      const relList = relWrap.createDiv({ cls: "seiton-project-task-list" });
      for (const task of relatedUncheckedTasks) {
        const item = relList.createDiv({ cls: "seiton-project-task-item" });
        const checkbox = item.createEl("input", {
          attr: {
            "aria-label": task.text,
            type: "checkbox",
          },
          cls: "seiton-project-task-checkbox",
        });
        checkbox.checked = false;
        checkbox.addEventListener("change", () => {
          void this.options.onToggleTask(task);
        });
        item.createSpan({
          cls: "seiton-project-task-text",
          text: task.text,
        });
        const srcBtn = item.createEl("button", {
          attr: { type: "button" },
          cls: "seiton-project-task-source",
          text: task.sourceTitle,
        });
        srcBtn.addEventListener("click", () => {
          void this.options.onOpenPath(task.sourcePath);
        });
      }
    }
  }

  private renderLinksSection(
    body: HTMLElement,
    project: NoteRecord,
    noteContent: string
  ): void {
    const links = extractProjectLinks(noteContent);
    const section = body.createDiv({ cls: "seiton-section" });
    const head = section.createDiv({ cls: "seiton-section-head" });
    head.createEl("h2", { text: "関連リンク" });
    head.createSpan({
      cls: "seiton-section-count",
      text: String(links.length),
    });

    const form = section.createDiv({
      cls: "seiton-project-inline-form is-link-form",
    });
    const urlInput = form.createEl("input", {
      attr: { placeholder: "URL（https://...）", type: "url" },
      cls: "st-input",
    });
    const labelInput = form.createEl("input", {
      attr: { placeholder: "ラベル（任意）", type: "text" },
      cls: "st-input is-label",
    });
    const addBtn = form.createEl("button", {
      attr: { type: "button" },
      cls: "st-btn is-secondary is-sm",
      text: "追加",
    });
    const submitLink = () => {
      const url = urlInput.value.trim();
      if (!url) {
        return;
      }
      const label = labelInput.value.trim();
      urlInput.value = "";
      labelInput.value = "";
      void this.options.onAddLink(project, label, url);
    };
    addBtn.addEventListener("click", submitLink);
    const onEnter = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitLink();
      }
    };
    urlInput.addEventListener("keydown", onEnter);
    labelInput.addEventListener("keydown", onEnter);

    if (links.length === 0) {
      section.createDiv({
        cls: "seiton-section-empty",
        text: "Discord・Figma・GitHubなどのURLをここにまとめられます。",
      });
      return;
    }

    const grid = section.createDiv({ cls: "seiton-project-link-chips" });
    for (const link of links) {
      const chip = grid.createDiv({ cls: "seiton-project-link-chip" });
      const anchor = chip.createEl("a", {
        attr: {
          href: link.url,
          rel: "noopener noreferrer",
          target: "_blank",
          title: link.url,
        },
        cls: "seiton-project-link-anchor",
      });
      anchor.createSpan({
        cls: "seiton-project-link-label",
        text: link.label,
      });
      const domain = domainOf(link.url);
      if (domain && domain !== link.label) {
        anchor.createSpan({
          cls: "seiton-project-link-domain",
          text: domain,
        });
      }
      const removeBtn = chip.createEl("button", {
        attr: {
          "aria-label": `${link.label} を削除`,
          title: "リンクを削除",
          type: "button",
        },
        cls: "seiton-project-link-remove",
        text: "×",
      });
      removeBtn.addEventListener("click", () => {
        void this.options.onRemoveLink(project, link.url);
      });
    }
  }

  private renderMemosSection(
    body: HTMLElement,
    project: NoteRecord,
    relatedMemos: ReturnType<typeof relatedMemosForProject>
  ): void {
    const section = body.createDiv({ cls: "seiton-section" });
    const head = section.createDiv({ cls: "seiton-section-head" });
    head.createEl("h2", { text: "クイックメモ・関連つぶやき" });
    head.createSpan({
      cls: "seiton-section-count",
      text: `${relatedMemos.length}件`,
    });

    const tagName = projectTagName(project.title);
    const compose = section.createDiv({ cls: "seiton-project-memo-compose" });
    const textarea = compose.createEl("textarea", {
      attr: {
        placeholder: `#${tagName} としてつぶやきに記録（⌘/Ctrl + Enter で保存）`,
        rows: "2",
      },
      cls: "st-textarea seiton-project-memo-input",
    });
    const composeFoot = compose.createDiv({
      cls: "seiton-project-memo-foot",
    });
    composeFoot.createSpan({
      cls: "seiton-project-memo-hint",
      text: `保存先: つぶやき（#${tagName} タグ自動付与）`,
    });
    const saveBtn = composeFoot.createEl("button", {
      attr: { type: "button" },
      cls: "st-btn is-primary is-sm",
      text: "記録",
    });
    const submitMemo = () => {
      const value = textarea.value.trim();
      if (!value) {
        return;
      }
      textarea.value = "";
      void this.options.onAddProjectMemo(project, value);
    };
    saveBtn.addEventListener("click", submitMemo);
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submitMemo();
      }
    });

    if (relatedMemos.length === 0) {
      section.createDiv({
        cls: "seiton-section-empty",
        text: `つぶやきで #${tagName} を付けて書くと、ここに自動集約されます。`,
      });
      return;
    }

    const list = section.createDiv({ cls: "seiton-project-memo-list" });
    for (const memo of relatedMemos) {
      const row = list.createDiv({ cls: "seiton-project-memo-row" });
      const meta = row.createDiv({ cls: "seiton-project-memo-meta" });
      meta.createSpan({
        cls: "seiton-project-memo-time",
        text: shortMemoDate(memo.at),
      });
      if (memo.state === "promoted") {
        meta.createSpan({
          cls: "seiton-project-memo-promoted",
          text: "ノート化済み",
        });
      }
      row.createDiv({
        cls: "seiton-project-memo-body",
        text: memo.body,
      });
    }
  }

  private renderRelatedNotesSection(
    body: HTMLElement,
    project: NoteRecord,
    related: NoteRecord[]
  ): void {
    const notesSection = body.createDiv({ cls: "seiton-section" });
    const notesHead = notesSection.createDiv({ cls: "seiton-section-head" });
    notesHead.createEl("h2", { text: "関連ノート" });
    notesHead.createSpan({
      cls: "seiton-section-count",
      text: String(related.length),
    });

    const KIND_GROUPS: Record<string, string[]> = {
      all: [],
      class: ["class", "reading"],
      idea: ["idea", "note", "article", "collection", "profile"],
      web: ["webclip", "book"],
    };
    const KIND_PILLS: Array<{ id: string; label: string }> = [
      { id: "all", label: "すべて" },
      { id: "idea", label: "メモ・アイデア" },
      { id: "class", label: "授業・ノート" },
      { id: "web", label: "Web・本" },
    ];
    let selectedFilter = "all";

    const filterPillsContainer = notesSection.createDiv({
      cls: "seiton-project-filter-pills",
    });
    const listContainer = notesSection.createDiv({
      cls: "seiton-related-list-wrap",
    });

    const pillButtons: HTMLButtonElement[] = [];
    const renderRelatedList = () => {
      listContainer.empty();
      const filteredNotes = related.filter((note) => {
        if (selectedFilter === "all") {
          return true;
        }
        const allowed = KIND_GROUPS[selectedFilter];
        return allowed ? allowed.includes(note.kind) : true;
      });

      for (const btn of pillButtons) {
        btn.classList.toggle(
          "is-active",
          btn.dataset.filter === selectedFilter
        );
      }

      if (filteredNotes.length === 0) {
        listContainer.createDiv({
          cls: "seiton-section-empty",
          text:
            selectedFilter === "all"
              ? "まだ関連ノートがありません。"
              : "この種類の関連ノートはありません。",
        });
        return;
      }
      const list = listContainer.createDiv({ cls: "seiton-related-list" });
      for (const note of filteredNotes) {
        const article = document.createElement("article");
        article.className = "seiton-related-item";
        const content = article.createDiv({ cls: "seiton-item-content" });
        content.createDiv({
          cls: `seiton-item-kicker seiton-kind-badge is-${note.kind}`,
          text: KIND_LABEL[note.kind] ?? note.kind,
        });
        const title = content.createEl("button", {
          cls: "seiton-related-title",
          text: note.title,
        });
        title.type = "button";
        title.addEventListener("click", () => {
          void this.options.onOpenPath(note.path);
        });
        content.createDiv({
          cls: "seiton-related-excerpt",
          text: relatedSummary(note),
        });
        const actions = content.createDiv({ cls: "seiton-item-actions" });
        const open = actions.createEl("button", {
          cls: "seiton-item-action",
          text: "開く",
        });
        open.type = "button";
        open.addEventListener("click", () => {
          void this.options.onOpenPath(note.path);
        });
        const unlink = actions.createEl("button", {
          cls: "seiton-item-action",
          text: "関連付けを解除",
        });
        unlink.type = "button";
        unlink.addEventListener("click", () => {
          void this.options.onUnlink(note.path, project);
        });
        list.appendChild(article);
      }
    };

    for (const pill of KIND_PILLS) {
      const btn = filterPillsContainer.createEl("button", {
        attr: { "data-filter": pill.id, type: "button" },
        cls: `seiton-pill seiton-project-kind-pill${
          pill.id === selectedFilter ? " is-active" : ""
        }`,
        text: pill.label,
      });
      pillButtons.push(btn);
      btn.addEventListener("click", () => {
        selectedFilter = pill.id;
        renderRelatedList();
      });
    }

    renderRelatedList();
  }

  private renderPromptDetailsSection(
    body: HTMLElement,
    project: NoteRecord,
    sessions: Awaited<ReturnType<PromptService["listSessions"]>>["sessions"]
  ): void {
    const details = body.createEl("details", {
      cls: "seiton-section seiton-project-prompt-details",
    });
    const summary = details.createEl("summary", {
      cls: "seiton-project-prompt-summary",
    });
    summary.createSpan({
      cls: "seiton-project-prompt-title",
      text: `Promptセッション (${sessions.length})`,
    });

    const wrap = details.createDiv({ cls: "seiton-project-prompt-body" });
    const actionsRow = wrap.createDiv({ cls: "seiton-project-primary" });
    const resumable =
      sessions.find((session) => session.state === "open") ??
      (sessions[0]?.draftPreview ? sessions[0] : null);
    if (resumable) {
      this.action(
        actionsRow,
        "前回のセッションを再開",
        () => {
          this.options.host.openPrompt(resumable.path);
        },
        "is-secondary"
      );
      this.action(actionsRow, "新しいセッション", () => {
        void this.options.onCreateSession(project);
      });
    } else {
      this.action(actionsRow, "セッションを開始", () => {
        void this.options.onCreateSession(project);
      });
    }

    if (sessions.length === 0) {
      wrap.createDiv({
        cls: "seiton-section-empty",
        text: "このプロジェクトのセッションはまだありません。",
      });
      return;
    }

    for (const session of sessions) {
      const row = wrap.createDiv({
        cls: "seiton-session-item",
      });
      const content = row.createDiv({ cls: "seiton-item-content" });
      const title = content.createEl("button", {
        cls: "seiton-related-title",
        text: session.title,
      });
      title.type = "button";
      title.addEventListener("click", () =>
        this.options.host.openPrompt(session.path)
      );
      content.createDiv({
        cls: "seiton-related-meta",
        text: `${session.promptCount}件 · ${
          session.state === "open" ? "進行中" : "終了"
        }`,
      });
      if (session.draftPreview) {
        content.createDiv({
          cls: "seiton-related-excerpt",
          text: `下書き: ${session.draftPreview}`,
        });
      }
      const actions = content.createDiv({ cls: "seiton-item-actions" });
      const open = actions.createEl("button", {
        cls: "seiton-item-action",
        text: "Workbenchで開く",
      });
      open.type = "button";
      open.addEventListener("click", () =>
        this.options.host.openPrompt(session.path)
      );
    }
  }

  private action(
    parent: HTMLElement,
    label: string,
    action: () => void,
    extraClass = ""
  ): void {
    const button = parent.createEl("button", {
      cls: `seiton-project-action${extraClass ? ` ${extraClass}` : ""}`,
      text: label,
    });
    button.type = "button";
    button.addEventListener("click", action);
  }
}

function relatedSummary(note: NoteRecord): string {
  if (note.kind === "class" && note.course) {
    return `科目: ${note.course}`;
  }
  if (note.kind === "book" && note.book.book_author) {
    return note.book.book_author;
  }
  return note.excerpt || note.path;
}

function relatedNotes(index: VaultIndex, project: NoteRecord): NoteRecord[] {
  const key = normalizeLink(project.title);
  return index.notes.filter(
    (note) =>
      note.path !== project.path &&
      note.projects.some((value) => normalizeLink(value) === key)
  );
}
