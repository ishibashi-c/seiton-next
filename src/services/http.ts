import { requestUrl } from "obsidian";

export interface HttpResponse {
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
  json: unknown;
  status: number;
  text: string;
}

export interface HttpClient {
  get(url: string): Promise<HttpResponse>;
}

/** Obsidian の requestUrl を使う。CORSの影響を受けず、http/httpsだけを扱う。 */
export class ObsidianHttpClient implements HttpClient {
  async get(url: string): Promise<HttpResponse> {
    const response = await requestUrl({
      method: "GET",
      throw: false,
      url,
    });
    return {
      arrayBuffer: response.arrayBuffer,
      headers: response.headers,
      json: safeJson(response.text),
      status: response.status,
      text: response.text,
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function headerValue(
  headers: Record<string, string>,
  name: string
): string {
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  return key ? (headers[key] ?? "") : "";
}
