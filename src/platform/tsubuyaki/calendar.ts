/**
 * つぶやきページ用のカレンダーUIコンポーネント。
 * メモが存在する日をインジケータードットで可視化し、特定日・特定期間での絞り込みを直感的に行う。
 */

import { setIcon } from "obsidian";
import { dateKeyOf, dateKeyToLocalDate } from "../../domain/time";
import type { MemoListItem } from "../../services/memoService";
import type { MemoPeriodFilter } from "./timeline";

export interface CalendarSelection {
  /** 表示用ラベル（例: "11月4日"、"今週"、"2026年11月"、"期間: すべて"） */
  label: string;
  period: MemoPeriodFilter;
  /** YYYY-MM-DD または YYYY-MM（指定なし時は空文字） */
  selectedDate: string;
}

export interface CalendarPickerOptions {
  initialSelection?: CalendarSelection;
  onChange: (selection: CalendarSelection) => void;
}

export class CalendarPicker {
  private readonly options: CalendarPickerOptions;
  private currentYear: number;
  private currentMonth: number; // 0-indexed (0=1月, 11=12月)
  private memoDates = new Set<string>();
  private selection: CalendarSelection;
  private isOpen = false;

  private wrapEl: HTMLElement | null = null;
  private triggerBtn: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;
  private clearBtn: HTMLElement | null = null;
  private popoverEl: HTMLElement | null = null;
  private outsideClickListener: ((e: PointerEvent) => void) | null = null;

  constructor(options: CalendarPickerOptions) {
    this.options = options;
    const now = new Date();
    this.currentYear = now.getFullYear();
    this.currentMonth = now.getMonth();
    this.selection = options.initialSelection ?? {
      label: "期間: すべて",
      period: "all",
      selectedDate: "",
    };
  }

