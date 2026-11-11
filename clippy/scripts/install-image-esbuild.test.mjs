import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installImageEsbuild } from "./install-image-esbuild.mjs";

function fixture(t, goarch = "amd64") {
  const temporary = mkdtempSync(join(tmpdir(), "image-esbuild-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, "runtime");
  const artifact = join(temporary, "artifact");
  const nativeName = goarch === "arm64" ? "linux-arm64" : "linux-x64";
  const native = join(root, "node_modules", ".pnpm", "native", "node_modules", "@esbuild", nativeName);
  const wrapper = join(root, "node_modules", ".pnpm", "esbuild", "node_modules", "esbuild");
  for (const path of [artifact, join(native, "bin"), join(wrapper, "bin"), join(wrapper, "lib")]) {
    mkdirSync(path, { recursive: true });
  }
  const bytes = Buffer.from("rebuilt esbuild");
  const provenance = {
    version: "0.28.2", goVersion: "go1.26.10", goarch,
    sourceCommit: "609683d892977362a0f99026cb74b96263d728a9",
    binarySha256: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(join(artifact, "esbuild"), bytes);
  const saveProvenance = () => writeFileSync(join(artifact, "provenance.json"), JSON.stringify(provenance));
  saveProvenance();
  writeFileSync(join(artifact, "go-build-info.txt"), `/out/esbuild: go1.26.10\n\tbuild\tGOARCH=${goarch}\n`);
  writeFileSync(join(native, "package.json"), JSON.stringify({ name: `@esbuild/${nativeName}`, version: "0.28.2" }));
  const manifest = { name: "esbuild", version: "0.28.2", "esbuild.binaryHashes": { [`@esbuild/${nativeName}/bin/esbuild`]: "upstream-hash", "unrelated-platform/bin/esbuild": "preserved" } };
  writeFileSync(join(wrapper, "package.json"), JSON.stringify(manifest));
  const sharedBinary = join(temporary, "store-binary");
  writeFileSync(sharedBinary, "original esbuild");
  for (const path of [join(native, "bin", "esbuild"), join(wrapper, "bin", "esbuild"),
    join(wrapper, "lib", `downloaded-@esbuild-${nativeName}-esbuild`), join(wrapper, "bin-esbuild")]) {
    linkSync(sharedBinary, path);
  }
  const sharedMetadata = join(temporary, "store-package.json");
  linkSync(join(wrapper, "package.json"), sharedMetadata);
  return { root, artifact, native, wrapper, sharedBinary, sharedMetadata, bytes, provenance, saveProvenance };
}

test("replaces CLI and API binaries without mutating pnpm's store and removes fallback copies", (t) => {
  for (const arch of ["amd64", "arm64"]) {
    const f = fixture(t, arch);
    const report = installImageEsbuild(f.root, f.artifact);
    assert.equal(report.replaced.length, 2);
    for (const path of [f.native, f.wrapper]) assert.deepEqual(readFileSync(join(path, "bin", "esbuild")), f.bytes);
    assert.equal(readFileSync(f.sharedBinary, "utf8"), "original esbuild");
    assert.equal(existsSync(join(f.wrapper, "bin-esbuild")), false);
    assert.deepEqual(readdirSync(join(f.wrapper, "lib")), []);
    const metadata = JSON.parse(readFileSync(join(f.wrapper, "package.json")));
    assert.equal(metadata.version, "0.28.2");
    assert.equal(metadata["esbuild.binaryHashes"][`@esbuild/linux-${arch === "amd64" ? "x64" : "arm64"}/bin/esbuild`], f.provenance.binarySha256);
    assert.equal(metadata["esbuild.binaryHashes"]["unrelated-platform/bin/esbuild"], "preserved");
    assert.match(readFileSync(f.sharedMetadata, "utf8"), /upstream-hash/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "esbuild-rebuild.json"))), report);
  }
});

test("rejects unpatched compilers, mismatched checksums and inconsistent build information before replacing files", (t) => {
  for (const mutation of [
    (f) => { f.provenance.goVersion = "go1.26.5"; },
    (f) => { f.provenance.goVersion = "go1.26.9"; },
    (f) => { f.provenance.binarySha256 = "0".repeat(64); },
    (f) => { f.provenance.goarch = "arm64"; },
  ]) {
    const f = fixture(t);
    mutation(f);
    f.saveProvenance();
    assert.throws(() => installImageEsbuild(f.root, f.artifact), /requires stable Go|checksum mismatch|does not match provenance/);
    assert.equal(readFileSync(join(f.native, "bin", "esbuild"), "utf8"), "original esbuild");
  }
});

test("rejects missing native packages and mismatched installed versions instead of leaving vulnerable binaries", (t) => {
  for (const mutation of [
    (f) => rmSync(f.native, { recursive: true }),
    (f) => writeFileSync(join(f.wrapper, "package.json"), JSON.stringify({ name: "esbuild", version: "0.29.0" })),
  ]) {
    const f = fixture(t);
    mutation(f);
    assert.throws(() => installImageEsbuild(f.root, f.artifact), /is missing|update the source pin/);
    assert.equal(readFileSync(join(f.wrapper, "bin", "esbuild"), "utf8"), "original esbuild");
  }
});
