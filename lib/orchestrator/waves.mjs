// Topologically group tasks into ordered waves over their in-plan dependency edges.
// Wave 1 = tasks with no in-plan deps; wave N = tasks whose deps are all in earlier waves.
export function computeWaves(tasks) {
  const ids = new Set(tasks.map((t) => t.id))
  const remaining = new Map(tasks.map((t) => [t.id, (t.dependencies || []).filter((d) => ids.has(d))]))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const placed = new Set()
  const waves = []
  while (placed.size < tasks.length) {
    const wave = [...remaining.keys()].filter((id) => !placed.has(id) && remaining.get(id).every((d) => placed.has(d)))
    if (wave.length === 0) throw new Error('dependency cycle detected — cannot compute waves')
    wave.forEach((id) => placed.add(id))
    waves.push(wave.map((id) => byId.get(id)))
  }
  return waves
}
