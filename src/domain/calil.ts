import {
  type CalilLibraryHit,
  calilStatusLabel,
  isbn13ToIsbn10,
  normalizeIsbn,
} from "./book";

export const CALIL_LIBRARY_BASE = "https://api.calil.jp/library";
export const CALIL_BOOK_BASE = "https://calil.jp/book";
export const CALIL_LIBRARY_PAGE_BASE = "https://calil.jp/library";

export interface CalilLibraryInfo {
  address: string;
  formal: string;
  geocode: string;
  libid: string;
  libkey: string;
  systemid: string;
  systemname: string;
}

export interface CalilBranch {
  address: string;
  configured: boolean;
  formal: string;
  geocode: string;
  libid: string;
  libkey: string;
  reserveUrl: string;
  state: string;
  systemid: string;
  systemname: string;
}

export interface CalilLibrarySelection {
  /** systemid（小文字） -> 表示対象のlibid。空なら全館。 */
  branchIds: Record<string, string[]>;
  /** 設定画面や結果表示に使う元の表記。 */
  display: string;
  /** APIへ渡すsystemid。libidは含めない。 */
  systems: string[];
}

/**
 * `systemid` または `systemid:libid` のカンマ区切りを解釈する。
 * Calilの/checkはlibidを受け付けないため、libidは表示の絞り込みにだけ使う。
 */
export function parseCalilLibrarySelection(
  value: string
): CalilLibrarySelection {
  const systems: string[] = [];
  const branchIds: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry === "") {
      continue;
    }
    const [systemPart, ...rest] = entry.split(":");
    const systemid = systemPart?.trim() ?? "";
    if (systemid === "") {
      continue;
    }
    const key = systemid.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      systems.push(systemid);
    }
    const libid = rest.join(":").trim();
    if (libid !== "") {
      const list = branchIds[key] ?? [];
      if (!list.includes(libid)) {
        list.push(libid);
      }
      branchIds[key] = list;
    }
  }
  return {
    branchIds,
    display: value.trim(),
    systems,
  };
}

