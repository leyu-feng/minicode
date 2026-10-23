import { createHash } from "node:crypto"

export function hostedBindingToken(rootToken, binding) {
  return createHash("sha256").update(`${rootToken}\n${binding.workerId}\n${binding.generation}`).digest("hex")
}

export async function startHostedFleet({ bindings, startWorker, request }) {
  const peers = new Map()
  let desired = new Map()
  let active = null
  let recycling = false
  let closing = false
  let tail = Promise.resolve()
  let refresh
  let settle
  const finished = new Promise(resolve => { settle = resolve })

  function stopPeer(peer) {
    peer.stopping ??= Promise.resolve(peer.starting).then(worker => (peer.worker ?? worker)?.stop())
    return peer.stopping
  }

  async function stop(error = null) {
    if (closing) return
    closing = true
    const results = await Promise.allSettled([...peers.values()].map(stopPeer))
    const failed = results.find(result => result.status === "rejected")
    settle(error ?? (failed?.reason ?? null))
  }

  function updateBindings(values) {
    if (closing || recycling) return Promise.resolve()
    if (!Array.isArray(values) || values.length > 32
      || new Set(values.map(binding => binding.poolId)).size !== values.length
      || new Set(values.map(binding => binding.workerId)).size !== values.length
      || values.some(binding => !["workerId", "poolId", "companyId", "generation"]
        .every(key => /^[a-f0-9-]{36}$/.test(binding[key] ?? "")))) {
      return Promise.reject(new Error("Invalid shared Hosted binding inventory"))
    }
    desired = new Map(values.map(binding => [binding.workerId, binding]))
    const synchronize = async () => {
      for (const [id, peer] of peers) {
        if (desired.get(id)?.generation === peer.binding.generation) continue
        peers.delete(id)
        await stopPeer(peer)
      }
      for (const binding of desired.values()) {
        if (closing || recycling) return
        if (peers.has(binding.workerId)) continue
        const peer = { binding, worker: null }
        peers.set(binding.workerId, peer)
        peer.starting = startWorker(binding, async state => {
          if (closing || desired.get(binding.workerId)?.generation !== binding.generation) return false
          if (state.state === "busy") {
            if (active && active !== peer) throw new Error("A shared Hosted container cannot execute two assignments")
            active = peer
          }
          // Finish the broker's result/ready/retired handshake before cleaning repositories.
          if (state.state === "idle" && active === peer) return false
          if (state.state === "stopped") return false
          if (active && active !== peer) return false
          return (await request("state", { ...state, bindingId: binding.workerId })).accepting
        })
        peer.worker = await peer.starting
        if (closing) { await stopPeer(peer); return }
        void peer.worker.finished.then(async error => {
          if (closing) return
          if (active === peer) {
            if (error) { await stop(error); return }
            recycling = true
            try {
              await tail
              desired.clear()
              await Promise.all([...peers.values()].filter(other => other !== peer).map(stopPeer))
              peers.clear()
              const result = await request("recycle", { bindingId: binding.workerId })
              active = null
              recycling = false
              if (!result.accepting) { await stop(); return }
              await updateBindings(result.bindings)
            } catch (failure) { await stop(failure) }
          } else if (error && desired.get(binding.workerId)?.generation === binding.generation) {
            try {
              refresh ??= request("refresh").finally(() => { refresh = null })
              const current = await refresh
              if (current.bindings.some(item => item.workerId === binding.workerId && item.generation === binding.generation)) {
                await stop(error)
              } else await updateBindings(current.bindings)
            } catch (failure) { await stop(failure) }
          }
        }).catch(error => stop(error))
      }
    }
    tail = tail.then(synchronize)
    return tail
  }

  try { await updateBindings(bindings) }
  catch (error) { await stop(error); throw error }
  return { finished, stop, updateBindings }
}
