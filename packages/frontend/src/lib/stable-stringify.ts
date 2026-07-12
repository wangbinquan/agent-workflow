// RFC-169 (T1) — order-independent structural serialization for dirty tracking.
//
// The split-page draft dirty check compares the current draft against its seed
// snapshot. A plain `JSON.stringify` preserves *insertion* order, so two objects
// with identical content but keys added in a different order would compare
// unequal and falsely report "dirty". `stableStringify` recursively sorts object
// keys before serializing, so the output is a canonical fingerprint of the
// value's content:
//
//   - object members are emitted in sorted-key order (recursively);
//   - undefined-valued members are dropped (identical to JSON.stringify, so a
//     draft that never set an optional field matches a seed that set it to
//     undefined);
//   - array element order is preserved (arrays are ordered data);
//   - scalars pass through unchanged;
//   - a top-level `undefined` serializes to the sentinel string 'undefined'
//     (distinct from null → 'null' and from missing).
//
// Locked by tests/stable-stringify.test.ts.

export function stableStringify(v: unknown): string {
  const out = JSON.stringify(v, (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const src = value as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(src).sort()) {
        sorted[k] = src[k]
      }
      return sorted
    }
    return value
  })
  // JSON.stringify returns the JS value `undefined` (not a string) for a
  // top-level undefined/function/symbol — normalize to a stable sentinel so the
  // return type stays honest and comparisons behave.
  return out ?? 'undefined'
}
