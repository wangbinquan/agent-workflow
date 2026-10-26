import type { Q1CaptureWindow, Q1Surface } from './compare'

type Value = { present: false } | { present: true; value: unknown }
export interface Q1Difference {
  readonly path: string
  readonly kind: 'value' | 'missing' | 'key-order' | 'serialization'
  readonly old: Value
  readonly new: Value
  allowance?: 'node-run-seq' | 'observation-request-clock'
}
const present = (value: unknown): Value => ({ present: true, value })
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const childPath = (path: string, key: string) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
const clockWithin = (item: Value, capture: Q1CaptureWindow) =>
  item.present &&
  typeof item.value === 'number' &&
  Number.isSafeInteger(item.value) &&
  item.value >= capture.startedAt &&
  item.value <= capture.finishedAt

/** Diagnostics only. The independent byte oracle remains the pass/fail authority. */
export function q1ResponseDifferences(
  surface: Q1Surface,
  before: string,
  after: string,
  windows?: { readonly before: Q1CaptureWindow; readonly after: Q1CaptureWindow },
): Q1Difference[] {
  if (before === after) return []
  const differences: Q1Difference[] = []
  let old: unknown
  let next: unknown
  try {
    old = JSON.parse(before)
    next = JSON.parse(after)
  } catch {
    return [{ path: '$', kind: 'serialization', old: present(before), new: present(after) }]
  }
  const walk = (prior: Value, current: Value, path: string) => {
    if (!prior.present || !current.present) {
      differences.push({ path, kind: 'missing', old: prior, new: current })
      return
    }
    const a = prior.value
    const b = current.value
    if (Object.is(a, b)) return
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++)
        walk(
          i < a.length ? present(a[i]) : { present: false },
          i < b.length ? present(b[i]) : { present: false },
          `${path}[${i}]`,
        )
      return
    }
    if (record(a) && record(b)) {
      const oldKeys = Object.keys(a)
      const newKeys = Object.keys(b)
      if (
        JSON.stringify(oldKeys.filter((key) => Object.hasOwn(b, key))) !==
        JSON.stringify(newKeys.filter((key) => Object.hasOwn(a, key)))
      )
        differences.push({ path, kind: 'key-order', old: present(oldKeys), new: present(newKeys) })
      for (const key of new Set([...oldKeys, ...newKeys]))
        walk(
          Object.hasOwn(a, key) ? present(a[key]) : { present: false },
          Object.hasOwn(b, key) ? present(b[key]) : { present: false },
          childPath(path, key),
        )
      return
    }
    differences.push({ path, kind: 'value', old: prior, new: current })
  }
  walk(present(old), present(next), '$')
  for (const difference of differences) {
    if (
      surface === 'observation' &&
      difference.path === '$.asOf' &&
      windows &&
      clockWithin(difference.old, windows.before) &&
      clockWithin(difference.new, windows.after)
    )
      difference.allowance = 'observation-request-clock'
    const seqIndex = /^\$\.runs\[(\d+)\]\.seq$/.exec(difference.path)?.[1]
    if (
      surface === 'node-runs' &&
      seqIndex !== undefined &&
      (!difference.old.present || difference.old.value === null) &&
      difference.new.present &&
      typeof difference.new.value === 'number' &&
      Number.isSafeInteger(difference.new.value) &&
      record(old) &&
      record(next) &&
      Array.isArray(old.runs) &&
      Array.isArray(next.runs)
    ) {
      const a: unknown = old.runs[Number(seqIndex)]
      const b: unknown = next.runs[Number(seqIndex)]
      if (record(a) && record(b) && a.id === b.id) difference.allowance = 'node-run-seq'
    }
  }
  if (JSON.stringify(old) !== before || JSON.stringify(next) !== after)
    differences.push({
      path: '$',
      kind: 'serialization',
      old: present(before),
      new: present(after),
    })
  return differences
}
