export function recordingsDirectoryFromDataPath(
  dataPath: string | null | undefined,
): string | null {
  const root = dataPath?.trim().replace(/[\\/]+$/, "");
  if (!root) return null;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}recordings`;
}
