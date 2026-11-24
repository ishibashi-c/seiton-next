import type { App } from "obsidian";
import { TFile } from "obsidian";
import { NOTES_FOLDER, PROMPTS_FOLDER } from "../../config";
import { normalizeProjectStatus } from "../../domain/projects";
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
  activeProjectsBody: HTMLElement;
  activeProjectsCount: HTMLElement | null;
  activeProjectsSection: HTMLElement;
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

    if (cards.length < 4) {
      for (const note of index.notes
        .filter(
          (candidate) =>
            candidate.pinned &&
            !candidate.archived &&
            candidate.kind !== "project" &&
            !seen.has(candidate.path)
        )
        .sort((left, right) => right.mtime - left.mtime)) {
        if (cards.length >= 4) {
          break;
        }
        seen.add(note.path);
        cards.push({
          action: () => this.openPath(note.path),
          date: shortDateOf(note.mtime),
          kind: HOME_KIND_LABELS[note.kind] ?? note.kind,
          meta: this.noteContext(note),
          state: "ピン",
          title: note.title,
        });
      }
    }

    if (cards.length < 4) {
      for (const note of index.notes
        .filter(
          (candidate) =>
            !candidate.archived &&
            candidate.kind !== "project" &&
            !seen.has(candidate.path)
        )
        .sort((left, right) => right.mtime - left.mtime)) {
        if (cards.length >= 4) {
          break;
        }
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

    const featuredIndex = cards.findIndex((card) => card.state === "下書き");
    const featured = featuredIndex >= 0 ? cards[featuredIndex] : undefined;
    if (featured) {
      featured.featured = true;
      this.renderResumeRow(body, featured);
    }
    for (const card of cards
      .filter((candidate) => candidate !== featured)
      .slice(0, featured ? 3 : 4)) {
      this.renderResumeRow(body, card);
    }

    const count = Math.min(cards.length, 4);
    if (elements.resumeCount) {
      elements.resumeCount.setText(count > 0 ? `${count}件` : "");
    }
    section.style.display = count > 0 ? "" : "none";
  }

  renderActiveProjects(index: VaultIndex): void {
    const elements = this.elements;
    if (!elements) {
      return;
    }
    const {
      activeProjectsBody: body,
      activeProjectsCount: countEl,
      activeProjectsSection: section,
    } = elements;
    body.empty();

    const activeProjects = index.notes
      .filter(
        (note) =>
          note.kind === "project" &&
          normalizeProjectStatus(note.frontmatter, note.archived) === "active"
      )
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtime - a.mtime);

    if (activeProjects.length === 0) {
      section.style.display = "none";
      if (countEl) {
        countEl.setText("");
      }
      return;
    }

    for (const project of activeProjects.slice(0, 4)) {
      const card = body.createEl("article", {
        cls: "st2-home-project",
      });
      const head = card.createDiv({ cls: "st2-home-project-head" });
      const link = head.createEl("button", {
        attr: { type: "button" },
        cls: "st2-home-project-title",
        text: project.title,
      });
      link.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openProject(project.path);
      });
      head.createSpan({
        cls: "st2-home-project-date",
        text: shortDateOf(project.mtime),
      });

      const nextAction =
        typeof project.frontmatter.next_action === "string"
          ? project.frontmatter.next_action.trim()
          : "";
      const nextRow = card.createDiv({
        cls: `st2-home-project-next${nextAction ? "" : " is-empty"}`,
      });
      if (nextAction) {
        nextRow.createSpan({
          cls: "st2-badge is-focus",
          text: "Next",
        });
        nextRow.createSpan({
          cls: "st2-home-project-next-text",
          text: nextAction,
        });
      } else {
        nextRow.createSpan({
          cls: "st2-home-project-next-text",
          text: project.excerpt || "次の一歩を設定する",
        });
      }

      makeCardClickable(card, () => this.openProject(project.path));
    }

    if (countEl) {
      countEl.setText(`${activeProjects.length}件`);
    }
    section.style.display = "";
  }

  renderRediscoverySection(parent: HTMLElement): HTMLElement {
    const section = parent.createDiv({
      cls: "st2-home-rediscovery",
    });
    section.style.display = "none";

    const head = section.createDiv({ cls: "st2-section-head" });
    head.createEl("h2", {
      cls: "st2-section-title",
      text: "過去の今日・再発見",
    });
    const countEl = head.createSpan({ cls: "st2-section-count" });
    const shuffleBtn = head.createEl("button", {
      attr: { "aria-label": "入れ替え", type: "button" },
      cls: "st2-quiet-btn st2-section-action",
      text: "入れ替え",
    });
    shuffleBtn.addEventListener("click", () => {
      this.rediscoveryOffset += 1;
      if (this.lastIndex) {
        this.renderRediscovery(this.lastIndex);
      }
    });

    const bodyEl = section.createDiv({
      cls: "st2-home-rediscovery-grid",
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
      this.renderRediscoveryCard(body, {
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

  private renderResumeRow(parent: HTMLElement, item: HomeCard): void {
    const row = parent.createEl("div", {
      cls: `st2-ledger-row st2-home-resume-row${item.featured ? " is-focus" : ""}`,
    });

    row.createSpan({
      cls: `st2-badge${item.featured ? " is-focus" : ""}`,
      text: item.kind,
    });

    const main = row.createDiv({ cls: "st2-home-resume-body" });
    const link = main.createEl("button", {
      attr: { type: "button" },
      cls: "st2-home-resume-title",
      text: item.title,
    });
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      item.action();
    });
    if (item.meta) {
      main.createDiv({ cls: "st2-home-resume-meta", text: item.meta });
    }

    const side = row.createDiv({ cls: "st2-home-resume-side" });
    if (item.state) {
      side.createSpan({
        cls: `st2-badge${item.featured ? " is-focus" : ""}`,
        text: item.state,
      });
    }
    side.createSpan({
      cls: "st2-home-resume-date",
      text: item.date,
    });

    makeCardClickable(row, item.action);
  }

  private renderRediscoveryCard(parent: HTMLElement, item: HomeCard): void {
    const card = parent.createEl("article", {
      cls: "st2-home-rediscovery-card",
    });

    const head = card.createDiv({ cls: "st2-home-rediscovery-head" });
    head.createSpan({ cls: "st2-badge", text: item.kind });
    head.createSpan({ cls: "st2-home-resume-date", text: item.date });

    const titleBtn = card.createEl("button", {
      attr: { type: "button" },
      cls: "st2-home-rediscovery-title",
      text: item.title,
    });
    titleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      item.action();
    });

    if (item.meta) {
      card.createDiv({ cls: "st2-home-rediscovery-meta", text: item.meta });
    }

    makeCardClickable(card, item.action);
  }

  private noteContext(note: NoteRecord): string {
    if (note.kind === "project") {
      const nextAction =
        typeof note.frontmatter.next_action === "string"
          ? note.frontmatter.next_action.trim()
          : "";
      return nextAction ? `次: ${nextAction}` : "";
    }
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
