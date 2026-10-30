import type { VocabularyEntry } from "../domain/vocabulary";

export interface VocabularyChipsOptions {
  current: string[];
  label: string;
  max?: number;
  onPick: (value: string) => void;
}

/** 既存のタグ・プロジェクト等を、押して追加するチップとして出す。 */
export function renderVocabularyChips(
  parent: HTMLElement,
  entries: VocabularyEntry[],
  options: VocabularyChipsOptions
): void {
  const current = new Set(
    options.current.map((value) => value.trim()).filter(Boolean)
  );
  const picks = entries
    .filter((entry) => !current.has(entry.value))
    .slice(0, options.max ?? 8);
  if (picks.length === 0) {
    return;
  }
  const wrap = parent.createDiv({ cls: "seiton-vocab" });
  wrap.createSpan({ cls: "seiton-vocab-label", text: options.label });
  for (const entry of picks) {
    const chip = wrap.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-vocab-chip",
      text: entry.count > 1 ? `${entry.value} ${entry.count}` : entry.value,
    });
    chip.addEventListener("click", () => {
      options.onPick(entry.value);
      chip.remove();
      if (wrap.querySelectorAll(".seiton-vocab-chip").length === 0) {
        wrap.remove();
      }
    });
  }
}

export function appendVocabularyValue(current: string, value: string): string {
  const parts = current
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.includes(value)) {
    parts.push(value);
  }
  return parts.join(", ");
}
