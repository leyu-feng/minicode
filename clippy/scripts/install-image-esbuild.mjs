import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function installImageEsbuild(root, artifactRoot) {
  const provenance = JSON.parse(readFileSync(join(artifactRoot, "provenance.json"), "utf8"));
  const binary = join(artifactRoot, "esbuild");
  const bytes = readFileSync(binary);
  const goVersion = /^go(\d+)\.(\d+)\.(\d+)$/.exec(provenance.goVersion);
  if (!goVersion || Number(goVersion[1]) !== 1 || Number(goVersion[2]) < 26
      || (Number(goVersion[2]) === 26 && Number(goVersion[3]) < 10)) {
    throw new Error("Rebuilt esbuild requires stable Go 1.26.10 or newer");
  }
  if (sha256(bytes) !== provenance.binarySha256) throw new Error("Rebuilt esbuild checksum mismatch");
  const nativePackage = { amd64: "@esbuild/linux-x64", arm64: "@esbuild/linux-arm64" }[provenance.goarch];
  if (!nativePackage) throw new Error(`Unsupported esbuild target: ${provenance.goarch}`);
  const buildInfo = readFileSync(join(artifactRoot, "go-build-info.txt"), "utf8");
  if (!buildInfo.includes(`: ${provenance.goVersion}\n`) || !buildInfo.includes(`GOARCH=${provenance.goarch}`)) {
    throw new Error("Rebuilt esbuild build information does not match provenance");
  }

  const packages = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if ((basename(directory) === "node_modules" && entry.name === "esbuild")
          || basename(directory) === "@esbuild") {
        packages.push({ path, manifest: JSON.parse(readFileSync(join(path, "package.json"), "utf8")) });
      }
      visit(path);
    }
  };
  visit(join(root, "node_modules"));
  const wrappers = packages.filter(({ manifest }) => manifest.name === "esbuild");
  const natives = packages.filter(({ manifest }) => manifest.name === nativePackage);
  if (!wrappers.length || !natives.length) throw new Error("Runtime esbuild wrapper or native package is missing");
  for (const { manifest } of packages) {
    if (manifest.version !== provenance.version || !["esbuild", nativePackage].includes(manifest.name)) {
      throw new Error(`Rebuilt esbuild ${provenance.version} does not match ${manifest.name}@${manifest.version}; update the source pin`);
    }
  }

  const hashKey = `${nativePackage}/bin/esbuild`;
  for (const { manifest } of wrappers) {
    if (!manifest["esbuild.binaryHashes"]?.[hashKey]) throw new Error("Missing upstream esbuild binary hash");
  }
  const replaced = [];
  for (const { path } of packages) {
    const destination = join(path, "bin", "esbuild");
    const originalSha256 = sha256(readFileSync(destination));
    // Break pnpm's hardlinks instead of modifying its shared content store.
    unlinkSync(destination);
    copyFileSync(binary, destination);
    chmodSync(destination, 0o755);
    replaced.push({ path: relative(root, destination), originalSha256 });
  }
  for (const { path, manifest } of wrappers) {
    for (const name of readdirSync(join(path, "lib")).filter((name) => name.startsWith("downloaded-"))) {
      const fallback = join(path, "lib", name);
      if (!lstatSync(fallback).isFile()) throw new Error(`Unexpected esbuild fallback: ${fallback}`);
      unlinkSync(fallback);
    }
    const temporaryBinary = join(path, "bin-esbuild");
    if (existsSync(temporaryBinary)) unlinkSync(temporaryBinary);
    manifest["esbuild.binaryHashes"][hashKey] = provenance.binarySha256;
    const metadata = join(path, "package.json");
    unlinkSync(metadata);
    writeFileSync(metadata, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const report = { ...provenance, goBuildInfo: buildInfo, replaced };
  writeFileSync(join(root, "esbuild-rebuild.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Usage: install-image-esbuild.mjs <runtime> <artifact>");
  const report = installImageEsbuild(resolve(process.argv[2]), resolve(process.argv[3]));
  console.log(`Installed esbuild ${report.version} (${report.goVersion}) at ${report.replaced.length} runtime paths`);
}