  mount(parent: HTMLElement): HTMLElement {
    const wrap = parent.createDiv({ cls: "seiton-calendar-wrap" });
    this.wrapEl = wrap;

    const trigger = wrap.createEl("button", {
      attr: {
        "aria-expanded": "false",
        "aria-haspopup": "dialog",
        type: "button",
      },
      cls: "seiton-calendar-trigger seiton-tsubuyaki-select is-quiet",
    });
    this.triggerBtn = trigger;

    const iconSpan = trigger.createSpan({ cls: "seiton-calendar-icon" });
    setIcon(iconSpan, "calendar");

    this.labelEl = trigger.createSpan({
      cls: "seiton-calendar-label",
      text: this.selection.label,
    });

    const caretSpan = trigger.createSpan({ cls: "seiton-calendar-caret" });
    setIcon(caretSpan, "chevron-down");

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover();
    });

    const clear = wrap.createEl("button", {
      attr: { "aria-label": "期間の絞り込みを解除", type: "button" },
      cls: "seiton-calendar-clear",
      text: "×",
    });
    this.clearBtn = clear;
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      this.select({
        label: "期間: すべて",
        period: "all",
        selectedDate: "",
      });
    });

    this.updateTriggerState();
    return wrap;
  }

  setMemoItems(items: MemoListItem[]): void {
    this.memoDates.clear();
    for (const item of items) {
      if (item.entry.state !== "deleted") {
        const key = dateKeyOf(item.entry.at);
        if (key) {
          this.memoDates.add(key);
        }
      }
    }
    if (this.isOpen) {
      this.renderPopover();
    }
  }

  getSelection(): CalendarSelection {
    return this.selection;
  }

  destroy(): void {
    this.closePopover();
    this.wrapEl = null;
    this.triggerBtn = null;
    this.labelEl = null;
    this.clearBtn = null;
    this.popoverEl = null;
  }

  private togglePopover(): void {
    if (this.isOpen) {
      this.closePopover();
    } else {
      this.openPopover();
    }
  }

  private openPopover(): void {
    if (this.isOpen || !this.wrapEl) {
      return;
    }
    this.isOpen = true;
    this.triggerBtn?.setAttribute("aria-expanded", "true");

    // 選択中の日付があれば、その年月に移動
    if (this.selection.selectedDate) {
      const parts = this.selection.selectedDate.split("-");
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      if (!Number.isNaN(y) && !Number.isNaN(m) && m >= 1 && m <= 12) {
        this.currentYear = y;
        this.currentMonth = m - 1;
      }
    }

    this.renderPopover();

    this.outsideClickListener = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !this.wrapEl?.contains(target)) {
        this.closePopover();
      }
    };
    window.addEventListener("pointerdown", this.outsideClickListener, {
      capture: true,
    });
  }

  private closePopover(): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.triggerBtn?.setAttribute("aria-expanded", "false");
    if (this.outsideClickListener) {
      window.removeEventListener("pointerdown", this.outsideClickListener, {
        capture: true,
      });
      this.outsideClickListener = null;
    }
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }
  }

  private renderPopover(): void {
    if (!this.wrapEl) {
      return;
    }
    if (!this.popoverEl) {
      this.popoverEl = this.wrapEl.createDiv({
        cls: "seiton-calendar-popover",
      });
    }
    const popover = this.popoverEl;
    popover.empty();

    // 1. ヘッダー（月送りナビゲーション）
    const header = popover.createDiv({ cls: "seiton-calendar-header" });
    const prevBtn = header.createEl("button", {
      attr: { "aria-label": "前月", type: "button" },
      cls: "seiton-calendar-nav-btn",
    });
    setIcon(prevBtn, "chevron-left");
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.prevMonth();
    });

    const titleEl = header.createSpan({
      cls: "seiton-calendar-title",
      text: `${this.currentYear}年 ${this.currentMonth + 1}月`,
    });
    // タイトルクリックでその月全体を選択
    titleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const monthKey = `${this.currentYear}-${String(
        this.currentMonth + 1
      ).padStart(2, "0")}`;
      this.select({
        label: `${this.currentYear}年${this.currentMonth + 1}月`,
        period: "month",
        selectedDate: monthKey,
      });
      this.closePopover();
    });

    const nextBtn = header.createEl("button", {
      attr: { "aria-label": "次月", type: "button" },
      cls: "seiton-calendar-nav-btn",
    });
    setIcon(nextBtn, "chevron-right");
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.nextMonth();
    });

    // 2. クイック選択バー
    const quickBar = popover.createDiv({ cls: "seiton-calendar-quick" });
    const quickItems: Array<{
      label: string;
      sel: CalendarSelection;
    }> = [
      {
        label: "すべて",
        sel: { label: "期間: すべて", period: "all", selectedDate: "" },
      },
      {
        label: "今日",
        sel: {
          label: "今日",
          period: "today",
          selectedDate: this.todayKey(),
        },
      },
      {
        label: "今週",
        sel: { label: "今週", period: "week", selectedDate: "" },
      },
      {
        label: "今月",
        sel: {
          label: "今月",
          period: "month",
          selectedDate: this.todayKey().slice(0, 7),
        },
      },
    ];

    for (const item of quickItems) {
      const isCurrent =
        item.sel.period === this.selection.period &&
        item.sel.selectedDate === this.selection.selectedDate;
      const chip = quickBar.createEl("button", {
        attr: { type: "button" },
        cls: `seiton-calendar-chip${isCurrent ? " is-active" : ""}`,
        text: item.label,
      });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        this.select(item.sel);
        this.closePopover();
      });
    }

    // 3. 曜日ヘッダー
    const grid = popover.createDiv({ cls: "seiton-calendar-grid" });
    const weekdays = grid.createDiv({ cls: "seiton-calendar-weekdays" });
    const WEEK_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
    for (const day of WEEK_LABELS) {
      weekdays.createSpan({ cls: "seiton-calendar-weekday", text: day });
    }

    // 4. 日付グリッド
    const daysContainer = grid.createDiv({ cls: "seiton-calendar-days" });
    const firstDay = new Date(this.currentYear, this.currentMonth, 1).getDay();
    const daysInMonth = new Date(
      this.currentYear,
      this.currentMonth + 1,
      0
    ).getDate();
    const daysInPrevMonth = new Date(
      this.currentYear,
      this.currentMonth,
      0
    ).getDate();

    const todayStr = this.todayKey();

    // 前月の空白・薄い日付
    for (let i = 0; i < firstDay; i += 1) {
      const prevDateNum = daysInPrevMonth - firstDay + 1 + i;
      daysContainer.createEl("span", {
        cls: "seiton-calendar-day is-outside",
        text: String(prevDateNum),
      });
    }

    // 当月の日付セル
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateKey = `${this.currentYear}-${String(
        this.currentMonth + 1
      ).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const isToday = dateKey === todayStr;
      const isSelected =
        this.selection.selectedDate === dateKey ||
        (this.selection.period === "today" && isToday);
      const hasMemo = this.memoDates.has(dateKey);

      let cls = "seiton-calendar-day";
      if (isToday) {
        cls += " is-today";
      }
      if (isSelected) {
        cls += " is-selected";
      }
      if (hasMemo) {
        cls += " has-memo";
      }

      const btn = daysContainer.createEl("button", {
        attr: { "aria-label": `${dateKey}`, type: "button" },
        cls,
      });

      btn.createSpan({
        cls: "seiton-calendar-day-num",
        text: String(day),
      });

      if (hasMemo) {
        btn.createSpan({ cls: "seiton-calendar-day-dot" });
      }

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const dateObj = dateKeyToLocalDate(dateKey);
        const weekdayStr = dateObj
          ? ` (${WEEK_LABELS[dateObj.getDay()] ?? ""})`
          : "";
        this.select({
          label: `${this.currentMonth + 1}月${day}日${weekdayStr}`,
          period: "all",
          selectedDate: dateKey,
        });
        this.closePopover();
      });
    }
  }

  private prevMonth(): void {
    if (this.currentMonth === 0) {
      this.currentMonth = 11;
      this.currentYear -= 1;
    } else {
      this.currentMonth -= 1;
    }
    this.renderPopover();
  }

  private nextMonth(): void {
    if (this.currentMonth === 11) {
      this.currentMonth = 0;
      this.currentYear += 1;
    } else {
      this.currentMonth += 1;
    }
    this.renderPopover();
  }

  private todayKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(now.getDate()).padStart(2, "0")}`;
  }

  private select(selection: CalendarSelection): void {
    this.selection = selection;
    this.updateTriggerState();
    this.options.onChange(selection);
  }

  private updateTriggerState(): void {
    if (this.labelEl) {
      this.labelEl.setText(this.selection.label);
    }
    const isFiltered =
      this.selection.period !== "all" || this.selection.selectedDate !== "";
    if (this.triggerBtn) {
      this.triggerBtn.classList.toggle("is-active", isFiltered);
    }
    if (this.clearBtn) {
      this.clearBtn.style.display = isFiltered ? "inline-flex" : "none";
    }
  }
}
