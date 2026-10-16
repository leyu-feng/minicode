import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function sanitizeLockfile(text) {
  return text.replace(/^(\s*resolution: \{[^\r\n}]*\bintegrity: [^\r\n}]*), tarball: https?:\/\/[^,\s}]+(?=\})/gm, "$1");
}

export function sanitizeModules(text) {
  return text.replace(/^registries:\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))*/gm,
    "registries:\n  default: https://registry.npmjs.org/\n");
}

export function sanitizeImagePackageMetadata(root) {
  for (const relative of ["pnpm-lock.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.modules.yaml"]) {
    const file = join(root, relative);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const sanitized = relative.endsWith(".modules.yaml") ? sanitizeModules(text) : sanitizeLockfile(text);
    writeFileSync(file, sanitized);
  }
  const removeBuildConfig = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) removeBuildConfig(file);
      else if (entry.isFile() && entry.name === "config.gypi" && basename(directory) === "build") unlinkSync(file);
    }
  };
  const modules = join(root, "node_modules");
  if (existsSync(modules)) removeBuildConfig(modules);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: sanitize-image-package-metadata.mjs <root>");
  sanitizeImagePackageMetadata(resolve(process.argv[2]));
}
