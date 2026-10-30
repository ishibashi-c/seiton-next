/** Web Clipperが保存した kind:webclip ノートの認識と、明示操作時のURLプレビュー。 */

import Defuddle from "defuddle/full";
import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import { NOTES_FOLDER } from "../config";
import { userMessageOf } from "../domain/errors";
import { buildFrontmatter, yamlQuoted } from "../domain/frontmatter";
import { domainOf, normalizeSourceUrl } from "../domain/network";
import { sanitizeNoteTitle } from "../domain/notes";
import { formatLocalIso } from "../domain/time";
import type { WebClipMetadata } from "../domain/webclip";
import {
  parseHtmlMetadata,
  tidyMarkdownLinks,
  webClipCardFromProperties,
  webClipDuplicateKey,
} from "../domain/webclip";
import type { HttpClient, HttpResponse } from "./http";
import { headerValue } from "./http";
import type { PropertyService, PropertyValue } from "./propertyService";
import type { SeitonSettings } from "./settings";

export interface WebClipCapture {
  author: string;
  body: string;
  description: string;
  image: string;
  published: string;
  title: string;
  url: string;
}

export interface WebClipDuplicate {
  path: string;
  title: string;
}

export interface WebClipNote {
  description: string;
  domain: string;
  duplicates: number;
  image: string;
  path: string;
  source: string;
  title: string;
}

interface CacheEntry {
  expires: number;
  preview: WebClipMetadata;
}

export class WebClipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebClipError";
  }
}

