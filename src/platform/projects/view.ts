import type { App } from "obsidian";
import { normalizeLink } from "../../domain/links";
import { countSessionsByProject } from "../../domain/projects";
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
  onCreateSession: (project: NoteRecord) => Promise<void>;
  onInvalidate: () => void;
  onLinkNotes: (index: VaultIndex, project: NoteRecord) => void;
  onOpenPath: (path: string) => Promise<void>;
  onSelect: (path: string | null) => void;
  onToggleArchived: (project: NoteRecord) => Promise<void>;
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

export class ProjectsRenderer {
  private readonly options: ProjectsRendererOptions;

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
        "プロジェクトがありません。目的ごとに1つのMarkdownを作ります。"
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

    const list = body.createDiv({ cls: "seiton-project-list" });
    for (const project of projects) {
      const article = document.createElement("article");
      article.className = "seiton-project-item";
      const content = article.createDiv({ cls: "seiton-item-content" });
      // The page is already titled プロジェクト; only the exception is labelled.
      if (project.archived) {
        const kicker = content.createDiv({ cls: "seiton-item-kicker" });
        kicker.createSpan({ cls: "seiton-item-marker", text: "終了" });
      }
      const title = content.createEl("button", {
        cls: "seiton-item-title",
        text: project.title,
      });
      title.type = "button";
      title.addEventListener("click", () => {
        this.options.onSelect(project.path);
      });
      if (project.excerpt) {
        content.createDiv({
          cls: "seiton-item-excerpt",
          text: project.excerpt,
        });
      }
      const related = relatedNotes(index, project).length;
      const projectKey = normalizeLink(project.title);
      const sessions = sessionsByProject.get(projectKey) ?? 0;
      content.createDiv({
        cls: "seiton-item-meta",
        text: `関連ノート ${related}件 · セッション ${sessions}件`,
      });
      const actions = content.createDiv({ cls: "seiton-item-actions" });
      const detail = actions.createEl("button", {
        cls: "seiton-item-action",
        text: "詳細",
      });
      detail.type = "button";
      detail.addEventListener("click", () => {
        this.options.onSelect(project.path);
      });
      const open = actions.createEl("button", {
        cls: "seiton-item-action",
        text: "ノートを開く",
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

    const overview = body.createDiv({
      cls: "seiton-project-overview",
    });
    if (project.archived) {
      const kicker = overview.createDiv({ cls: "seiton-item-kicker" });
      kicker.createSpan({ cls: "seiton-item-marker", text: "終了" });
    }
    overview.createEl("h1", {
      cls: "seiton-project-title",
      text: project.title,
    });
    overview.createDiv({
      cls: "seiton-project-description",
      text: project.excerpt || "目的はプロジェクトノートに書けます。",
    });

    const related = relatedNotes(index, project);
    const sessions = (
      await this.options.prompts.listSessions()
    ).sessions.filter(
      (session) =>
        session.project !== null &&
        normalizeLink(session.project) === normalizeLink(project.title)
    );
    overview.createDiv({
      cls: "seiton-project-stats",
      text: `関連ノート ${related.length}件 · セッション ${sessions.length}件`,
    });

    overview.createDiv({
      cls: "seiton-project-resume-label",
      text: "作業を再開",
    });
    const primary = overview.createDiv({ cls: "seiton-project-primary" });
    const resumable =
      sessions.find((session) => session.state === "open") ??
      (sessions[0]?.draftPreview ? sessions[0] : null);
    if (resumable) {
      const resumeMeta = [
        resumable.title,
        resumable.draftPreview ? `下書き: ${resumable.draftPreview}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      overview.createDiv({
        cls: "seiton-project-resume-target",
        text: resumeMeta,
      });
      this.action(
        primary,
        "前回のセッションを再開",
        () => {
          this.options.host.openPrompt(resumable.path);
        },
        "is-primary"
      );
      this.action(primary, "新しいセッション", () => {
        void this.options.onCreateSession(project);
      });
    } else {
      this.action(
        primary,
        "セッションを開始",
        () => {
          void this.options.onCreateSession(project);
        },
        "is-primary"
      );
    }
    this.action(primary, "新しいノート", () => {
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
    this.action(primary, "ノートを開く", () => {
      void this.options.onOpenPath(project.path);
    });

    const more = overview.createEl("details", {
      cls: "seiton-project-more",
    });
    more.createEl("summary", { text: "その他の操作" });
    const moreActions = more.createDiv({ cls: "seiton-project-more-actions" });
    this.action(moreActions, "既存ノートを関連付ける", () => {
      this.options.onLinkNotes(index, project);
    });
    this.action(
      moreActions,
      project.archived ? "プロジェクトを再開" : "プロジェクトを終了",
      () => {
        void this.options.onToggleArchived(project);
      }
    );

    const notesSection = body.createDiv({ cls: "seiton-section" });
    const notesHead = notesSection.createDiv({ cls: "seiton-section-head" });
    notesHead.createEl("h2", { text: "関連ノート" });
    notesHead.createSpan({
      cls: "seiton-section-count",
      text: String(related.length),
    });
    if (related.length === 0) {
      notesSection.createDiv({
        cls: "seiton-section-empty",
        text: "まだ関連ノートがありません。",
      });
    } else {
      const list = notesSection.createDiv({ cls: "seiton-related-list" });
      for (const note of related) {
        const article = document.createElement("article");
        article.className = "seiton-related-item";
        const content = article.createDiv({ cls: "seiton-item-content" });
        content.createDiv({
          cls: "seiton-item-kicker",
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
    }

    const sessionsSection = body.createDiv({ cls: "seiton-section" });
    const sessionsHead = sessionsSection.createDiv({
      cls: "seiton-section-head",
    });
    sessionsHead.createEl("h2", { text: "プロンプトセッション" });
    sessionsHead.createSpan({
      cls: "seiton-section-count",
      text: String(sessions.length),
    });
    if (sessions.length === 0) {
      sessionsSection.createDiv({
        cls: "seiton-section-empty",
        text: "このプロジェクトのセッションはまだありません。",
      });
    } else {
      for (const session of sessions) {
        const row = sessionsSection.createDiv({
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