function branchFilterFor(
  branchIds: Record<string, string[]>,
  systemid: string
): string[] {
  return branchIds[systemid.toLowerCase()] ?? [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function keysOf(value: unknown): string[] {
  if (typeof value === "string") {
    return [value.trim()].filter((item) => item !== "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => textOf(item)).filter((item) => item !== "");
  }
  return [];
}

/** カーリルの `/library` 応答を図書館メタデータへ変換する。 */
export function calilLibraryInfoFromPayload(
  payload: unknown
): CalilLibraryInfo[] {
  const entries = Array.isArray(payload)
    ? payload
    : Object.values(asObject(payload) ?? {});
  const result: CalilLibraryInfo[] = [];
  for (const entry of entries) {
    const record = asObject(entry);
    if (!record) {
      continue;
    }
    const systemid = textOf(record.systemid);
    const systemname = textOf(record.systemname) || systemid;
    const formal = textOf(record.formal) || textOf(record.short);
    const keys = keysOf(record.libkey);
    for (const libkey of keys.length > 0 ? keys : [""]) {
      if (systemid === "" && libkey === "") {
        continue;
      }
      result.push({
        address: textOf(record.address),
        formal: formal || libkey,
        geocode: textOf(record.geocode),
        libid: textOf(record.libid),
        libkey,
        systemid,
        systemname,
      });
    }
  }
  return result;
}

export function calilLibraryUrl(systemid: string, appKey: string): string {
  const params = new URLSearchParams({
    appkey: appKey,
    callback: "no",
    format: "json",
    limit: "100",
    systemid,
  });
  return `${CALIL_LIBRARY_BASE}?${params.toString()}`;
}

function humanSystemName(systemname: string, systemid: string): string {
  const name = systemname.trim();
  if (name === "" || name.toLowerCase() === systemid.trim().toLowerCase()) {
    return "名称未取得";
  }
  return name;
}

/**
 * `/check` のシステム結果と `/library` のメタデータを館単位へ結合する。
 * メタデータが見つからなくても館名だけで表示できるようにする。
 */
export function calilBranchesFromLibraries(
  libraries: CalilLibraryHit[],
  infos: CalilLibraryInfo[],
  branchIds: Record<string, string[]> = {}
): CalilBranch[] {
  const infoBySystem = new Map<string, CalilLibraryInfo[]>();
  for (const info of infos) {
    const list = infoBySystem.get(info.systemid) ?? [];
    list.push(info);
    infoBySystem.set(info.systemid, list);
  }

  const branches: CalilBranch[] = [];
  for (const library of libraries) {
    const entries = Object.entries(library.availability);
    const systemInfos = infoBySystem.get(library.systemid) ?? [];
    const fallbackName = humanSystemName(library.systemname, library.systemid);
    if (entries.length === 0) {
      const status = library.status.trim().toUpperCase();
      const state =
        status === "OK" || status === "CACHE"
          ? "蔵書なし"
          : calilStatusLabel(library.status);
      const info = systemInfos[0];
      branches.push({
        address: "",
        configured: library.configured,
        formal: info?.formal || fallbackName,
        geocode: "",
        libid: info?.libid ?? "",
        libkey: "",
        reserveUrl: library.reserveUrl,
        state,
        systemid: library.systemid,
        systemname: info?.systemname || fallbackName,
      });
      continue;
    }
    for (const [libkey, state] of entries) {
      const info =
        systemInfos.find((item) => item.libkey === libkey) ??
        systemInfos.find(
          (item) => item.formal !== "" && item.formal.includes(libkey)
        );
      branches.push({
        address: info?.address ?? "",
        configured: library.configured,
        formal: info?.formal || libkey || fallbackName,
        geocode: info?.geocode ?? "",
        libid: info?.libid ?? "",
        libkey,
        reserveUrl: library.reserveUrl,
        state: state || calilStatusLabel(library.status),
        systemid: library.systemid,
        systemname: info?.systemname || fallbackName,
      });
    }
  }

  const wanted = (branch: CalilBranch): boolean => {
    const allowed = branchFilterFor(branchIds, branch.systemid);
    return allowed.length === 0 || allowed.includes(branch.libid);
  };
  return branches.filter(wanted).sort(compareBranches);
}

function compareBranches(left: CalilBranch, right: CalilBranch): number {
  if (left.configured !== right.configured) {
    return left.configured ? -1 : 1;
  }
  const rank = calilStatusRank(left.state) - calilStatusRank(right.state);
  if (rank !== 0) {
    return rank;
  }
  return left.formal.localeCompare(right.formal, "ja");
}

/** 貸出可 > 蔵書あり > 館内のみ > 予約/準備/休館 > 貸出中 > なし。 */
export function calilStatusRank(state: string): number {
  switch (state.trim()) {
    case "貸出可":
      return 0;
    case "蔵書あり":
      return 1;
    case "館内のみ":
      return 2;
    case "予約中":
      return 3;
    case "準備中":
      return 4;
    case "休館中":
      return 5;
    case "貸出中":
      return 6;
    case "蔵書なし":
      return 7;
    case "検索中":
      return 8;
    case "エラー":
    case "メンテナンス中":
      return 9;
    default:
      return 10;
  }
}

/** 一覧に出す代表館。設定済み・貸出可を優先する。 */
export function calilBestBranch(branches: CalilBranch[]): CalilBranch | null {
  let best: CalilBranch | null = null;
  for (const branch of branches) {
    if (!best) {
      best = branch;
      continue;
    }
    if (compareBranches(branch, best) < 0) {
      best = branch;
    }
  }
  return best;
}

export function calilAvailableCount(branches: CalilBranch[]): number {
  return branches.filter((branch) => branch.state.includes("貸出可")).length;
}

/** 蔵書なし・検索中・エラー以外は「その館に本がある」とみなす。 */
export function calilHoldingCount(branches: CalilBranch[]): number {
  return branches.filter(
    (branch) =>
      branch.state !== "" &&
      !branch.state.includes("蔵書なし") &&
      !branch.state.includes("検索中") &&
      !branch.state.includes("エラー")
  ).length;
}

export function calilBookUrl(isbnValue: string): string {
  const isbn = normalizeIsbn(isbnValue);
  const isbn10 = isbn13ToIsbn10(isbn) || isbn;
  return `${CALIL_BOOK_BASE}/${encodeURIComponent(isbn10)}`;
}

export function calilLibraryPageUrl(branch: CalilBranch): string {
  if (branch.libid !== "") {
    return `${CALIL_LIBRARY_PAGE_BASE}/${encodeURIComponent(
      branch.libid
    )}/${encodeURIComponent(branch.formal || branch.libkey)}`;
  }
  return `${CALIL_LIBRARY_PAGE_BASE}/search?s=${encodeURIComponent(
    branch.systemid
  )}&k=${encodeURIComponent(branch.libkey)}`;
}

export function calilMapUrl(branch: CalilBranch): string {
  const query = branch.address.trim();
  return query === ""
    ? ""
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        query
      )}`;
}
