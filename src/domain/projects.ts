import type { PromptSessionSummary } from "../services/promptService";
import { normalizeLink } from "./links";

/** 一覧と詳細で同じセッション数を出すための集計。 */
export function countSessionsByProject(
  sessions: PromptSessionSummary[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.project === null || session.project.trim() === "") {
      continue;
    }
    const key = normalizeLink(session.project);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
