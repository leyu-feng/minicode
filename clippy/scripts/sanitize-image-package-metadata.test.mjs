import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sanitizeImagePackageMetadata, sanitizeLockfile, sanitizeModules } from "./sanitize-image-package-metadata.mjs";

test("lock sanitization removes mirror locations without changing integrity or package identity", () => {
  const input = "packages:\n  fixture@1.2.3:\n    resolution: {integrity: sha512-fixture==, tarball: https://mirror.example.test/team/npm/fixture/-/fixture-1.2.3.tgz}\n";
  assert.equal(sanitizeLockfile(input), "packages:\n  fixture@1.2.3:\n    resolution: {integrity: sha512-fixture==}\n");
  const pinnedUrl = "    resolution: {tarball: https://example.test/custom.tgz}\n";
  assert.equal(sanitizeLockfile(pinnedUrl), pinnedUrl);
});

test("installed module registry metadata resets to public runtime defaults", () => {
  const input = "layoutVersion: 5\nregistries:\n  default: https://mirror.example.test/private/\n  '@fixture': https://scope.example.test/feed/\nstoreDir: /root/store\n";
  assert.equal(sanitizeModules(input), "layoutVersion: 5\nregistries:\n  default: https://registry.npmjs.org/\nstoreDir: /root/store\n");
});

test("image and provider-pack lockfiles are sanitized before copy or hashing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "image-metadata-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "node_modules", ".pnpm"), { recursive: true });
  const lock = "    resolution: {integrity: sha512-fixture==, tarball: https://mirror.example.test/fixture.tgz}\n";
  writeFileSync(join(root, "pnpm-lock.yaml"), lock);
  writeFileSync(join(root, "node_modules", ".pnpm", "lock.yaml"), lock);
  writeFileSync(join(root, "node_modules", ".modules.yaml"), "registries:\n  default: https://mirror.example.test/\n");
  const nativeBuild = join(root, "node_modules", "native-fixture", "build");
  mkdirSync(nativeBuild, { recursive: true });
  writeFileSync(join(nativeBuild, "config.gypi"), '{"npm_config_registry":"https://mirror.example.test/"}');
  writeFileSync(join(nativeBuild, "binding.node"), "runtime-addon");
  sanitizeImagePackageMetadata(root);
  for (const file of ["pnpm-lock.yaml", "node_modules/.pnpm/lock.yaml", "node_modules/.modules.yaml"]) {
    assert.ok(!readFileSync(join(root, file), "utf8").includes("mirror.example.test"));
  }
  assert.equal(existsSync(join(nativeBuild, "config.gypi")), false);
  assert.equal(readFileSync(join(nativeBuild, "binding.node"), "utf8"), "runtime-addon");
});
