import { normalizeLink } from "../../domain/links";
import { parseQuery } from "../../domain/query";
import type { IndexItem, VaultIndex } from "../../services/vaultIndex";
import { searchIndex, updatedAt } from "../../services/vaultIndex";

export type LibraryFilter =
  | "all"
  | "memo"
  | "class"
  | "webclip"
  | "book"
  | "other"
  | "prompt"
  | "idea"
  | "article"
  | "inbox"
  | "review"
  | "archived"
  | "pinned";

export type LibrarySort = "created" | "lecture" | "updated";

export interface LibraryQueryState {
  courseFilter: string;
  filter: LibraryFilter;
  listFilter: string;
  projectFilter: string;
  query: string;
  sort: LibrarySort;
  tagFilter: string;
}

export const OTHER_KINDS = [
  "collection",
  "migration-log",
  "note",
  "profile",
  "project",
  "reading",
  "task",
];

export function hitsForQuery(
  index: VaultIndex,
  state: LibraryQueryState,
  limit: number
): IndexItem[] {
  let kinds: string[] | undefined;
  let status: "review" | "archived" | "pinned" | undefined;
  let tags: string[] | undefined = state.tagFilter
    ? [state.tagFilter]
    : undefined;
  if (state.filter === "memo") {
    kinds = ["memo"];
  } else if (
    state.filter === "webclip" ||
    state.filter === "book" ||
    state.filter === "class"
  ) {
    kinds = [state.filter];
  } else if (state.filter === "other") {
    kinds = OTHER_KINDS;
  } else if (state.filter === "prompt") {
    kinds = ["prompt"];
  } else if (state.filter === "idea") {
    kinds = ["idea"];
  } else if (state.filter === "article") {
    kinds = ["article"];
  } else if (state.filter === "inbox") {
    tags = [...(tags ?? []), "受信箱"];
  } else if (
    state.filter === "review" ||
    state.filter === "archived" ||
    state.filter === "pinned"
  ) {
    status = state.filter;
  }

  const parsed = parseQuery(state.query);
  const effectiveKinds = parsed.kinds.length > 0 ? parsed.kinds : kinds;
  const effectiveTags = parsed.tags.length > 0 ? parsed.tags : tags;
  const effectiveProject = parsed.project
    ? normalizeLink(parsed.project)
    : state.projectFilter
      ? normalizeLink(state.projectFilter)
      : undefined;
  let effectiveStatus = status;
  if (
    parsed.status === "archived" ||
    parsed.status === "pinned" ||
    parsed.status === "review"
  ) {
    effectiveStatus = parsed.status;
  }
  return searchIndex(index, parsed.text, {
    course: state.courseFilter || undefined,
    includeDeleted: false,
    kinds: effectiveKinds,
    limit,
    list: parsed.list ?? (state.listFilter || undefined),
    project: effectiveProject,
    status: effectiveStatus,
    tags: effectiveTags,
  }).map((hit) => hit.item);
}

export function queryHits(
  index: VaultIndex,
  state: LibraryQueryState,
  limit: number
): IndexItem[] {
  const hits = hitsForQuery(index, state, limit);
  if (parseQuery(state.query).text !== "") {
    return hits;
  }
  if (state.sort === "created") {
    hits.sort((left, right) => createdValue(right) - createdValue(left));
  } else if (state.sort === "lecture") {
    hits.sort((left, right) => lectureDateOf(right) - lectureDateOf(left));
  } else {
    hits.sort((left, right) => updatedAt(right) - updatedAt(left));
  }
  return hits;
}

export function relaxedSuggestions(
  index: VaultIndex,
  state: LibraryQueryState,
  limit: number
): Array<{ count: number; token: string }> {
  const tokens = [
    ...new Set(
      state.query
        .split(/\s+/u)
        .map((token) => token.trim())
        .filter((token) => token !== "" && !token.includes(":"))
    ),
  ];
  if (tokens.length < 2) {
    return [];
  }
  return tokens
    .map((token) => ({
      count: hitsForQuery(index, { ...state, query: token }, 20).length,
      token,
    }))
    .filter((suggestion) => suggestion.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

export function createdValue(item: IndexItem): number {
  if (item.type === "note") {
    const parsed = Date.parse(item.created);
    return Number.isNaN(parsed) ? item.mtime : parsed;
  }
  const parsed = Date.parse(item.at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function lectureDateOf(item: IndexItem): number {
  if (item.type !== "note") {
    return updatedAt(item);
  }
  let match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(item.basename);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    ).getTime();
  }
  match = /^(\d{4})(\d{2})(\d{2})/u.exec(item.basename);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    ).getTime();
  }
  match = /^(\d{2})(\d{2})_/u.exec(item.basename);
  if (match) {
    return new Date(
      new Date(item.mtime).getFullYear(),
      Number(match[1]) - 1,
      Number(match[2])
    ).getTime();
  }
  const created = Date.parse(item.created);
  return Number.isNaN(created) ? item.mtime : created;
}
