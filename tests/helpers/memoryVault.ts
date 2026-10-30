import type { VaultPort } from "../../src/services/vaultPort";

export class MemoryVault implements VaultPort {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly mtimes = new Map<string, number>();
  delayMs = 1;
  failNextProcessPath: string | null = null;
  writes = 0;

  exists(path: string): boolean {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    await this.sleep();
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`missing: ${path}`);
    }
    return value;
  }

  async create(path: string, data: string): Promise<void> {
    await this.sleep();
    if (this.files.has(path)) {
      throw new Error(`exists: ${path}`);
    }
    this.files.set(path, data);
    this.mtimes.set(path, Date.now() + this.writes);
    this.writes += 1;
  }

  async process(
    path: string,
    transform: (data: string) => string
  ): Promise<string> {
    await this.sleep();
    if (this.failNextProcessPath === path) {
      this.failNextProcessPath = null;
      throw new Error("simulated write failure");
    }
    const before = this.files.get(path);
    if (before === undefined) {
      throw new Error(`missing: ${path}`);
    }
    const next = transform(before);
    this.files.set(path, next);
    this.mtimes.set(path, Date.now() + this.writes);
    this.writes += 1;
    return next;
  }

  async ensureFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  async listMarkdown(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && path.endsWith(".md"))
      .sort();
  }

  mtime(path: string): number {
    return this.mtimes.get(path) ?? 0;
  }

  private async sleep(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}
