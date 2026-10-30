import type { App, View, WorkspaceLeaf } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openSeitonView } from "../src/platform/seitonNav";

function viewOf(type: string, scrollTop = 0): View {
  return {
    contentEl: { scrollTop },
    getViewType: () => type,
  } as unknown as View;
}

function leafOf(view: View) {
  return {
    setViewState: vi.fn(async () => undefined),
    view,
  } as unknown as WorkspaceLeaf & {
    setViewState: ReturnType<typeof vi.fn>;
  };
}

describe("openSeitonView", () => {
  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
  });

  it("いまのSeitonリーフを同じリーフのまま差し替える", async () => {
    const leaf = leafOf(viewOf("seiton-next-home", 120));
    const newLeaf = leafOf(viewOf("seiton-next-home"));
    const getLeaf = vi.fn(() => newLeaf);
    const app = {
      workspace: {
        activeLeaf: leaf,
        getLeaf,
        getLeavesOfType: vi.fn(() => []),
        getMostRecentLeaf: vi.fn(() => leaf),
        revealLeaf: vi.fn(async () => undefined),
        setActiveLeaf: vi.fn(),
      },
    } as unknown as App;

    await openSeitonView(app, "seiton-next-library");

    expect(leaf.setViewState).toHaveBeenCalledWith(
      expect.objectContaining({ type: "seiton-next-library" })
    );
    expect(getLeaf).not.toHaveBeenCalled();
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it("Cmd/Ctrl相当では別リーフを開く", async () => {
    const leaf = leafOf(viewOf("seiton-next-home"));
    const newLeaf = leafOf(viewOf("seiton-next-home"));
    const getLeaf = vi.fn(() => newLeaf);
    const app = {
      workspace: {
        activeLeaf: leaf,
        getLeaf,
        getLeavesOfType: vi.fn(() => []),
        getMostRecentLeaf: vi.fn(() => leaf),
        revealLeaf: vi.fn(async () => undefined),
        setActiveLeaf: vi.fn(),
      },
    } as unknown as App;

    await openSeitonView(app, "seiton-next-library", undefined, {
      forceNewLeaf: true,
    });

    expect(leaf.setViewState).not.toHaveBeenCalled();
    expect(getLeaf).toHaveBeenCalled();
    expect(newLeaf.setViewState).toHaveBeenCalledWith(
      expect.objectContaining({ type: "seiton-next-library" })
    );
  });

  it("Seiton以外のビューが有効なら既存のリーフを表示する", async () => {
    const noteLeaf = leafOf(viewOf("markdown"));
    const existing = leafOf(viewOf("seiton-next-library"));
    const revealLeaf = vi.fn(async () => undefined);
    const app = {
      workspace: {
        activeLeaf: noteLeaf,
        getLeaf: vi.fn(),
        getLeavesOfType: vi.fn(() => [existing]),
        getMostRecentLeaf: vi.fn(() => noteLeaf),
        revealLeaf,
        setActiveLeaf: vi.fn(),
      },
    } as unknown as App;

    await openSeitonView(app, "seiton-next-library");

    expect(existing.setViewState).not.toHaveBeenCalled();
    expect(revealLeaf).toHaveBeenCalledWith(existing);
  });

  it("同じタブを押したときは差し替えない", async () => {
    const leaf = leafOf(viewOf("seiton-next-home"));
    const revealLeaf = vi.fn(async () => undefined);
    const app = {
      workspace: {
        activeLeaf: leaf,
        getLeaf: vi.fn(),
        getLeavesOfType: vi.fn(() => []),
        getMostRecentLeaf: vi.fn(() => leaf),
        revealLeaf,
        setActiveLeaf: vi.fn(),
      },
    } as unknown as App;

    await openSeitonView(app, "seiton-next-home");

    expect(leaf.setViewState).not.toHaveBeenCalled();
    expect(revealLeaf).toHaveBeenCalledWith(leaf);
  });
});
