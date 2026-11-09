export interface BookShelfItem {
  author: string;
  category: string;
  cover: string;
  finished: string;
  isbn: string;
  owned: string;
  path: string;
  rating: string;
  series: string;
  status: string;
  title: string;
  updated: number;
}

export type BookStatusFilter = "all" | "tbr" | "reading" | "read";
export type BookOwnershipFilter = "all" | "owned" | "unowned";
export type BookSort = "author" | "finished" | "title" | "updated";

export interface BookFilters {
  category: string;
  owned: BookOwnershipFilter;
  query: string;
  sort: BookSort;
  status: BookStatusFilter;
}

export const DEFAULT_BOOK_FILTERS: BookFilters = {
  category: "all",
  owned: "all",
  query: "",
  sort: "updated",
  status: "all",
};

export function bookStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    read: "読了",
    reading: "読書中",
    tbr: "積読",
  };
  return labels[status] ?? status;
}

export function bookOwnershipLabel(value: string): string {
  const labels: Record<string, string> = {
    owned: "所持",
    unowned: "未所持",
  };
  return labels[value] ?? value;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

export function filterBooks(
  items: BookShelfItem[],
  filters: BookFilters
): BookShelfItem[] {
  const query = normalize(filters.query);
  const filtered = items.filter((item) => {
    if (filters.status !== "all" && item.status !== filters.status) {
      return false;
    }
    if (filters.category !== "all" && item.category !== filters.category) {
      return false;
    }
    if (filters.owned !== "all" && item.owned !== filters.owned) {
      return false;
    }
    if (query === "") {
      return true;
    }
    return [item.title, item.author, item.category, item.series].some((value) =>
      normalize(value).includes(query)
    );
  });

  return filtered.sort((left, right) =>
    compareBooks(left, right, filters.sort)
  );
}

function compareBooks(
  left: BookShelfItem,
  right: BookShelfItem,
  sort: BookSort
): number {
  switch (sort) {
    case "title":
      return left.title.localeCompare(right.title, "ja");
    case "author":
      return left.author.localeCompare(right.author, "ja");
    case "finished":
      if (left.finished === right.finished) {
        return right.updated - left.updated;
      }
      if (left.finished === "") {
        return 1;
      }
      if (right.finished === "") {
        return -1;
      }
      return right.finished.localeCompare(left.finished);
    default:
      return right.updated - left.updated;
  }
}

export function bookCategories(items: BookShelfItem[]): string[] {
  return [
    ...new Set(
      items
        .map((item) => item.category.trim())
        .filter((category) => category !== "")
    ),
  ].sort((left, right) => left.localeCompare(right, "ja"));
}

export interface BookReadingStats {
  readingCount: number;
  readThisMonth: number;
  readThisYear: number;
}

export function computeBookStats(
  items: BookShelfItem[],
  now = new Date()
): BookReadingStats {
  const currentYearStr = String(now.getFullYear());
  const currentMonthStr = `${currentYearStr}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  let readingCount = 0;
  let readThisMonth = 0;
  let readThisYear = 0;

  for (const item of items) {
    if (item.status === "reading") {
      readingCount += 1;
    } else if (item.status === "read") {
      let finishedDate = item.finished.trim();
      if (!finishedDate && item.updated) {
        const d = new Date(item.updated);
        finishedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
      if (finishedDate.startsWith(currentMonthStr)) {
        readThisMonth += 1;
      }
      if (finishedDate.startsWith(currentYearStr)) {
        readThisYear += 1;
      }
    }
  }

  return { readingCount, readThisMonth, readThisYear };
}

export interface BookDisplayGroup {
  item: BookShelfItem;
  seriesCount?: number;
}

export function groupBooksBySeries(items: BookShelfItem[]): BookDisplayGroup[] {
  const result: BookDisplayGroup[] = [];
  const seriesMap = new Map<string, BookShelfItem[]>();

  for (const item of items) {
    const series = item.series.trim();
    if (series !== "") {
      const list = seriesMap.get(series);
      if (list) {
        list.push(item);
      } else {
        seriesMap.set(series, [item]);
      }
    }
  }

  const seenSeries = new Set<string>();

  for (const item of items) {
    const series = item.series.trim();
    if (series === "") {
      result.push({ item });
    } else {
      if (seenSeries.has(series)) {
        continue;
      }
      seenSeries.add(series);
      const list = seriesMap.get(series) ?? [item];
      const first = list[0];
      if (first) {
        result.push({
          item: first,
          seriesCount: list.length,
        });
      }
    }
  }

  return result;
}
