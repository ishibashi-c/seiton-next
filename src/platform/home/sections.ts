import type { App } from "obsidian";
import { TFile } from "obsidian";
import { NOTES_FOLDER, PROMPTS_FOLDER } from "../../config";
import type { PromptSessionSummary } from "../../services/promptService";
import type { NoteRecord, VaultIndex } from "../../services/vaultIndex";
import { makeCardClickable } from "../cardClick";

const HOME_KIND_LABELS: Record<string, string> = {
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

interface HomeCard {
  action: () => void;
  date: string;
  featured?: boolean;
  kind: string;
  meta: string;
  state?: string;
  title: string;
}

export interface HomeSectionElements {
  favoritesBody: HTMLElement;
  favoritesCount: HTMLElement | null;
  favoritesSection: HTMLElement;
  recentBody: HTMLElement;
  recentCount: HTMLElement | null;
  recentSection: HTMLElement;
  resumeBody: HTMLElement;
  resumeCount: HTMLElement | null;
  resumeSection: HTMLElement;
}

export interface HomeSectionsOptions {
  app: App;
  openPath: (path: string) => void;
  openProject: (path: string) => void;
  openPromptSession: (path: string) => void;
}

function readingStatusOf(status: string | null | undefined): string {
  const labels: Record<string, string> = {
    read: "読了",
    reading: "読書中",
    tbr: "積読",
  };
  return status ? (labels[status] ?? status) : "";
}

function shortDateOf(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export class HomeSections {
  private readonly app: App;
  private readonly openPath: (path: string) => void;
  private readonly openProject: (path: string) => void;
  private readonly openPromptSession: (path: string) => void;
  private elements: HomeSectionElements | null = null;
  private resumePaths = new Set<string>();

  constructor(options: HomeSectionsOptions) {
    this.app = options.app;
    this.openPath = options.openPath;
    this.openProject = options.openProject;
    this.openPromptSession = options.openPromptSession;
  }

  attach(elements: HomeSectionElements): void {
    this.elements = elements;
  }

  reset(): void {
    this.elements = null;
    this.resumePaths.clear();
  }

  renderResume(index: VaultIndex, sessions: PromptSessionSummary[]): void {
    const elements = this.elements;
    if (!elements) {
      return;
    }
    const { resumeBody: body, resumeSection: section } = elements;
    body.empty();
    const seen = new Set<string>();
    const cards: HomeCard[] = [];

    const noteByPath = new Map(index.notes.map((note) => [note.path, note]));
    const opened = this.app.workspace
      .getLastOpenFiles()
      .filter(
        (path) =>
          path.startsWith(`${NOTES_FOLDER}/`) &&
          path.endsWith(".md") &&
          !path.startsWith(`${PROMPTS_FOLDER}/`) &&
          !seen.has(path)
      )
      .slice(0, 4);
    for (const path of opened) {
      if (seen.has(path)) {
        continue;
      }
      const note = noteByPath.get(path);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(note && file instanceof TFile)) {
        continue;
      }
      seen.add(path);
      cards.push({
        action: () => this.openPath(path),
        date: shortDateOf(note.mtime),
        kind: HOME_KIND_LABELS[note.kind] ?? note.kind,
        meta: this.noteContext(note),
        title: note.title,
      });
    }

    const openSessions = sessions
      .filter((session) => session.state === "open")
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, 2);
    for (const session of openSessions) {
      if (seen.has(session.path)) {
        continue;
      }
      seen.add(session.path);
      cards.push({
        action: () => this.openPromptSession(session.path),
        date: shortDateOf(session.mtime),
        kind: "プロンプト",
        meta: [
          session.project ? `プロジェクト: ${session.project}` : null,
          session.draftPreview ? `下書き: ${session.draftPreview}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        state: session.draftPreview ? "下書き" : "進行中",
        title: session.title,
      });
    }

    if (cards.length === 0) {
      for (const note of index.notes
        .filter((candidate) => candidate.pinned && !candidate.archived)
        .slice(0, 3)) {
        seen.add(note.path);
        cards.push({
          action: () => this.openPath(note.path),
          date: shortDateOf(note.mtime),
          kind: HOME_KIND_LABELS[note.kind] ?? note.kind,
          meta: this.noteContext(note),
          title: note.title,
        });
      }
    }

    const featuredIndex = Math.max(
      0,
      cards.findIndex((card) => card.state === "下書き")
    );
    const featured = cards[featuredIndex];
    if (featured) {
      featured.featured = true;
      this.renderHomeCard(body, featured);
    }
    for (const card of cards
      .filter((candidate) => candidate !== featured)
      .slice(0, 3)) {
      this.renderHomeCard(body, card);
    }

    const count = Math.min(cards.length, 4);
    if (elements.resumeCount) {
      elements.resumeCount.setText(count > 0 ? `${count}件` : "");
    }
    section.style.display = count > 0 ? "" : "none";
    this.resumePaths = seen;
  }

  renderFavorites(index: VaultIndex): void {
    const elements = this.elements;
    if (!elements) {
      return;
    }
    const { favoritesBody: body, favoritesSection: section } = elements;
    body.empty();
    const items: Array<{ label: string; note: NoteRecord }> = [];
    const add = (note: NoteRecord, label: string) => {
      if (this.resumePaths.has(note.path) || note.archived) {
        return;
      }
      if (items.some((item) => item.note.path === note.path)) {
        return;
      }
      items.push({ label, note });
    };
    for (const note of index.notes.filter(
      (candidate) => candidate.pinned && !candidate.archived
    )) {
      add(note, "ピン留め");
    }
    for (const project of index.notes.filter(
      (candidate) => candidate.kind === "project" && !candidate.archived
    )) {
      add(project, "プロジェクト");
    }
    for (const item of items.slice(0, 3)) {
      this.renderHomeCard(body, {
        action:
          item.note.kind === "project"
            ? () => this.openProject(item.note.path)
            : () => this.openPath(item.note.path),
        date: shortDateOf(item.note.mtime),
        kind: HOME_KIND_LABELS[item.note.kind] ?? item.note.kind,
        meta: this.noteContext(item.note),
        state: item.label === "プロジェクト" ? "" : "ピン",
        title: item.note.title,
      });
    }
    if (elements.favoritesCount) {
      elements.favoritesCount.setText(
        items.length > 0 ? `${Math.min(items.length, 3)}件` : ""
      );
    }
    section.style.display = items.length > 0 ? "" : "none";
  }

  renderRecent(index: VaultIndex): void {
    const elements = this.elements;
    if (!elements) {
      return;
    }
    const { recentBody: body, recentSection: section } = elements;
    body.empty();
    const notes = index.notes
      .filter((note) => !note.archived && !this.resumePaths.has(note.path))
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, 2);
    for (const note of notes) {
      this.renderHomeCard(body, {
        action: () => this.openPath(note.path),
        date: shortDateOf(note.mtime),
        kind: HOME_KIND_LABELS[note.kind] ?? note.kind,
        meta: "",
        title: note.title,
      });
    }
    if (elements.recentCount) {
      elements.recentCount.setText(notes.length > 0 ? `${notes.length}件` : "");
    }
    section.style.display = notes.length > 0 ? "" : "none";
  }

  private renderHomeCard(parent: HTMLElement, item: HomeCard): void {
    const card = parent.createEl("article", {
      cls: `seiton-home-card${item.featured ? " is-featured" : ""}`,
    });
    card.dataset.kind = item.kind;

    const head = card.createDiv({ cls: "seiton-home-card-head" });
    head.createSpan({ cls: "seiton-home-card-kind", text: item.kind });
    head.createSpan({ cls: "seiton-home-card-date", text: item.date });

    const title = card.createEl("h3", { cls: "seiton-home-card-title" });
    const link = title.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-home-card-link",
      text: item.title,
    });
    link.addEventListener("click", item.action);

    if (item.meta) {
      card.createDiv({ cls: "seiton-home-card-meta", text: item.meta });
    }

    if (item.state || item.featured) {
      const foot = card.createDiv({ cls: "seiton-home-card-foot" });
      foot.createSpan({
        cls: "seiton-home-card-state",
        text: item.state ?? "",
      });
      if (item.featured) {
        const again = foot.createEl("button", {
          cls: "seiton-home-card-action",
          text: "再開",
        });
        again.type = "button";
        again.addEventListener("click", item.action);
      }
    }
    makeCardClickable(card, item.action);
  }

  private noteContext(note: NoteRecord): string {
    if (note.kind === "book") {
      return [note.book.book_author, readingStatusOf(note.book.reading_status)]
        .filter(Boolean)
        .join(" · ");
    }
    return [
      note.course ? `科目: ${note.course}` : null,
      note.projects.length > 0 ? note.projects.join(" · ") : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
}
