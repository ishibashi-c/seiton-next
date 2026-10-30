export interface CoverFileInfo {
  path: string;
  size: number;
}

export interface CoverCacheAnalysis {
  files: CoverFileInfo[];
  orphanBytes: number;
  orphans: CoverFileInfo[];
  totalBytes: number;
}

function normalizePath(value: string): string {
  return value.replace(/^\.?\//u, "").trim();
}

/**
 * 表紙フォルダ内のファイルと、書籍から参照されているパスを突き合わせる。
 * 参照されていないファイルだけを orphan として返す。
 */
export function analyzeCoverCache(
  files: CoverFileInfo[],
  referencedPaths: string[],
  coversFolder: string
): CoverCacheAnalysis {
  const prefix = `${normalizePath(coversFolder).replace(/[\\/]+$/u, "")}/`;
  const inFolder = files.filter((file) =>
    normalizePath(file.path).startsWith(prefix)
  );
  const referenced = new Set(referencedPaths.map(normalizePath));
  const orphans = inFolder.filter(
    (file) => !referenced.has(normalizePath(file.path))
  );
  return {
    files: inFolder.sort((left, right) => left.path.localeCompare(right.path)),
    orphanBytes: orphans.reduce((sum, file) => sum + file.size, 0),
    orphans: orphans.sort((left, right) => right.size - left.size),
    totalBytes: inFolder.reduce((sum, file) => sum + file.size, 0),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
