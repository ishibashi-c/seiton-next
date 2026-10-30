import { beforeEach, describe, expect, it } from "vitest";
import { addGroup, addLink, removeGroup } from "../src/domain/linkList";
import { LinkListService } from "../src/services/linkListService";
import { MemoryVault } from "./helpers/memoryVault";

const PATH = "Seiton/System/Links.md";

describe("LinkListService", () => {
  let vault: MemoryVault;
  let service: LinkListService;

  beforeEach(() => {
    vault = new MemoryVault();
    service = new LinkListService(vault, PATH);
  });

  it("最初の追加でノートを作る", async () => {
    const edit = await service.edit((content) =>
      addLink(content, {
        group: null,
        label: "Mobbin",
        target: "https://mobbin.com",
      })
    );
    expect(edit.status).toBe("added");
    const data = vault.files.get(PATH) ?? "";
    expect(data.startsWith("# ショートカット")).toBe(true);
    expect(data).toContain("- [Mobbin](https://mobbin.com)");
  });

  it("保存した内容を読み直せる", async () => {
    await service.edit((content) =>
      addLink(content, {
        group: null,
        label: "Mobbin",
        target: "https://mobbin.com",
      })
    );
    await service.edit((content) => addGroup(content, "道具"));
    await service.edit((content) =>
      addLink(content, {
        group: "道具",
        label: "Figma",
        target: "https://figma.com",
      })
    );
    const list = await service.load();
    expect(list.sections.map((section) => section.name)).toEqual([
      null,
      "道具",
    ]);
    expect(list.sections[1]?.items[0]?.label).toBe("Figma");
  });

  it("ないグループを消しても壊れない", async () => {
    await service.edit((content) =>
      addLink(content, {
        group: null,
        label: "Mobbin",
        target: "https://mobbin.com",
      })
    );
    const edit = await service.edit((content) => removeGroup(content, "道具"));
    expect(edit.status).toBe("missing");
    expect(vault.files.get(PATH)).toContain("- [Mobbin](https://mobbin.com)");
  });

  it("ファイルがないときの読み込みは空", async () => {
    const list = await service.load();
    expect(list.sections).toHaveLength(0);
    expect(vault.files.has(PATH)).toBe(false);
  });
});
