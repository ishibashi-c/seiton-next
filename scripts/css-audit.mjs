import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

const cssFiles = (await walk("src/styles")).filter((file) =>
  file.endsWith(".css")
);
const tsFiles = (await walk("src")).filter((file) => file.endsWith(".ts"));

const selectors = new Map();
const declarations = new Map();
const classes = new Set();
for (const file of cssFiles) {
  const css = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectorText = match[1].trim();
    if (
      selectorText.startsWith("@") ||
      selectorText === "from" ||
      selectorText === "to"
    ) {
      continue;
    }
    for (const raw of selectorText.split(",")) {
      const selector = raw.trim();
      if (selector === "" || selector.includes("%")) {
        continue;
      }
      selectors.set(selector, (selectors.get(selector) ?? 0) + 1);
      const key = `${selector}\u0000${match[2].replace(/\s+/gu, "")}`;
      declarations.set(key, (declarations.get(key) ?? 0) + 1);
      for (const cls of selector.matchAll(/\.([A-Za-z_][\w-]*)/gu)) {
        classes.add(cls[1]);
      }
    }
  }
}

const source = (
  await Promise.all(tsFiles.map((file) => readFile(file, "utf8")))
).join("\n");

const SAFELIST = [
  /^is-/u,
  /^has-/u,
  /^theme-/u,
  /^mod-/u,
  /^workspace-/u,
  /^view-/u,
  /^markdown-/u,
  /^internal-/u,
  /^cm-/u,
  /^HyperMD/u,
  /^callout/u,
  /^setting-item/u,
  /^modal$/u,
  /^menu$/u,
  /^clickable-icon$/u,
  /^svg-icon$/u,
];

const unused = [...classes]
  .filter((name) => !source.includes(name))
  .filter((name) => !SAFELIST.some((pattern) => pattern.test(name)))
  .sort();

const duplicates = [...selectors.entries()]
  .filter(([, count]) => count > 1)
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

console.log(`CSS files: ${cssFiles.length}`);
console.log(
  `Selector occurrences: ${[...selectors.values()].reduce((sum, count) => sum + count, 0)}`
);
console.log(`Unique selectors: ${selectors.size}`);
console.log(`Duplicated selectors: ${duplicates.length}`);
console.log(
  `Exact duplicate declarations: ${
    [...declarations.values()].filter((count) => count > 1).length
  }`
);
console.log(`Class names: ${classes.size}`);
console.log(`Classes not found in TS (safelist excluded): ${unused.length}`);

if (process.argv.includes("--details")) {
  console.log("\nDuplicates:");
  for (const [selector, count] of duplicates.slice(0, 60)) {
    console.log(`${count}\t${selector}`);
  }
  console.log("\nUnused candidates:");
  for (const name of unused.slice(0, 100)) {
    console.log(name);
  }
}
