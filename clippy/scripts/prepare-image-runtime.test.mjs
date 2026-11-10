import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareImageRuntime } from "./prepare-image-runtime.mjs";

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), "image-runtime-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, "source");
  const output = join(temporary, "runtime");
  mkdirSync(join(source, "patches"), { recursive: true });
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches/runtime.patch"]) {
    writeFileSync(join(source, file), `${file}\n`);
  }
  const manifest = (path, value) => {
    mkdirSync(join(source, path), { recursive: true });
    writeFileSync(join(source, path, "package.json"), JSON.stringify(value));
  };
  manifest("", {
    name: "paperclip",
    packageManager: "pnpm@10.34.9",
    devDependencies: { typescript: "^7.0.2" },
    pnpm: { overrides: { "vulnerable@<2": "^2.0.0" } },
    scripts: { postinstall: "node scripts/link-plugin-dev-sdk.mjs", start: "node server/dist/index.js" },
  });
  return { source, output, manifest };
}

test("runtime manifests preserve production contracts without development optional-peer providers", (t) => {
  const { source, output, manifest } = fixture(t);
  const server = {
    name: "@paperclipai/server",
    version: "0.3.1",
    dependencies: { "better-auth": "1.7.2", tsx: "^4.23.15", "@paperclipai/db": "workspace:*" },
    devDependencies: { "drizzle-kit": "^0.31.10", vitest: "^5.0.3" },
    peerDependencies: { "@sentry/node": "10.71.0" },
    peerDependenciesMeta: { "@sentry/node": { optional: true } },
  };
  manifest("server", server);
  prepareImageRuntime(source, output, [source, join(source, "server")]);
  const actual = JSON.parse(readFileSync(join(output, "server", "package.json")));
  const { devDependencies, ...expected } = server;
  assert.deepEqual(actual, expected);
  const root = JSON.parse(readFileSync(join(output, "package.json")));
  assert.equal(root.devDependencies, undefined);
  assert.deepEqual(root.scripts, { start: "node server/dist/index.js" });
  assert.deepEqual(root.pnpm.overrides, { "vulnerable@<2": "^2.0.0" });
  assert.equal(readFileSync(join(output, "patches", "runtime.patch"), "utf8"), "patches/runtime.patch\n");
  assert.deepEqual(JSON.parse(readFileSync(join(source, "server", "package.json"))), server);
});

test("browser dependencies are excluded while workspace-relative runtime exports are preserved", (t) => {
  const { source, output, manifest } = fixture(t);
  manifest("ui", { name: "@paperclipai/ui", dependencies: { lexical: "1.0.0" } });
  manifest("packages/shared", { name: "@paperclipai/shared", exports: "./src/index.ts" });
  prepareImageRuntime(source, output, [join(source, "ui"), join(source, "packages", "shared")]);
  assert.equal(existsSync(join(output, "ui", "package.json")), false);
  assert.equal(JSON.parse(readFileSync(join(output, "packages", "shared", "package.json"))).exports, "./src/index.ts");
});

test("runtime staging cannot overwrite the build workspace or read external manifests", (t) => {
  const { source, output } = fixture(t);
  assert.throws(() => prepareImageRuntime(source, source, []), /outside the source/);
  assert.throws(() => prepareImageRuntime(source, join(source, "runtime"), []), /outside the source/);
  assert.throws(() => prepareImageRuntime(source, join(source, "..internal"), []), /outside the source/);
  assert.throws(() => prepareImageRuntime(source, output, [join(source, "..", "external")]), /outside the source root/);
});
