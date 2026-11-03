import { canonicalIsbn, isbn13ToIsbn10, normalizeIsbn } from "./isbn";

export const CALIL_CHECK_BASE = "https://api.calil.jp/check";

export const CALIL_TIME_DEPENDENT_NOTICE =
  "カーリルの蔵書状況は取得時点の情報です。時間依存データのため、最新の状況はカーリルで確認してください。";

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

export interface CalilLibraryHit {
  /** 図書館名 → 貸出状態。 */
  availability: Record<string, string>;
  /** 設定した自治体・システムに一致するか。 */
  configured: boolean;
  reserveUrl: string;
  status: string;
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

/** JSONP（`callback({...});`）なら中身だけを取り出す。 */
export function stripJsonp(text: string): string {
  const trimmed = text.trim();
  const match = /^[A-Za-z_$][\w$.]*\s*\(([\s\S]*)\)\s*;?$/u.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/** カーリルの応答（JSON/JSONP）をパースする。解釈できなければ null。 */
export function parseCalilPayload(text: string): unknown {
  const body = stripJsonp(text);
  if (body === "") {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** カンマ区切りのsystemidを、前後の空白を落として正規化する。 */
export function normalizeCalilSystemIds(value: string): string {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(",");
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

function fieldOf(value: unknown, key: string): unknown {
  return asObject(value)?.[key];
}

function textField(value: unknown, key: string): string {
  return textOf(fieldOf(value, key));
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

function configuredMatch(
  systemid: string,
  systemname: string,
  configuredLibrary: string
): boolean {
  const targets = configuredLibrary
    .normalize("NFKC")
    .split(",")
    .map((part) => part.trim().split(":")[0]?.trim() ?? "")
    .filter((part) => part !== "");
  if (targets.length === 0) {
    return false;
  }
  const lowerSystemId = systemid.toLowerCase();
  return targets.some(
    (target) =>
      lowerSystemId === target.toLowerCase() ||
      (systemname !== "" && systemname.includes(target))
  );
}

function calilHit(
  entry: unknown,
  configuredLibrary: string
): CalilLibraryHit | null {
  const record = asObject(entry);
  if (!record) {
    return null;
  }
  const availability: Record<string, string> = {};
  for (const [name, value] of Object.entries(asObject(record.libkey) ?? {})) {
    if (typeof value === "string" && value.trim() !== "") {
      availability[name] = value;
    }
  }
  const systemid = textField(record, "systemid");
  const systemname = textField(record, "systemname") || systemid;
  if (
    systemid === "" &&
    systemname === "" &&
    Object.keys(availability).length === 0
  ) {
    return null;
  }
  return {
    availability,
    configured: configuredMatch(systemid, systemname, configuredLibrary),
    reserveUrl: textField(record, "reserveurl"),
    status: textField(record, "status"),
    systemid,
    systemname,
  };
}

function calilBookEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asObject(value);
  if (!record) {
    return value === undefined || value === null ? [] : [value];
  }
  if (
    "systemid" in record ||
    "status" in record ||
    "libkey" in record ||
    "reserveurl" in record
  ) {
    return [record];
  }
  const entries: unknown[] = [];
  for (const [systemid, entry] of Object.entries(record)) {
    const nested = asObject(entry);
    if (!nested) {
      continue;
    }
    entries.push({
      ...nested,
      systemid: textField(nested, "systemid") || systemid,
    });
  }
  return entries;
}

/**
 * カーリル `/check` の応答から図書館ごとの状態を組み立てる。
 * `books` 形式と、ISBNをトップレベルに持つ旧形式の両方を受け付ける。
 * 同じシステムが重複した場合は最初の1件だけ残す。
 */
export function calilLibrariesFromPayload(
  payload: unknown,
  isbnValue: string,
  configuredLibrary = ""
): CalilLibraryHit[] {
  const root = asObject(payload);
  if (!root) {
    return [];
  }
  const normalized = normalizeIsbn(isbnValue);
  const canonical = canonicalIsbn(normalized);
  const matches = (key: string): boolean => {
    const keyIsbn = normalizeIsbn(key);
    if (keyIsbn === "") {
      return false;
    }
    return (
      keyIsbn === normalized ||
      keyIsbn === canonical ||
      (canonical !== "" && canonicalIsbn(keyIsbn) === canonical)
    );
  };

  const entries: unknown[] = [];
  const books = asObject(root.books);
  if (books) {
    for (const [key, value] of Object.entries(books)) {
      if (matches(key)) {
        entries.push(...calilBookEntries(value));
      }
    }
  }
  for (const [key, value] of Object.entries(root)) {
    if (matches(key)) {
      entries.push(...calilBookEntries(value));
    }
  }

  const hits = new Map<string, CalilLibraryHit>();
  for (const entry of entries) {
    const hit = calilHit(entry, configuredLibrary);
    if (!hit) {
      continue;
    }
    const mapKey = `${hit.systemid}\u0000${hit.systemname}`;
    if (!hits.has(mapKey)) {
      hits.set(mapKey, hit);
    }
  }

  return [...hits.values()].sort((left, right) => {
    if (left.configured !== right.configured) {
      return left.configured ? -1 : 1;
    }
    return left.systemname.localeCompare(right.systemname, "ja");
  });
}

export function calilContinuePending(payload: unknown): boolean {
  const value = fieldOf(payload, "continue");
  return value === 1 || value === "1";
}

export function calilSession(payload: unknown): string {
  return textField(payload, "session");
}

export function calilStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case "OK":
      return "蔵書あり";
    case "CACHE":
      return "蔵書あり";
    case "MAINTENANCE":
      return "メンテナンス中";
    case "ERROR":
      return "エラー";
    case "RUNNING":
      return "検索中";
    default:
      return status === "" ? "状態不明" : status;
  }
}

export function calilCheckUrl(
  isbnValue: string,
  appKey: string,
  systemId: string
): string {
  const isbn = canonicalIsbn(isbnValue) || normalizeIsbn(isbnValue);
  const params = new URLSearchParams({
    appkey: appKey,
    callback: "no",
    format: "json",
    isbn,
    systemid: systemId,
  });
  return `${CALIL_CHECK_BASE}?${params.toString()}`;
}

/** カーリルの検索継続（ポーリング）用URL。 */
export function calilSessionUrl(session: string, appKey: string): string {
  const params = new URLSearchParams({
    appkey: appKey,
    callback: "no",
    format: "json",
    session,
  });
  return `${CALIL_CHECK_BASE}?${params.toString()}`;
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
