import fs from "node:fs/promises"

async function checkoutIdentity(directory, git, signal) {
  if (await fs.realpath(directory) !== directory
    || await fs.realpath(await git(directory, ["rev-parse", "--show-toplevel"], { signal })) !== directory) {
    throw new Error(`Git sync requires the original checkout root: ${directory}`)
  }
  return fs.realpath(await git(directory, ["rev-parse", "--absolute-git-dir"], { signal }))
}

async function assignedTarget({ name, directory, branch, optional = false, git }) {
  const identity = await checkoutIdentity(directory, git)
  const localRef = await git(directory, ["rev-parse", "--symbolic-full-name", "HEAD"])
  const tracking = localRef.startsWith("refs/heads/")
    ? await git(directory, ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", localRef])
    : ""
  const [trackingRemote, trackingRef] = tracking.split("\0")
  const remotes = (await git(directory, ["remote"])).split(/\r?\n/).filter(Boolean)
  const remote = trackingRemote || "origin"
  if (!remotes.includes(remote)) {
    if (optional && !branch && !remotes.length) return null
    throw new Error(`Repository '${name}' requires a configured remote and assigned branch`)
  }
  branch ??= trackingRef?.startsWith("refs/heads/") ? trackingRef.slice(11)
    : localRef.startsWith("refs/heads/") ? localRef.slice(11) : undefined
  if (!branch) throw new Error(`Detached repository '${name}' requires an explicit branch@ selector`)
  await git(directory, ["check-ref-format", `refs/heads/${branch}`])
  const url = await git(directory, ["remote", "get-url", remote])
  return { name, path: directory, branch, remote, url, identity }
}

export async function prepareWorkerGitSync({ source, sourceBranch, references, workerId, git, validate, log }) {
  const primary = await assignedTarget({ name: "primary", directory: source, branch: sourceBranch, optional: true, git })
  const targets = []
  for (const reference of references) {
    const target = await assignedTarget({ name: reference.name, directory: reference.path, branch: reference.branch, git })
    reference.branch = target.branch
    targets.push(target)
  }
  let pending = Promise.resolve()
  const serialize = operation => {
    const result = pending.then(operation)
    // A failed refresh is returned to its caller, but must not poison later retries.
    pending = result.then(() => {}, () => {})
    return result
  }

  async function verify(target, signal) {
    signal?.throwIfAborted()
    if (await checkoutIdentity(target.path, git, signal) !== target.identity
      || await git(target.path, ["remote", "get-url", target.remote], { signal }) !== target.url) {
      throw new Error(`Repository '${target.name}' identity or configured remote changed; restart the worker`)
    }
  }

  async function fetch(target, signal) {
    await verify(target, signal)
    const ref = `refs/minicode-sync/${workerId}/${target.name.toLowerCase()}`
    try {
      await git(target.path, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
        "--", target.remote, `+refs/heads/${target.branch}:${ref}`], { signal })
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted()
      throw new Error(`Git fetch failed for '${target.name}' assigned branch '${target.branch}'; check remote access and branch availability`, { cause: error })
    }
    const commit = await git(target.path, ["rev-parse", "--verify", `${ref}^{commit}`], { signal })
    log(`Fetched ${target.name}: ${target.branch} at ${commit}`)
    return commit
  }

  async function updateReference(target, commit, operation, signal) {
    await verify(target, signal)
    // Detach before updating: never move a branch shared with another worktree.
    const previous = await git(target.path, ["rev-parse", "--verify", "HEAD^{commit}"], { signal })
    await git(target.path, ["checkout", "--detach", ...(operation === "fetch_reset" ? ["--force"] : []), previous], { signal })
    await git(target.path, operation === "pull"
      ? ["merge", "--ff-only", "--no-edit", commit]
      : ["reset", "--hard", commit], { signal })
    const result = { name: target.name, path: target.path, branch: target.branch,
      commit: await git(target.path, ["rev-parse", "--verify", "HEAD^{commit}"], { signal }) }
    log(`Synced ${target.name}: ${target.branch} at ${result.commit}`)
    return result
  }

  async function importPrimaryCommit(workspace, commit, signal) {
    await verify(primary, signal)
    const common = async directory => fs.realpath(await git(directory,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }))
    if (await common(workspace) !== await common(source)) {
      await git(workspace, ["fetch", "--no-tags", "--no-write-fetch-head", "--", source, commit], { signal })
    }
  }

  const controller = {
    async prepare({ signal } = {}) {
      return serialize(async () => {
        await validate()
        const referenceCommits = []
        for (const target of targets) referenceCommits.push(await fetch(target, signal))
        const primaryCommit = primary ? await fetch(primary, signal) : null
        const manifest = []
        for (let i = 0; i < targets.length; i++) {
          manifest.push(await updateReference(targets[i], referenceCommits[i], "fetch_reset", signal))
        }
        return { primaryCommit, primaryBranch: primary?.branch ?? null, references: manifest }
      })
    },
    async resetPrimary(workspace, commit, { signal } = {}) {
      if (!primary || !commit) return
      await importPrimaryCommit(workspace, commit, signal)
      await git(workspace, ["reset", "--hard", commit], { signal })
      await git(workspace, ["clean", "-xdf"], { signal })
    },
    async tool({ workspace, signal: runSignal, afterReset }) {
      if (!primary && !targets.length) return null
      const identity = await checkoutIdentity(workspace, git, runSignal)
      const localRef = await git(workspace, ["rev-parse", "--symbolic-full-name", "HEAD"], { signal: runSignal })
      const verifyWorkspace = async signal => {
        if (await checkoutIdentity(workspace, git, signal) !== identity
          || await git(workspace, ["rev-parse", "--symbolic-full-name", "HEAD"], { signal }) !== localRef) {
          throw new Error("Primary workspace identity or local branch changed; refusing to reset another branch")
        }
      }
      return {
        name: "sync_repositories",
        description: "Harness-owned Git refresh of configured references or this assignment's primary workspace. Pull fetches then fast-forwards only; fetch_reset discards tracked edits and local commits to mirror the assigned remote branch. Primary hard resets also run git clean -xdf, removing untracked/ignored files; references are never cleaned. No branch/remote/path overrides, push, or PR creation. Save durable work before reset. Primary keeps its worker-local branch; references become detached. Returned commits supersede the initial manifest.",
        parameters: {
          type: "object", additionalProperties: false, required: ["repositories", "operation"],
          properties: {
            repositories: { type: "array", minItems: 1, uniqueItems: true,
              items: { type: "string", enum: ["primary", "all_references", ...targets.map(target => target.name)] } },
            operation: { type: "string", enum: ["pull", "fetch_reset"] },
          },
        },
        async execute(input, { signal } = {}) {
          if (!input || typeof input !== "object" || Array.isArray(input)
            || Object.keys(input).some(key => !["repositories", "operation"].includes(key))
            || !["pull", "fetch_reset"].includes(input.operation)
            || !Array.isArray(input.repositories) || !input.repositories.length
            || new Set(input.repositories).size !== input.repositories.length
            || input.repositories.some(name => !["primary", "all_references", ...targets.map(target => target.name)].includes(name))) {
            throw new Error("sync_repositories requires configured repository names and operation pull or fetch_reset; no overrides")
          }
          const combinedSignal = runSignal && signal ? AbortSignal.any([runSignal, signal]) : signal ?? runSignal
          return serialize(async () => {
            combinedSignal?.throwIfAborted()
            await validate()
            const includePrimary = input.repositories.includes("primary")
            if (includePrimary && !primary) throw new Error("Primary repository has no assigned remote branch; configure its upstream or a branch@ selector")
            if (input.repositories.includes("all_references") && !targets.length) throw new Error("No reference repositories are attached")
            if (includePrimary) await verifyWorkspace(combinedSignal)
            const selected = targets.filter(target =>
              input.repositories.includes("all_references") || input.repositories.includes(target.name))
            const commits = []
            for (const target of selected) commits.push(await fetch(target, combinedSignal))
            const primaryCommit = includePrimary ? await fetch(primary, combinedSignal) : null
            const results = []
            for (let i = 0; i < selected.length; i++) {
              results.push(await updateReference(selected[i], commits[i], input.operation, combinedSignal))
            }
            if (includePrimary) {
              await verifyWorkspace(combinedSignal)
              if (input.operation === "pull") {
                await importPrimaryCommit(workspace, primaryCommit, combinedSignal)
                await git(workspace, ["merge", "--ff-only", "--no-edit", primaryCommit], { signal: combinedSignal })
              } else {
                await controller.resetPrimary(workspace, primaryCommit, { signal: combinedSignal })
                await afterReset?.({ signal: combinedSignal })
              }
              results.push({ name: "primary", path: workspace, branch: primary.branch, localBranch: localRef,
                commit: await git(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], { signal: combinedSignal }) })
            }
            log(`Harness Git ${input.operation}: ${results.map(result => `${result.name} ${result.branch} ${result.commit}`).join("; ")}`)
            return { operation: input.operation, repositories: results }
          })
        },
      }
    },
  }
  return controller
}
