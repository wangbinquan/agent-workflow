// Regression lock — 2026-07-21, second insecure-context sweep.
//
// RFC-072 already established `lib/clipboard.ts#copyText` because plain
// http://<LAN-IP> deployments have NO `navigator.clipboard` (secure-context
// gated) and a bare `navigator.clipboard.writeText(...)` either throws a
// TypeError (unconditional dereference) or silently no-ops (`?.` spelling) —
// both leave the Copy button dead. Its source guard was scoped to
// TaskOutputPanel.tsx only, and the same bug re-grew in four other files
// (NodeDetailDrawer unconditional crash; Edge/NodeInspector silent `?.`
// no-ops; ReviewDocPane reporting failure instead of using the execCommand
// fallback that would have worked). This file widens the ban to the whole
// frontend: `navigator.clipboard` may appear only inside lib/clipboard.ts,
// everything else routes through copyText and gets the fallback for free.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../src')

function walkSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const candidate = path.join(dir, entry)
    if (statSync(candidate).isDirectory()) out.push(...walkSources(candidate))
    else if (/\.tsx?$/.test(candidate) && !candidate.includes('.test.')) out.push(candidate)
  }
  return out
}

const files = walkSources(SRC).map((abs) => ({
  abs,
  rel: path.relative(SRC, abs).split(path.sep).join('/'),
}))

describe('source guard — navigator.clipboard lives only in lib/clipboard.ts', () => {
  test('every other module routes copies through copyText', () => {
    const offenders = files.filter(
      (file) =>
        file.rel !== 'lib/clipboard.ts' &&
        /navigator\.clipboard/.test(readFileSync(file.abs, 'utf8')),
    )
    expect(
      offenders.map((file) => file.rel),
      'navigator.clipboard is secure-context gated (undefined on plain-http LAN ' +
        'deployments). Use lib/clipboard.ts#copyText, which falls back to ' +
        "document.execCommand('copy').",
    ).toEqual([])
  })

  test('the sanctioned home keeps the async API and the execCommand fallback', () => {
    const clipboard = readFileSync(path.join(SRC, 'lib/clipboard.ts'), 'utf8')
    expect(clipboard).toContain('navigator.clipboard')
    expect(clipboard).toContain("document.execCommand('copy')")
  })
})
