/**
 * 旧形式のショートカット。いまは `Seiton/System/Links.md` が正本で、
 * ここは移行コマンド用に読むだけ。
 */
export interface SeitonShortcut {
  folderId: string | null;
  id: string;
  label: string;
  target: string;
}

export interface SeitonShortcutFolder {
  id: string;
  name: string;
}

export interface CalilLastResult {
  checkedAt: string;
  configuredHits: number;
  library: string;
  title: string;
  totalLibraries: number;
}

export interface SeitonSettings {
  calilApiKey: string;
  calilLastResults: Record<string, CalilLastResult>;
  calilLibrary: string;
  enableUrlPreview: boolean;
  googleBooksApiKey: string;
  maxSearchResults: number;
  shortcutFavicons: boolean;
  /** @deprecated 移行コマンド専用。書き込みはしない。 */
  shortcutFolders: SeitonShortcutFolder[];
  /** @deprecated 移行コマンド専用。書き込みはしない。 */
  shortcuts: SeitonShortcut[];
}

export const DEFAULT_SETTINGS: SeitonSettings = {
  calilApiKey: "",
  calilLastResults: {},
  calilLibrary: "",
  enableUrlPreview: true,
  googleBooksApiKey: "",
  maxSearchResults: 500,
  shortcutFavicons: false,
  shortcutFolders: [],
  shortcuts: [],
};

function shortcutHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function normalizeFolders(value: unknown): SeitonShortcutFolder[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SeitonShortcutFolder[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const raw = entry as Partial<SeitonShortcutFolder>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name === "") {
      continue;
    }
    let id =
      typeof raw.id === "string" && raw.id !== ""
        ? raw.id
        : `f_${shortcutHash(name)}`;
    if (ids.has(id)) {
      id = `${id}_${index}`;
    }
    ids.add(id);
    result.push({ id, name });
  }
  return result.slice(0, 16);
}

function normalizeShortcuts(
  value: unknown,
  folderIds: Set<string>
): SeitonShortcut[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SeitonShortcut[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const raw = entry as Partial<SeitonShortcut>;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const target = typeof raw.target === "string" ? raw.target.trim() : "";
    if (label === "" || target === "") {
      continue;
    }
    let id =
      typeof raw.id === "string" && raw.id !== ""
        ? raw.id
        : `s_${shortcutHash(`${label}:${target}`)}`;
    if (ids.has(id)) {
      id = `${id}_${index}`;
    }
    ids.add(id);
    const folderId =
      typeof raw.folderId === "string" && folderIds.has(raw.folderId)
        ? raw.folderId
        : null;
    result.push({ folderId, id, label, target });
  }
  return result.slice(0, 24);
}

function normalizeCalilLastResults(
  value: unknown
): Record<string, CalilLastResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries: [string, CalilLastResult][] = [];
  for (const [isbn, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as Partial<CalilLastResult>;
    const checkedAt =
      typeof record.checkedAt === "string" ? record.checkedAt : "";
    if (isbn.trim() === "" || checkedAt === "") {
      continue;
    }
    entries.push([
      isbn,
      {
        checkedAt,
        configuredHits: Math.max(0, Number(record.configuredHits ?? 0) || 0),
        library: typeof record.library === "string" ? record.library : "",
        title: typeof record.title === "string" ? record.title : "",
        totalLibraries: Math.max(0, Number(record.totalLibraries ?? 0) || 0),
      },
    ]);
  }
  entries.sort((left, right) =>
    right[1].checkedAt.localeCompare(left[1].checkedAt)
  );
  return Object.fromEntries(entries.slice(0, 500));
}

export function normalizeSettings(
  value: Partial<SeitonSettings> | null | undefined
): SeitonSettings {
  const shortcutFolders = normalizeFolders(value?.shortcutFolders);
  return {
    ...DEFAULT_SETTINGS,
    ...(value ?? {}),
    calilLastResults: normalizeCalilLastResults(value?.calilLastResults),
    googleBooksApiKey:
      typeof value?.googleBooksApiKey === "string"
        ? value.googleBooksApiKey.trim()
        : "",
    maxSearchResults: Math.min(
      1000,
      Math.max(
        20,
        Number(value?.maxSearchResults ?? DEFAULT_SETTINGS.maxSearchResults)
      )
    ),
    shortcutFavicons: Boolean(value?.shortcutFavicons ?? false),
    shortcutFolders,
    shortcuts: normalizeShortcuts(
      value?.shortcuts,
      new Set(shortcutFolders.map((folder) => folder.id))
    ),
  };
}