/** Web Clipperの保存物を読む。ノート本文は変更しない。 */
export class WebClipService {
  private readonly app: App;
  private readonly http: HttpClient;
  private readonly properties: PropertyService;
  private readonly getSettings: () => SeitonSettings;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    app: App,
    http: HttpClient,
    properties: PropertyService,
    getSettings: () => SeitonSettings
  ) {
    this.app = app;
    this.http = http;
    this.properties = properties;
    this.getSettings = getSettings;
  }

  async listWebClips(): Promise<WebClipNote[]> {
    const notes: WebClipNote[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter =
        (this.app.metadataCache.getFileCache(file)?.frontmatter as
          | Record<string, unknown>
          | undefined) ?? {};
      // Ishibashi Web Clipper V2 は type: webclip を書くため、両方を受け付ける。
      if (frontmatter.kind !== "webclip" && frontmatter.type !== "webclip") {
        continue;
      }
      const source =
        typeof frontmatter.source === "string" ? frontmatter.source : "";
      const title =
        typeof frontmatter.title === "string"
          ? frontmatter.title
          : file.basename;
      const description =
        typeof frontmatter.description === "string"
          ? frontmatter.description
          : "";
      const image =
        typeof frontmatter.image === "string" ? frontmatter.image : "";
      notes.push({
        description,
        domain: webClipCardFromProperties(source, title, description, image)
          .domain,
        duplicates: 0,
        image,
        path: file.path,
        source,
        title,
      });
    }

    const counts = new Map<string, number>();
    for (const note of notes) {
      if (note.source === "") {
        continue;
      }
      const key = webClipDuplicateKey(note.source);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const note of notes) {
      note.duplicates =
        note.source === ""
          ? 0
          : (counts.get(webClipDuplicateKey(note.source)) ?? 0);
    }
    return notes;
  }

  async preview(url: string): Promise<WebClipMetadata> {
    const settings = this.getSettings();
    if (!settings.enableUrlPreview) {
      throw new WebClipError("URLプレビューは設定で無効になっています。");
    }
    const normalized = normalizeSourceUrl(url);
    if (!normalized) {
      throw new WebClipError(
        "http/httpsのURLだけをプレビューできます。localhostやプライベートIPは拒否します。"
      );
    }

    const cached = this.cache.get(normalized);
    if (cached && cached.expires > Date.now()) {
      return cached.preview;
    }

    let response: HttpResponse;
    try {
      response = await this.http.get(normalized);
    } catch (error) {
      throw new WebClipError(
        `URLを取得できませんでした。${userMessageOf(error)}`,
        { cause: error }
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new WebClipError(
        `URLの取得に失敗しました（HTTP ${response.status}）。`
      );
    }
    const contentType = headerValue(response.headers, "content-type");
    if (contentType !== "" && !contentType.toLowerCase().includes("html")) {
      throw new WebClipError("HTMLではないため、プレビューを作れません。");
    }

    const preview = parseHtmlMetadata(response.text, normalized);
    this.cache.set(normalized, {
      expires: Date.now() + 30 * 60 * 1000,
      preview,
    });
    return preview;
  }

  /**
   * ページを取得し、Defuddleで本文をMarkdown化する。
   * メタデータが取れなくてもURLは返す。本文が空でも呼び出し側でフォールバックする。
   */
  async capturePage(rawUrl: string): Promise<WebClipCapture> {
    const settings = this.getSettings();
    if (!settings.enableUrlPreview) {
      throw new WebClipError(
        "設定の「URLプレビュー」が無効です。設定から有効にしてください。"
      );
    }
    const url = normalizeSourceUrl(rawUrl);
    if (!url) {
      throw new WebClipError(
        "http/httpsのURLだけを保存できます。localhostやプライベートIPは拒否します。"
      );
    }

    let response: HttpResponse;
    try {
      response = await this.http.get(url);
    } catch (error) {
      throw new WebClipError(
        `ページを取得できませんでした。${userMessageOf(error)}`,
        {
          cause: error,
        }
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new WebClipError(
        `ページの取得に失敗しました（HTTP ${response.status}）。`
      );
    }
    const contentType = headerValue(response.headers, "content-type");
    if (contentType !== "" && !contentType.toLowerCase().includes("html")) {
      throw new WebClipError("HTMLではないため、本文を抽出できません。");
    }

    const fallback = parseHtmlMetadata(response.text, url);
    let body = "";
    let author = "";
    let published = "";
    let title = fallback.title;
    let description = fallback.description;
    let image = fallback.imageUrl;
    let domain = fallback.domain;

    try {
      const doc = new DOMParser().parseFromString(response.text, "text/html");
      const base = doc.createElement("base");
      base.href = url;
      doc.head.prepend(base);
      const result = new Defuddle(doc, {
        markdown: true,
        url,
        useAsync: false,
      }).parse();
      body = tidyMarkdownLinks((result.content ?? "").trim());
      author = result.author ?? "";
      published = result.published ?? "";
      title = result.title || title;
      description = result.description || description;
      image = result.image || image;
      domain = result.domain || domain;
    } catch {
      // 本文抽出に失敗しても、メタデータまたはURLだけで保存できる。
    }

    return {
      author: author.trim(),
      body: body.slice(0, 200_000),
      description: description.trim(),
      image,
      published: published.trim(),
      title: (title || domain || url).trim(),
      url,
    };
  }

  /** 同じURL（クエリ・ハッシュを除く）の既存クリップを探す。 */
  async findDuplicate(rawUrl: string): Promise<WebClipDuplicate | null> {
    const key = webClipDuplicateKey(rawUrl);
    if (key === "") {
      return null;
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter =
        (this.app.metadataCache.getFileCache(file)?.frontmatter as
          | Record<string, unknown>
          | undefined) ?? {};
      if (frontmatter.kind !== "webclip" && frontmatter.type !== "webclip") {
        continue;
      }
      const source =
        typeof frontmatter.source === "string" ? frontmatter.source : "";
      if (webClipDuplicateKey(source) !== key) {
        continue;
      }
      const title =
        typeof frontmatter.title === "string"
          ? frontmatter.title
          : file.basename;
      return { path: file.path, title };
    }
    return null;
  }

  /** 確認モーダルから、メタデータと本文を持つクリップを作る。 */
  async createCaptureNote(input: {
    author?: string;
    body?: string;
    description?: string;
    image?: string;
    note?: string;
    published?: string;
    source: string;
    tags: string[];
    title: string;
  }): Promise<string> {
    const source = normalizeSourceUrl(input.source);
    if (!source) {
      throw new WebClipError("保存できるURLではありません。");
    }
    const now = new Date();
    const created = formatLocalIso(now);
    const title = input.title.trim() || domainOf(source) || "Webクリップ";
    const tags = [
      ...new Set(
        input.tags
          .map((tag) => tag.trim().replace(/^#/u, ""))
          .filter((tag) => tag !== "")
      ),
    ];
    const fields: Record<string, string> = {
      created: `"${created}"`,
      kind: "webclip",
      source: yamlQuoted(source),
      title: yamlQuoted(title),
    };
    if (input.description?.trim()) {
      fields.description = yamlQuoted(input.description.trim());
    }
    if (input.image?.trim()) {
      fields.image = yamlQuoted(input.image.trim());
    }
    if (input.author?.trim()) {
      fields.author = yamlQuoted(input.author.trim());
    }
    if (input.published?.trim()) {
      fields.published = yamlQuoted(input.published.trim());
    }
    if (tags.length > 0) {
      fields.tags = `\n${tags
        .map((tag) => `  - ${yamlQuoted(tag)}`)
        .join("\n")}`;
    }
    const frontmatter = buildFrontmatter(fields, "\n");
    const bodyParts: string[] = [];
    if (input.note?.trim()) {
      bodyParts.push(`> ${input.note.trim().split("\n").join("\n> ")}`);
    }
    if (input.body?.trim()) {
      bodyParts.push(input.body.trim());
    }
    if (bodyParts.length === 0) {
      bodyParts.push(`[${source}](${source})`);
    }
    const content = `${frontmatter}\n${bodyParts.join("\n\n")}\n`;

    const base = `${NOTES_FOLDER}/${sanitizeNoteTitle(title)}.md`;
    await this.ensureFolder(NOTES_FOLDER);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const path =
        attempt === 0 ? base : base.replace(/\.md$/u, `-${attempt + 1}.md`);
      if (this.app.vault.getAbstractFileByPath(path)) {
        continue;
      }
      try {
        const file = await this.app.vault.create(path, content);
        return file.path;
      } catch (error) {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          throw error;
        }
      }
    }
    throw new WebClipError("同名のWebクリップが多く、作成できませんでした。");
  }

  /** 既存WebクリップのPropertiesだけを更新する。 */
  async applyPreviewToNote(
    path: string,
    preview: WebClipMetadata
  ): Promise<void> {
    const patch: Record<string, PropertyValue> = {
      description: preview.description || null,
      image: preview.imageUrl || null,
      kind: "webclip",
      source: preview.source,
      title: preview.title || null,
    };
    await this.properties.update(path, patch);
  }

  /** Web Clipperを使わず、最小限のクリップノートを手動作成する。 */
  async createClip(preview: WebClipMetadata): Promise<string> {
    const now = new Date();
    const created = formatLocalIso(now);
    const date = created.slice(0, 10);
    const base = `${NOTES_FOLDER}/${date}-${sanitizeNoteTitle(
      preview.title || "Webクリップ"
    )}.md`;
    const frontmatter = buildFrontmatter(
      {
        created: yamlQuoted(created),
        description: preview.description
          ? yamlQuoted(preview.description)
          : '""',
        image: preview.imageUrl ? yamlQuoted(preview.imageUrl) : '""',
        kind: "webclip",
        source: yamlQuoted(preview.source),
        title: yamlQuoted(preview.title),
      },
      "\n"
    );
    const content = `${frontmatter}\n## メモ\n`;
    await this.ensureFolder(NOTES_FOLDER);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const path =
        attempt === 0 ? base : base.replace(/\.md$/u, `-${attempt + 1}.md`);
      if (this.app.vault.getAbstractFileByPath(path)) {
        continue;
      }
      try {
        const file = await this.app.vault.create(path, content);
        return file.path;
      } catch (error) {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          throw error;
        }
      }
    }
    throw new WebClipError("同名のWebクリップが多く、作成できませんでした。");
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = normalizePath(path)
      .split("/")
      .filter((segment) => segment !== "");
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      if (this.app.vault.getAbstractFileByPath(current)) {
        continue;
      }
      await this.app.vault.createFolder(current);
    }
  }
}
