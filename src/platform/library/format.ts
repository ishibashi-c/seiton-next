import type { NoteRecord } from "../../services/vaultIndex";

export const KIND_LABELS: Record<string, string> = {
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

export function shortDateTime(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) {
    return at.slice(0, 10);
  }
  return `${parsed.getMonth() + 1}/${parsed.getDate()} ${String(
    parsed.getHours()
  ).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
}

export function memoPreview(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function bookFallbackMeta(note: NoteRecord): string {
  return [note.book.book_author, readingStatusLabel(note.book.reading_status)]
    .filter(Boolean)
    .join(" · ");
}

export function readingStatusLabel(status: string | null | undefined): string {
  const labels: Record<string, string> = {
    read: "読了",
    reading: "読書中",
    tbr: "積読",
  };
  if (!status) {
    return "";
  }
  return labels[status] ?? status;
}

export function shortDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
