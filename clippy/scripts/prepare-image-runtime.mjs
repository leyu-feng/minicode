import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function prepareImageRuntime(sourceRoot, outputRoot, workspacePaths) {
  const source = resolve(sourceRoot);
  const output = resolve(outputRoot);
  const outputPath = relative(source, output);
  if (!(isAbsolute(outputPath) || outputPath === ".." || outputPath.startsWith(`..${sep}`))) {
    throw new Error("Runtime output must be outside the source workspace");
  }

  const manifests = [{ path: "", root: true }];
  for (const workspacePath of workspacePaths) {
    const path = relative(source, resolve(workspacePath));
    if (path === "") continue;
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
      throw new Error(`Workspace is outside the source root: ${workspacePath}`);
    }
    // The browser bundle is copied from build; its dependency tree is not used by Node.
    if (path === "ui") continue;
    manifests.push({ path, root: false });
  }

  for (const { path, root } of manifests) {
    const manifest = JSON.parse(readFileSync(join(source, path, "package.json"), "utf8"));
    delete manifest.devDependencies;
    if (root && manifest.scripts) delete manifest.scripts.postinstall;
    const destination = join(output, path, "package.json");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches"]) {
    cpSync(join(source, path), join(output, path), { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Usage: prepare-image-runtime.mjs <source> <output>");
  const source = resolve(process.argv[2]);
  const workspaces = JSON.parse(execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
    cwd: source,
    encoding: "utf8",
  }));
  prepareImageRuntime(source, process.argv[3], workspaces.map((workspace) => workspace.path));
}
