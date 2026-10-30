/**
 * カーリルの結果を「本の状態」として扱うための純粋ロジック。
 * 保存はノートの frontmatter と `Seiton/System/Calil/{ISBN}.json` の2箇所。
 */

import type { CalilBranch } from "./calil";
import { calilAvailableCount } from "./calil";

export type CalilState = "available" | "loaned" | "unknown";

export interface CalilSummary {
  /** 最終確認日時（ISO文字列）。未確認なら空。 */
  checkedAt: string;
  /** 貸出可の館数。 */
  hits: number;
  /** 確認した図書館IDの並び。 */
  library: string;
  state: CalilState;
  /** 調べた館数。 */
  total: number;
}

export const CALIL_STALE_DAYS = 7;

export const CALIL_STATE_LABELS: Record<CalilState, string> = {
  available: "貸出可",
  loaned: "貸出中",
  unknown: "未確認",
};

export function emptyCalilSummary(): CalilSummary {
  return { checkedAt: "", hits: 0, library: "", state: "unknown", total: 0 };
}

/** 検索結果から、保存する要約を作る。 */
export function summarizeCalil(input: {
  branches: CalilBranch[];
  checkedAt: string;
  library: string;
}): CalilSummary {
  const total = input.branches.length;
  const hits = calilAvailableCount(input.branches);
  let state: CalilState = "unknown";
  if (hits > 0) {
    state = "available";
  } else if (total > 0) {
    state = "loaned";
  }
  return {
    checkedAt: input.checkedAt,
    hits,
    library: input.library,
    state,
    total,
  };
}

/** 確認から日数が経っているか。日時が無い・壊れている場合は古い扱い。 */
export function isCalilStale(
  summary: CalilSummary,
  now: Date,
  days = CALIL_STALE_DAYS
): boolean {
  if (summary.checkedAt === "") {
    return true;
  }
  const checked = Date.parse(summary.checkedAt);
  if (!Number.isFinite(checked)) {
    return true;
  }
  return now.getTime() - checked > days * 24 * 60 * 60 * 1000;
}

/** 本棚・ライブラリに出す短いラベル。未確認と期限切れは数字を出さない。 */
export function calilBadgeText(summary: CalilSummary, now: Date): string {
  if (summary.state === "unknown" || summary.checkedAt === "") {
    return "未確認";
  }
  if (isCalilStale(summary, now)) {
    return "要確認";
  }
  if (summary.state === "available") {
    return `貸出可 ${summary.hits}`;
  }
  return "貸出中";
}

/** `2026-10-30T15:30:00+09:00` を `10/30` にする。壊れていれば空。 */
export function calilCheckedLabel(checkedAt: string): string {
  const parsed = Date.parse(checkedAt);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  const date = new Date(parsed);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** frontmatter から要約を読む。無ければ未確認。 */
export function calilSummaryFromFrontmatter(
  frontmatter: Record<string, unknown>
): CalilSummary {
  const rawState = stringValue(frontmatter.calil_state);
  const state: CalilState =
    rawState === "available" || rawState === "loaned" ? rawState : "unknown";
  return {
    checkedAt: stringValue(frontmatter.calil_checked),
    hits: numberValue(frontmatter.calil_hits),
    library: stringValue(frontmatter.calil_library),
    state,
    total: numberValue(frontmatter.calil_total),
  };
}
