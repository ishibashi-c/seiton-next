import { describe, expect, it } from "vitest";
import {
  addGroup,
  addLink,
  emptyLinkDocument,
  importLinks,
  linkKey,
  moveLink,
  moveLinkAfter,
  moveLinkBefore,
  moveLinkToGroup,
  parseLinkList,
  removeGroup,
  removeLink,
  renameGroup,
  updateLink,
} from "../src/domain/linkList";

const BASE = [
  "# ショートカット",
  "",
  "- [A](https://a.example)",
  "",
  "## UI参考",
  "- [Mobbin](https://mobbin.com)",
  "- [Awwwards](https://www.awwwards.com)",
  "",
].join("\n");

describe("parseLinkList", () => {
  it("先頭のグループなしと見出しのグループに分ける", () => {
    const list = parseLinkList(BASE);
    expect(list.sections).toHaveLength(2);
    expect(list.sections[0]?.name).toBeNull();
    expect(list.sections[0]?.items.map((item) => item.label)).toEqual(["A"]);
    expect(list.sections[1]?.name).toBe("UI参考");
    expect(list.sections[1]?.items.map((item) => item.target)).toEqual([
      "https://mobbin.com",
      "https://www.awwwards.com",
    ]);
  });

  it("リンク以外の行は項目にしない", () => {
    const content = `${BASE}説明の行\n- [x] タスク\n`;
    const list = parseLinkList(content);
    expect(list.sections.flatMap((section) => section.items)).toHaveLength(3);
  });

  it("空のノートはセクション0件", () => {
    expect(parseLinkList(emptyLinkDocument()).sections).toHaveLength(0);
  });
});

describe("linkKey", () => {
  it("クエリ・ハッシュ・末尾スラッシュを落とす", () => {
    expect(linkKey("https://mobbin.com/?utm_source=x#top")).toBe(
      "https://mobbin.com"
    );
  });

  it("内部リンクは名前で比べる", () => {
    expect(linkKey("[[My Note]]")).toBe(linkKey("my note.md"));
  });
});

describe("addLink", () => {
  it("グループなしは最後の項目のあとに足す", () => {
    const edit = addLink(BASE, {
      group: null,
      label: "B",
      target: "https://b.example",
    });
    expect(edit.status).toBe("added");
    expect(edit.content).toContain(
      "- [A](https://a.example)\n- [B](https://b.example)\n"
    );
  });

  it("グループを指定すると、そのグループの末尾に足す", () => {
    const edit = addLink(BASE, {
      group: "UI参考",
      label: "Godly",
      target: "https://godly.website",
    });
    expect(edit.status).toBe("added");
    expect(edit.content).toContain(
      "- [Awwwards](https://www.awwwards.com)\n- [Godly](https://godly.website)\n"
    );
  });

  it("同じURLは追加しない", () => {
    const edit = addLink(BASE, {
      group: null,
      label: "Mobbin2",
      target: "https://mobbin.com/?utm_source=x",
    });
    expect(edit.status).toBe("duplicate");
    expect(edit.content).toBe(BASE);
  });

  it("ないグループを指定したら追加しない", () => {
    const edit = addLink(BASE, {
      group: "道具",
      label: "Figma",
      target: "https://figma.com",
    });
    expect(edit.status).toBe("missing");
  });

  it("空のノートに足すと、見出しの下に入る", () => {
    const edit = addLink(emptyLinkDocument(), {
      group: null,
      label: "Mobbin",
      target: "https://mobbin.com",
    });
    expect(edit.content).toBe(
      "# ショートカット\n\n- [Mobbin](https://mobbin.com)\n"
    );
  });
});

describe("updateLink", () => {
  it("名前とURLを差し替える", () => {
    const edit = updateLink(BASE, "https://mobbin.com", {
      group: "UI参考",
      label: "Mobbin（UI）",
      target: "https://mobbin.com",
    });
    expect(edit.status).toBe("updated");
    expect(edit.content).toContain("- [Mobbin（UI）](https://mobbin.com)");
    expect(edit.content).not.toContain("- [Mobbin](https://mobbin.com)");
  });
});

describe("removeLink", () => {
  it("その行だけを消す", () => {
    const edit = removeLink(BASE, "https://mobbin.com");
    expect(edit.status).toBe("removed");
    expect(edit.content).not.toContain("mobbin.com");
    expect(edit.content).toContain("- [Awwwards](https://www.awwwards.com)");
  });

  it("無いURLは missing", () => {
    expect(removeLink(BASE, "https://nope.example").status).toBe("missing");
  });
});

describe("moveLink", () => {
  it("同じグループの中で入れ替える", () => {
    const edit = moveLink(BASE, "https://www.awwwards.com", -1);
    expect(edit.status).toBe("updated");
    expect(edit.content).toContain(
      "- [Awwwards](https://www.awwwards.com)\n- [Mobbin](https://mobbin.com)"
    );
  });

  it("端では動かさない", () => {
    expect(moveLink(BASE, "https://mobbin.com", -1).status).toBe("unchanged");
  });

  it("グループをまたがない", () => {
    const edit = moveLink(BASE, "https://mobbin.com", -1);
    expect(edit.status).toBe("unchanged");
    expect(edit.content).toBe(BASE);
  });
});

