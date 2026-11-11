import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { containerRunArgs, selectContainerEngine } from './container-engine.mjs';

const helper = fileURLToPath(new URL('./container-engine.sh', import.meta.url)).replaceAll('\\', '/');

test('Bash and Node use Podman locally, preserve hosted Docker, and honor explicit selection', () => {
  for (const [overrides, engine, host] of [
    [{}, 'podman', 'host.containers.internal'],
    [{ GITHUB_ACTIONS: 'true' }, 'docker', 'host.docker.internal'],
    [{ GITHUB_ACTIONS: 'true', CONTAINER_ENGINE: 'podman' }, 'podman', 'host.containers.internal'],
    [{ CONTAINER_ENGINE: 'docker' }, 'docker', 'host.docker.internal'],
  ]) {
    const env = { ...process.env, GITHUB_ACTIONS: '', CONTAINER_ENGINE: '', ...overrides };
    assert.equal(selectContainerEngine(env), engine);
    const result = spawnSync('bash', ['-c', 'source "$1"; podman() { printf "podman|%s|%s|%s" "$CONTAINER_HOST_INTERNAL" "$1" "$2"; }; docker() { printf "docker|%s|%s|%s" "$CONTAINER_HOST_INTERNAL" "$1" "$2"; }; container inspect "name with spaces"', 'test', helper], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${engine}|${host}|inspect|name with spaces`);
  }
});

test('invalid engine selection fails instead of silently falling back', () => {
  const env = { ...process.env, CONTAINER_ENGINE: 'unavailable-engine' };
  assert.throws(() => selectContainerEngine(env), /must be podman or docker/);
  const result = spawnSync('bash', ['-c', 'set -e; source "$1"', 'test', helper], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be podman or docker/);
});

test('Git Bash preserves container paths instead of rewriting them as Windows paths', () => {
  const env = { ...process.env, CONTAINER_ENGINE: 'podman' };
  const result = spawnSync('bash', ['-c', 'source "$1"; podman() { printf "%s|%s;" "$MSYS_NO_PATHCONV" "$2"; }; for OSTYPE in msys cygwin; do container exec /bin/sh; done', 'test', helper], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1|/bin/sh;1|/bin/sh;');
});

test('Git Bash converts host volumes, Compose files and build contexts, not container arguments', () => {
  const env = { ...process.env, CONTAINER_ENGINE: 'podman' };
  const script = `
    source "$1"
    OSTYPE=msys
    cygpath() { printf 'C:/host%s' "$2"; }
    podman() { printf '%s\\n' "$@"; }
    container run -v "/tmp/with space:/inside:ro" image /bin/sh
    container compose -f /tmp/compose.yml config
    container build -f /tmp/Containerfile /tmp/context
    container inspect -f /template image
    container cp /tmp/receipt.json named:/inside/receipt.json
  `;
  const result = spawnSync('bash', ['-c', script, 'test', helper], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'run', '-v', 'C:/host/tmp/with space:/inside:ro', 'image', '/bin/sh',
    'compose', '-f', 'C:/host/tmp/compose.yml', 'config',
    'build', '-f', 'C:/host/tmp/Containerfile', 'C:/host/tmp/context',
    'inspect', '-f', '/template', 'image',
    'cp', 'C:/host/tmp/receipt.json', 'named:/inside/receipt.json',
  ]);
});

test('rootless Podman keeps ownership and the existing sandbox restrictions', () => {
  const args = ['run', '--rm', '--user', '1001:1001', '--read-only', '--network', 'none', 'image', 'node'];
  assert.deepEqual(containerRunArgs(args, 'podman'), ['run', '--userns=keep-id', ...args.slice(1)]);
  assert.deepEqual(containerRunArgs(args, 'docker'), args);
  assert.deepEqual(containerRunArgs(['pull', 'image'], 'podman'), ['pull', 'image']);
});
