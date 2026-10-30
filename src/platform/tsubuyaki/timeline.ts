import { extractTags } from "../../domain/memoTags";
import { dateKeyOf, dateKeyToLocalDate } from "../../domain/time";
import type { MemoListItem } from "../../services/memoService";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export interface MemoTimelineFilters {
  activeTag: string;
  query: string;
  showDeleted: boolean;
}

export interface MemoDayGroup {
  count: number;
  items: MemoListItem[];
  key: string;
}

export interface MemoMonthGroup {
  count: number;
  days: MemoDayGroup[];
  key: string;
}

export interface MemoMeta {
  deleted: number;
  range: string;
  visible: number;
}

export interface MemoTagEntry {
  count: number;
  key: string;
  label: string;
}

export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function dayLabel(dateKey: string): string {
  const date = dateKeyToLocalDate(dateKey);
  if (!date) {
    return "日時不明";
  }
  const weekday = WEEKDAYS[date.getDay()] ?? "";
  return `${date.getMonth() + 1}月${date.getDate()}日（${weekday}）`;
}

export function monthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/u.exec(monthKey);
  if (!match) {
    return "日時不明";
  }
  return `${Number(match[1])}年${Number(match[2])}月`;
}

export function rangeLabel(first: string, last: string): string {
  const start = dateKeyToLocalDate(first);
  const end = dateKeyToLocalDate(last);
  if (!(start && end)) {
    return `${first}から${last}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日から${
      end.getMonth() + 1
    }月${end.getDate()}日`;
  }
  return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日から${end.getFullYear()}年${end.getMonth() + 1}月${end.getDate()}日`;
}

export function visibleMemos(
  items: MemoListItem[],
  showDeleted: boolean
): MemoListItem[] {
  return showDeleted
    ? items
    : items.filter((item) => item.entry.state !== "deleted");
}

export function filterMemos(
  items: MemoListItem[],
  filters: MemoTimelineFilters
): MemoListItem[] {
  const query = normalizeSearch(filters.query.trim());
  return visibleMemos(items, filters.showDeleted).filter((item) => {
    if (query !== "" && !normalizeSearch(item.entry.body).includes(query)) {
      return false;
    }
    if (filters.activeTag !== "") {
      const tags = extractTags(item.entry.body).map((tag) => tag.toLowerCase());
      if (!tags.includes(filters.activeTag)) {
        return false;
      }
    }
    return true;
  });
}

export function groupMemos(
  items: MemoListItem[],
  limit: number
): MemoMonthGroup[] {
  const visible = items.slice(0, limit);
  const months = new Map<string, Map<string, MemoListItem[]>>();
  for (const item of visible) {
    const dayKey = dateKeyOf(item.entry.at) || "unknown";
    const monthKey = dayKey === "unknown" ? "unknown" : dayKey.slice(0, 7);
    let month = months.get(monthKey);
    if (!month) {
      month = new Map<string, MemoListItem[]>();
      months.set(monthKey, month);
    }
    const day = month.get(dayKey) ?? [];
    day.push(item);
    month.set(dayKey, day);
  }

  return [...months.entries()].map(([key, days]) => {
    const dayGroups: MemoDayGroup[] = [...days.entries()].map(
      ([dayKey, dayItems]) => ({
        count: dayItems.length,
        items: dayItems,
        key: dayKey,
      })
    );
    return {
      count: dayGroups.reduce((sum, day) => sum + day.count, 0),
      days: dayGroups,
      key,
    };
  });
}

export function memoMeta(
  items: MemoListItem[],
  showDeleted: boolean
): MemoMeta {
  const visible = visibleMemos(items, showDeleted);
  const dates = visible
    .map((item) => dateKeyOf(item.entry.at))
    .filter((key) => key !== "")
    .sort();
  const first = dates[0];
  const last = dates.at(-1);
  return {
    deleted: items.length - visible.length,
    range: first && last ? rangeLabel(first, last) : "",
    visible: visible.length,
  };
}

export function tagEntries(items: MemoListItem[]): MemoTagEntry[] {
  const map = new Map<string, { count: number; label: string }>();
  for (const item of items) {
    for (const tag of extractTags(item.entry.body)) {
      const key = tag.toLowerCase();
      const current = map.get(key);
      if (current) {
        current.count += 1;
      } else {
        map.set(key, { count: 1, label: tag });
      }
    }
  }
  return [...map.entries()]
    .map(([key, value]) => ({ count: value.count, key, label: value.label }))
    .sort(
      (left, right) =>
        right.count - left.count || left.label.localeCompare(right.label, "ja")
    );
}
