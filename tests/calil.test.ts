import { describe, expect, it } from "vitest";
import {
  type CalilLibraryHit,
  calilLibrariesFromPayload,
} from "../src/domain/book";
import {
  calilAvailableCount,
  calilBestBranch,
  calilBookUrl,
  calilBranchesFromLibraries,
  calilHoldingCount,
  calilLibraryInfoFromPayload,
  calilLibraryPageUrl,
  calilMapUrl,
  calilStatusRank,
  parseCalilLibrarySelection,
} from "../src/domain/calil";

const libraries: CalilLibraryHit[] = [
  {
    availability: {
      中央図書館: "貸出可",
      工学部図書館: "貸出中",
    },
    configured: true,
    reserveUrl: "https://example.com/reserve",
    status: "OK",
    systemid: "Univ_Kindai",
    systemname: "近畿大学",
  },
  {
    availability: {},
    configured: true,
    reserveUrl: "",
    status: "OK",
    systemid: "Fukuoka_Onga",
    systemname: "遠賀町",
  },
];

const infos = calilLibraryInfoFromPayload([
  {
    address: "大阪府東大阪市小若江3-4-1",
    formal: "近畿大学中央図書館",
    geocode: "135.0,34.0",
    libid: "108154",
    libkey: "中央図書館",
    systemid: "Univ_Kindai",
    systemname: "近畿大学",
  },
  {
    address: "大阪府東大阪市大野東377-2",
    formal: "近畿大学工学部図書館",
    libid: "111571",
    libkey: "工学部図書館",
    systemid: "Univ_Kindai",
    systemname: "近畿大学",
  },
]);

describe("カーリルの図書館メタデータ", () => {
  it("libkeyが配列でも展開する", () => {
    const parsed = calilLibraryInfoFromPayload([
      {
        address: "住所",
        formal: "正式名",
        libid: "1",
        libkey: ["本館", "分館"],
        systemid: "A",
        systemname: "自治体",
      },
    ]);
    expect(parsed.map((item) => item.libkey)).toEqual(["本館", "分館"]);
  });

  it("館ごとに住所と正式名を結合する", () => {
    const branches = calilBranchesFromLibraries(libraries, infos);
    expect(branches).toHaveLength(3);
    const central = branches.find((branch) => branch.libkey === "中央図書館");
    expect(central).toMatchObject({
      address: "大阪府東大阪市小若江3-4-1",
      formal: "近畿大学中央図書館",
      state: "貸出可",
    });
  });

  it("代表館は設定済み・貸出可を優先する", () => {
    const branches = calilBranchesFromLibraries(libraries, infos);
    const best = calilBestBranch(branches);
    expect(best?.libkey).toBe("中央図書館");
    expect(calilAvailableCount(branches)).toBe(1);
    expect(calilHoldingCount(branches)).toBe(2);
  });

  it("メタデータがない館でも内部IDを館名にしない", () => {
    const branches = calilBranchesFromLibraries(libraries, infos);
    expect(
      branches.some((branch) => branch.systemname === "Fukuoka_Onga")
    ).toBe(false);
    const noAddress = branches.find((branch) => branch.address === "");
    expect(noAddress).toBeDefined();
    if (noAddress) {
      expect(calilMapUrl(noAddress)).toBe("");
    }
  });

  it("状態の優先順位を返す", () => {
    expect(calilStatusRank("貸出可")).toBeLessThan(calilStatusRank("貸出中"));
    expect(calilStatusRank("貸出中")).toBeLessThan(calilStatusRank("蔵書なし"));
  });
});

describe("カーリルのリンク", () => {
  it("ISBN-13からISBN-10の本ページを作る", () => {
    expect(calilBookUrl("9784887062603")).toBe(
      "https://calil.jp/book/4887062605"
    );
  });

  it("館ページと地図URLを作る", () => {
    const branch = calilBranchesFromLibraries(libraries, infos)[0];
    expect(branch).toBeDefined();
    if (!branch) {
      return;
    }
    expect(calilLibraryPageUrl(branch)).toContain("https://calil.jp/library/");
    expect(calilMapUrl(branch)).toContain("google.com/maps");
  });
});

describe("実レスポンスの結合", () => {
  it("systemidの入れ子と図書館メタデータから住所付きの館を作る", () => {
    const libraries = calilLibrariesFromPayload(
      {
        books: {
          "9784887062603": {
            Fukuoka_Onga: { libkey: {}, reserveurl: "", status: "Cache" },
            Osaka_Higashiosaka: {
              libkey: { 花園: "貸出可" },
              reserveurl: "https://example.com/osaka",
              status: "Cache",
            },
            Univ_Kindai: {
              libkey: { 中央図書館: "貸出可" },
              reserveurl: "https://example.com/kindai",
              status: "Cache",
            },
          },
        },
        continue: 0,
      },
      "9784887062603",
      "Fukuoka_Onga,Univ_Kindai,Osaka_Higashiosaka"
    );
    const infos = calilLibraryInfoFromPayload([
      {
        address: "大阪府東大阪市小若江3-4-1",
        formal: "近畿大学中央図書館",
        libid: "108154",
        libkey: "中央図書館",
        systemid: "Univ_Kindai",
        systemname: "近畿大学",
      },
      {
        address: "大阪府東大阪市南四条町1-1",
        formal: "東大阪市立花園図書館",
        libid: "102998",
        libkey: "花園",
        systemid: "Osaka_Higashiosaka",
        systemname: "東大阪市",
      },
    ]);
    const branches = calilBranchesFromLibraries(libraries, infos);
    const osaka = branches.find(
      (branch) => branch.systemid === "Osaka_Higashiosaka"
    );
    expect(osaka?.address).toBe("大阪府東大阪市南四条町1-1");
    expect(osaka?.formal).toBe("東大阪市立花園図書館");
    expect(calilBestBranch(branches)?.state).toBe("貸出可");
  });
});

describe("表示する館の指定", () => {
  it("systemid:libidを分解し、APIにはsystemidだけを渡す", () => {
    const selection = parseCalilLibrarySelection(
      "Fukuoka_Onga, Univ_Kindai:108154"
    );
    expect(selection.systems).toEqual(["Fukuoka_Onga", "Univ_Kindai"]);
    expect(selection.branchIds.univ_kindai).toEqual(["108154"]);
    expect(selection.display).toBe("Fukuoka_Onga, Univ_Kindai:108154");
  });

  it("libidを指定したシステムは該当館だけ残す", () => {
    const branches = calilBranchesFromLibraries(libraries, infos, {
      univ_kindai: ["108154"],
    });
    expect(
      branches.filter((branch) => branch.systemid === "Univ_Kindai")
    ).toHaveLength(1);
    expect(
      branches.find((branch) => branch.systemid === "Univ_Kindai")?.libid
    ).toBe("108154");
  });

  it("図書館メタデータのlibidで代表館を絞る", () => {
    const branches = calilBranchesFromLibraries(libraries, infos, {
      univ_kindai: ["111571"],
    });
    expect(
      branches.find((branch) => branch.systemid === "Univ_Kindai")?.libkey
    ).toBe("工学部図書館");
  });
});
