import type { App } from "obsidian";
import { normalizePath, TFile as TFileClass } from "obsidian";
import { CLASS_SCHEDULE_FILE, SYSTEM_FOLDER } from "../config";
import {
  type ClassSessionEntry,
  parseClassScheduleMarkdown,
  serializeClassScheduleMarkdown,
} from "../domain/classSchedule";

export async function loadClassSchedule(
  app: App
): Promise<ClassSessionEntry[]> {
  const file = app.vault.getAbstractFileByPath(
    normalizePath(CLASS_SCHEDULE_FILE)
  );
  if (!(file instanceof TFileClass)) {
    return [];
  }
  try {
    const text = await app.vault.cachedRead(file);
    return parseClassScheduleMarkdown(text);
  } catch {
    return [];
  }
}

export async function saveClassSchedule(
  app: App,
  entries: readonly ClassSessionEntry[]
): Promise<void> {
  const content = serializeClassScheduleMarkdown(entries);
  const path = normalizePath(CLASS_SCHEDULE_FILE);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFileClass) {
    await app.vault.modify(existing, content);
    return;
  }

  const segments = normalizePath(SYSTEM_FOLDER)
    .split("/")
    .filter((segment) => segment !== "");
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {
        // 既存フォルダなら無視
      }
    }
  }

  await app.vault.create(path, content);
}
