export function selectContainerEngine(env = process.env) {
  const engine = env.CONTAINER_ENGINE || (env.GITHUB_ACTIONS === 'true' ? 'docker' : 'podman');
  if (!['podman', 'docker'].includes(engine)) throw new Error('CONTAINER_ENGINE must be podman or docker');
  return engine;
}

export function containerRunArgs(args, engine = selectContainerEngine()) {
  // Preserve host ownership without relaxing the sandbox's non-root user.
  return engine === 'podman' && args[0] === 'run' && args.includes('--user')
    ? ['run', '--userns=keep-id', ...args.slice(1)]
    : args;
}
