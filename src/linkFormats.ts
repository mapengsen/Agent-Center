import * as path from "node:path";

export const DEFAULT_LINK_EXTENSIONS: readonly string[] = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".svg",
  ".md", ".markdown", ".mdx", ".rst", ".csv", ".tsv", ".html", ".htm", ".ipynb",
  ".tex", ".bib", ".log", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml",
  ".docx", ".xlsx", ".pptx",
];

export function normalizeLinkExtensions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [...DEFAULT_LINK_EXTENSIONS];
  const extensions = value.filter((item): item is string => typeof item === "string")
    .map(item => item.trim().toLowerCase())
    .filter(item => /^\.?[a-z0-9][a-z0-9_-]*$/.test(item))
    .map(item => item.startsWith(".") ? item : `.${item}`);
  return [...new Set(extensions)];
}

export function isSupportedLinkPath(target: string, extensions: readonly string[]): boolean {
  const extension = path.posix.extname(target.replace(/\\/g, "/")).toLowerCase();
  return extensions.includes(extension);
}
