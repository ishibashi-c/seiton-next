/**
 * ショートカット（リンク集）ノートの読み書き。
 * 書き込みは `process`（読み込み・変更・書き込みを1回で行う）に任せ、
 * 他の端末の変更を上書きしないようにする。
 */

import {
  emptyLinkDocument,
  type LinkEdit,
  type LinkList,
  parseLinkList,
} from "../domain/linkList";
import { dirname, type VaultPort } from "./vaultPort";

export class LinkListService {
  private readonly path: string;
  private readonly vault: VaultPort;

  constructor(vault: VaultPort, path: string) {
    this.vault = vault;
    this.path = path;
  }

  get filePath(): string {
    return this.path;
  }

  async load(): Promise<LinkList> {
    if (!this.vault.exists(this.path)) {
      return { sections: [] };
    }
    return parseLinkList(await this.vault.read(this.path));
  }

  async ensure(): Promise<void> {
    if (this.vault.exists(this.path)) {
      return;
    }
    const folder = dirname(this.path);
    if (folder !== "") {
      await this.vault.ensureFolder(folder);
    }
    await this.vault.create(this.path, emptyLinkDocument());
  }

  async edit(transform: (content: string) => LinkEdit): Promise<LinkEdit> {
    await this.ensure();
    let captured: LinkEdit | null = null;
    const content = await this.vault.process(this.path, (data) => {
      const next = transform(data);
      captured = next;
      return next.content;
    });
    return (captured as LinkEdit | null) ?? { content, status: "unchanged" };
  }
}
