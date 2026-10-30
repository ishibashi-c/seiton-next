/**
 * 動画URLからサムネイルを得るための純粋ロジック。
 * YouTubeは公開CDNのサムネイルを使う（APIキー不要）。
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/u;

/** YouTubeのURLから動画IDを取り出す。対応外なら null。 */
export function youtubeIdFromUrl(value: string): string | null {
  const raw = value.trim();
  if (raw === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./u, "").toLowerCase();
  if (host === "youtu.be") {
    const id = url.pathname.split("/").find((segment) => segment !== "") ?? "";
    return YOUTUBE_ID.test(id) ? id : null;
  }
  if (
    host !== "youtube.com" &&
    host !== "m.youtube.com" &&
    !host.endsWith(".youtube.com")
  ) {
    return null;
  }
  const v = url.searchParams.get("v");
  if (v && YOUTUBE_ID.test(v)) {
    return v;
  }
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const kind = parts[0];
  if (
    kind === "shorts" ||
    kind === "embed" ||
    kind === "live" ||
    kind === "v"
  ) {
    const id = parts[1] ?? "";
    return YOUTUBE_ID.test(id) ? id : null;
  }
  return null;
}

/** 16:9・黒帯なしのサムネイルURL。mqdefault は 320x180。 */
export function youtubeThumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

/** 本文やsourceから、最初に見つかったYouTubeのサムネイルURLを返す。 */
export function findYoutubeThumbnail(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s<>"'）)】\]]+/gu) ?? [];
  for (const url of urls) {
    const id = youtubeIdFromUrl(url);
    if (id !== null) {
      return youtubeThumbnailUrl(id);
    }
  }
  return null;
}