describe("group", () => {
  it("末尾に見出しを足す", () => {
    const edit = addGroup(BASE, "道具");
    expect(edit.status).toBe("added");
    expect(edit.content).toMatch(/\n## 道具\n$/u);
  });

  it("同じ名前は作らない", () => {
    expect(addGroup(BASE, "UI参考").status).toBe("exists");
  });

  it("名前を変える", () => {
    const edit = renameGroup(BASE, "UI参考", "リファレンス");
    expect(edit.status).toBe("updated");
    expect(edit.content).toContain("## リファレンス");
  });

  it("削除しても中のリンクは残し、グループなしへ移す", () => {
    const edit = removeGroup(BASE, "UI参考");
    expect(edit.status).toBe("removed");
    expect(edit.content).not.toContain("## UI参考");
    expect(edit.content).toContain("- [Mobbin](https://mobbin.com)");
    expect(edit.content).toContain("- [Awwwards](https://www.awwwards.com)");
    const list = parseLinkList(edit.content);
    expect(list.sections).toHaveLength(1);
    expect(list.sections[0]?.items).toHaveLength(3);
  });
});

describe("壊さない", () => {
  it("未知の行をそのまま残す", () => {
    const content = `${BASE}> 引用\n\nメモ書き\n`;
    const edit = addLink(content, {
      group: null,
      label: "B",
      target: "https://b.example",
    });
    expect(edit.content).toContain("> 引用");
    expect(edit.content).toContain("メモ書き");
  });

  it("CRLFのノートはCRLFのまま返す", () => {
    const content = BASE.replace(/\n/gu, "\r\n");
    const edit = addLink(content, {
      group: null,
      label: "B",
      target: "https://b.example",
    });
    expect(edit.content).toContain("\r\n");
    expect(edit.content.replace(/\r\n/gu, "")).not.toContain("\n");
  });

  it("frontmatterの後ろに足す", () => {
    const content = "---\nkind: links\n---\n\n# ショートカット\n";
    const edit = addLink(content, {
      group: null,
      label: "B",
      target: "https://b.example",
    });
    expect(edit.content).toBe(
      "---\nkind: links\n---\n\n# ショートカット\n\n- [B](https://b.example)"
    );
  });
});

describe("importLinks", () => {
  it("同じURLは飛ばして足す", () => {
    const result = importLinks(emptyLinkDocument(), [
      { label: "Mobbin", target: "https://mobbin.com" },
      { label: "Awwwards", target: "https://www.awwwards.com" },
      { label: "Mobbin again", target: "https://mobbin.com/" },
    ]);
    expect(result.added).toBe(2);
    expect(result.content.match(/mobbin\.com/gu)).toHaveLength(1);
  });
});

describe("ドラッグでの移動", () => {
  it("グループの末尾へ移す", () => {
    const edit = moveLinkToGroup(BASE, "https://a.example", "UI参考");
    expect(edit.status).toBe("updated");
    const list = parseLinkList(edit.content);
    expect(list.sections).toHaveLength(1);
    expect(list.sections[0]?.name).toBe("UI参考");
    expect(list.sections[0]?.items.map((item) => item.label)).toEqual([
      "Mobbin",
      "Awwwards",
      "A",
    ]);
  });

  it("グループなしへ戻す", () => {
    const edit = moveLinkToGroup(BASE, "https://mobbin.com", null);
    expect(edit.status).toBe("updated");
    const list = parseLinkList(edit.content);
    expect(list.sections[0]?.name).toBeNull();
    expect(list.sections[0]?.items.map((item) => item.label)).toEqual([
      "A",
      "Mobbin",
    ]);
    expect(list.sections[1]?.items.map((item) => item.label)).toEqual([
      "Awwwards",
    ]);
  });

  it("指定したリンクの前に移す", () => {
    const edit = moveLinkAfter(
      BASE,
      "https://mobbin.com",
      "https://www.awwwards.com"
    );
    const list = parseLinkList(edit.content);
    expect(list.sections[1]?.items.map((item) => item.label)).toEqual([
      "Awwwards",
      "Mobbin",
    ]);
  });

  it("指定したリンクの後ろに移す", () => {
    const edit = moveLinkBefore(
      BASE,
      "https://www.awwwards.com",
      "https://mobbin.com"
    );
    const list = parseLinkList(edit.content);
    expect(list.sections[1]?.items.map((item) => item.label)).toEqual([
      "Awwwards",
      "Mobbin",
    ]);
  });

  it("同じ位置なら unchanged", () => {
    const edit = moveLinkAfter(
      BASE,
      "https://www.awwwards.com",
      "https://mobbin.com"
    );
    expect(edit.status).toBe("unchanged");
    expect(edit.content).toBe(BASE);
  });

  it("ないグループへは移さない", () => {
    const edit = moveLinkToGroup(BASE, "https://mobbin.com", "道具");
    expect(edit.status).toBe("missing");
    expect(edit.content).toBe(BASE);
  });
});
