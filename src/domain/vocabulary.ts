export interface VocabularyEntry {
  count: number;
  value: string;
}

/** 既存ノートの値を出現回数順に集計する。 */
export function buildVocabulary(values: string[][]): VocabularyEntry[] {
  const counts = new Map<string, number>();
  for (const list of values) {
    for (const raw of list) {
      const value = raw.trim();
      if (value === "") {
        continue;
      }
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ count, value }))
    .sort(
      (left, right) =>
        right.count - left.count || left.value.localeCompare(right.value, "ja")
    );
}
