import type { App } from "obsidian";
import { type Component, MarkdownRenderer } from "obsidian";
import { VIEW_TYPE_TSUBUYAKI } from "../../config";
import { weekRange } from "../../domain/isoWeek";
import { clockOf, dateKeyOf, dateKeyToLocalDate } from "../../domain/time";
import type { MemoListItem, MemoProblem } from "../../services/memoService";
import { makeCardClickable } from "../cardClick";
import { openSeitonView } from "../seitonNav";

const DAY_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  day: "numeric",
  month: "long",
  weekday: "short",
  year: "numeric",
});

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad2(
    date.getMonth() + 1
  )}-${pad2(date.getDate())}`;
}

function dayLabel(dateKey: string): string {
  const date = dateKeyToLocalDate(dateKey);
  if (!date) {
    return "日時不明";
  }
  const today = new Date();
  const todayKey = localDateKey(today);
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1
  );
  const base = DAY_FORMATTER.format(date);
  if (dateKey === todayKey) {
    return "今日";
  }
  if (dateKey === localDateKey(yesterday)) {
    return "昨日";
  }
  return base;
}

function weekLabel(week: string): string {
  const range = weekRange(week);
  if (!range) {
    return week;
  }
  const format = (date: Date): string =>
    `${date.getMonth() + 1}/${date.getDate()}`;
  return `${week} · ${format(range.start)}〜${format(range.end)}`;
}

export interface HomeTimelineOptions {
  app: App;
  component: Component;
  openWeekFile: (path: string) => void;
}

/** ホーム下部の「最近のメモ」。最新3件を週・日でまとめて出す。 */
export class HomeTimeline {
  private readonly app: App;
  private readonly component: Component;
  private readonly openWeekFile: (path: string) => void;
  private timelineEl: HTMLElement | null = null;
  private problemsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;
  private readonly visibleLimit = 3;

  constructor(options: HomeTimelineOptions) {
    this.app = options.app;
    this.component = options.component;
    this.openWeekFile = options.openWeekFile;
  }

  mount(parent: HTMLElement): void {
    const section = parent.createEl("details", {
      cls: "seiton-timeline seiton-home-memo-details",
    });
    section.createEl("summary", { text: "最近のメモ" });
    this.statusEl = section.createDiv({ cls: "seiton-timeline-status" });
    this.statusEl.setAttribute("aria-live", "polite");
    this.problemsEl = section.createDiv({ cls: "seiton-problems" });
    this.timelineEl = section.createDiv({ cls: "seiton-timeline-body" });
    this.footerEl = section.createDiv({ cls: "seiton-timeline-footer" });
  }

  isMounted(): boolean {
    return this.timelineEl !== null;
  }

  render(items: MemoListItem[], problems: MemoProblem[]): void {
    this.renderProblems(problems);
    this.renderTimeline(items);
  }

  setStatus(message: string, kind: "idle" | "success" | "error"): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-success", kind === "success");
    this.statusEl.toggleClass("is-error", kind === "error");
  }

  reset(): void {
    this.timelineEl = null;
    this.problemsEl = null;
    this.statusEl = null;
    this.footerEl = null;
  }

  private renderProblems(problems: MemoProblem[]): void {
    if (!this.problemsEl) {
      return;
    }
    this.problemsEl.empty();
    if (problems.length === 0) {
      return;
    }

    const details = this.problemsEl.createEl("details", {
      cls: "seiton-problem-details",
    });
    details.createEl("summary", {
      text: `確認が必要なファイルが ${problems.length} 件あります`,
    });
    const list = details.createEl("ul");
    for (const problem of problems.slice(0, 10)) {
      const item = list.createEl("li");
      item.createSpan({ cls: "seiton-problem-path", text: problem.path });
      item.createSpan({ text: problem.message });
    }
    if (problems.length > 10) {
      list.createEl("li", { text: `他 ${problems.length - 10} 件` });
    }
  }

  private renderTimeline(items: MemoListItem[]): void {
    if (!this.timelineEl) {
      return;
    }
    this.timelineEl.empty();
    this.footerEl?.empty();

    if (items.length === 0) {
      this.timelineEl.createDiv({
        cls: "seiton-empty",
        text: "まだメモはありません。上の欄から保存できます。",
      });
      this.renderMoreButton(items.length);
      return;
    }

    const visible = items.slice(0, this.visibleLimit);
    const weekGroups = new Map<string, MemoListItem[]>();
    for (const item of visible) {
      const key = item.week || "unknown";
      const group = weekGroups.get(key) ?? [];
      group.push(item);
      weekGroups.set(key, group);
    }

    for (const [week, weekItems] of weekGroups) {
      const weekSection = this.timelineEl.createEl("section", {
        cls: "seiton-week-group",
      });
      weekSection.dataset.week = week;
      const weekHead = weekSection.createDiv({ cls: "seiton-week-head" });
      weekHead.createEl("h3", {
        text: week === "unknown" ? "週不明" : weekLabel(week),
      });
      weekHead.createSpan({
        cls: "seiton-week-count",
        text: `${weekItems.length}件`,
      });

      const dayGroups = new Map<string, MemoListItem[]>();
      for (const item of weekItems) {
        const key = dateKeyOf(item.entry.at) || "unknown";
        const group = dayGroups.get(key) ?? [];
        group.push(item);
        dayGroups.set(key, group);
      }
      for (const [key, group] of dayGroups) {
        const section = weekSection.createEl("section", {
          cls: "seiton-day-group",
        });
        const header = section.createDiv({ cls: "seiton-day-head" });
        header.createEl("h4", {
          text: key === "unknown" ? "日時不明" : dayLabel(key),
        });
        header.createSpan({
          cls: "seiton-day-count",
          text: `${group.length}件`,
        });

        for (const item of group) {
          this.renderMemoItem(section, item);
        }
      }
    }

    this.renderMoreButton(items.length);
  }

  private renderMoreButton(total: number): void {
    if (!this.footerEl) {
      return;
    }
    this.footerEl.empty();
    if (total <= this.visibleLimit) {
      return;
    }
    const button = this.footerEl.createEl("button", {
      cls: "seiton-more-button",
      text: "すべて見る",
    });
    button.type = "button";
    button.addEventListener("click", () => {
      void openSeitonView(this.app, VIEW_TYPE_TSUBUYAKI);
    });
  }

  private renderMemoItem(parent: HTMLElement, item: MemoListItem): void {
    const entry = item.entry;
    const row = parent.createDiv({ cls: "seiton-memo" });
    row.dataset.id = entry.id;
    if (entry.state === "deleted") {
      row.addClass("is-deleted");
    }
    if (entry.state === "unknown") {
      row.addClass("is-unknown");
    }

    const time = row.createDiv({ cls: "seiton-memo-time" });
    time.setText(clockOf(entry.at) || "--:--");
    time.title = `ID: ${entry.id}`;

    const main = row.createDiv({ cls: "seiton-memo-main" });
    const body = main.createDiv({
      cls: "seiton-memo-body markdown-rendered",
    });
    void MarkdownRenderer.render(
      this.app,
      entry.body,
      body,
      item.path,
      this.component
    ).catch(() => {
      body.setText(entry.body);
    });

    if (entry.promotedTo) {
      const linkText = `[[${entry.promotedTo.replace(/\.md$/u, "")}]]`;
      // 昇格時に本文へ残したリンクがある場合は、UIでの重複表示を避ける。
      if (!entry.body.includes(linkText)) {
        const promoted = main.createDiv({ cls: "seiton-memo-promoted" });
        promoted.createSpan({ text: "独立ノート:" });
        const link = promoted.createEl("a", {
          cls: "internal-link",
          text: entry.promotedTo.replace(/\.md$/u, ""),
        });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          this.openWeekFile(entry.promotedTo ?? "");
        });
      }
    }

    const meta = main.createDiv({ cls: "seiton-memo-meta" });
    if (entry.state === "deleted") {
      meta.createSpan({ cls: "seiton-badge is-deleted", text: "削除済み" });
    }
    if (entry.state === "promoted") {
      meta.createSpan({
        cls: "seiton-badge is-promoted",
        text: "ノート化済み",
      });
    }
    if (entry.state === "unknown") {
      meta.createSpan({ cls: "seiton-badge is-unknown", text: "状態不明" });
    }

    makeCardClickable(row, () => {
      this.openWeekFile(item.path);
    });
  }
}
