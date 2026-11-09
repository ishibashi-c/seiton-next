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
  private rediscoverySection: HTMLElement | null = null;
  private rediscoveryBody: HTMLElement | null = null;
  private rediscoveryCount: HTMLElement | null = null;
  private rediscoveryOffset = 0;
  private lastIndex: VaultIndex | null = null;

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
    this.rediscoverySection = null;
    this.rediscoveryBody = null;
    this.rediscoveryCount = null;
    this.lastIndex = null;
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

  renderRediscoverySection(parent: HTMLElement): HTMLElement {
    const section = parent.createDiv({
      cls: "seiton-zone seiton-home-section seiton-home-rediscovery is-minor",
    });
    section.style.display = "none";

    const head = section.createDiv({ cls: "seiton-zone-head" });
    head.createEl("h2", { text: "過去の今日・再発見" });

    const actions = head.createDiv({ cls: "seiton-zone-actions" });
    const shuffleBtn = actions.createEl("button", {
      attr: { "aria-label": "入れ替え", type: "button" },
      cls: "seiton-text-action seiton-rediscovery-shuffle-btn",
      text: "入れ替え",
    });
    shuffleBtn.addEventListener("click", () => {
      this.rediscoveryOffset += 1;
      if (this.lastIndex) {
        this.renderRediscovery(this.lastIndex);
      }
    });

    const countEl = head.createSpan({ cls: "seiton-zone-count" });
    const bodyEl = section.createDiv({
      cls: "seiton-home-section-body seiton-home-cards seiton-rediscovery-cards",
    });

    this.rediscoverySection = section;
    this.rediscoveryBody = bodyEl;
    this.rediscoveryCount = countEl;

    return section;
  }

  renderRediscovery(index: VaultIndex): void {
    this.lastIndex = index;
    const section = this.rediscoverySection;
    const body = this.rediscoveryBody;
    if (!section || !body) {
      return;
    }
    body.empty();

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const candidates = index.notes.filter((note) =>
      this.isRediscoveryCandidate(note, now)
    );

    if (candidates.length === 0) {
      section.style.display = "none";
      if (this.rediscoveryCount) {
        this.rediscoveryCount.setText("");
      }
      return;
    }

    const seed = hashSeed(`${todayStr}:${this.rediscoveryOffset}`);
    const picked = deterministicPick(candidates, seed, 3);

    for (const note of picked) {
      this.renderHomeCard(body, {
        action: () => this.openPath(note.path),
        date: shortDateOf(note.mtime),
        kind: HOME_KIND_LABELS[note.kind] ?? note.kind,
        meta: this.noteContext(note),
        title: note.title,
      });
    }

    if (this.rediscoveryCount) {
      this.rediscoveryCount.setText(`${picked.length}件`);
    }
    section.style.display = "";
  }

  private isRediscoveryCandidate(note: NoteRecord, now: Date): boolean {
    if (note.archived) {
      return false;
    }
    const isIdea = note.kind === "idea";
    const isPinned = note.pinned || note.frontmatter.status === "pinned";
    const isInbox =
      note.review ||
      note.frontmatter.status === "inbox" ||
      note.frontmatter.status === "review";
    const isWebUnread =
      (note.kind === "web" || note.kind === "webclip") &&
      note.frontmatter.clip_status !== "done" &&
      note.frontmatter.clipStatus !== "done" &&
      note.frontmatter.status !== "done";

    if (!isIdea && !isPinned && !isInbox && !isWebUnread) {
      return false;
    }

    const checkTimestamp = (timestamp: number): boolean => {
      if (Number.isNaN(timestamp) || timestamp <= 0) {
        return false;
      }
      const diffDays = (now.getTime() - timestamp) / (1000 * 60 * 60 * 24);
      if (diffDays >= 7) {
        return true;
      }
      const d = new Date(timestamp);
      return (
        d.getFullYear() < now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    };

    const createdTime = note.created ? Date.parse(note.created) : Number.NaN;
    const createdMatches =
      !Number.isNaN(createdTime) && checkTimestamp(createdTime);
    const updatedMatches = checkTimestamp(note.mtime);

    return createdMatches || updatedMatches;
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

function hashSeed(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function deterministicPick<T>(items: T[], seed: number, count: number): T[] {
  if (items.length <= count) {
    return [...items];
  }
  const cloned = [...items];
  let s = (seed === 0 ? 1 : seed) >>> 0;
  const nextRand = () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRand() * (i + 1));
    const itemI = cloned[i];
    const itemJ = cloned[j];
    if (itemI !== undefined && itemJ !== undefined) {
      cloned[i] = itemJ;
      cloned[j] = itemI;
    }
  }
  return cloned.slice(0, count);
}
