// RFC-254 T31 — the Windows e2e leg's exclusion list may not rot.
//
// The leg skips exactly two specs, both of which fail on POSIX too and neither
// of which this RFC introduced (attributed by building at each commit in turn:
// `focus-ring-clip` since `01d3e541` took its clipped-ring count from 4 to 108,
// `rfc250-workflow-camera` since the wrapper-drag work). Letting them redden a
// BRAND NEW gate would ship a gate that is red on arrival, which is how a gate
// gets ignored.
//
// An exclusion list decays in two directions, and both are silent:
//   * a renamed test stops being matched — the leg goes red for a reason the
//     list claims to have handled;
//   * a FIXED test stays excluded forever — the leg keeps a hole nobody sees.
// So the list is pinned to the titles it names, and each title must still name
// exactly one test.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const E2E_DIR = join(ROOT, 'e2e')

function excludedTitles(): string[] {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const line = /AW_E2E_WINDOWS_EXCLUDE: '([^']*)'/.exec(ci)
  expect(line, 'the windows exclusion env var must exist while the leg is gated').not.toBeNull()
  return (line![1] ?? '').split('|').filter((part) => part.length > 0)
}

function specTitles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .flatMap((name) => [
      ...readFileSync(join(E2E_DIR, name), 'utf8').matchAll(/^\s*test(?:\.\w+)?\(\s*'([^']+)'/gm),
    ])
    .map((match) => match[1] ?? '')
}

describe('RFC-254 T31 — windows e2e exclusions stay honest', () => {
  test('every excluded title still names exactly one test', () => {
    const titles = specTitles()
    for (const fragment of excludedTitles()) {
      const hits = titles.filter((title) => title.includes(fragment))
      // Zero means a rename slipped past and the leg will go red for a reason
      // the list claims to cover. More than one means the fragment is too broad
      // and is silently dropping tests nobody decided to drop.
      expect(hits, `exclusion "${fragment}"`).toHaveLength(1)
    }
  })

  test('the list is short, and registered where a reader will find it', () => {
    // A growing list is the signal that the leg is being kept green by
    // subtraction rather than by fixing things.
    expect(excludedTitles().length).toBeLessThanOrEqual(2)
    const backlog = readFileSync(join(ROOT, 'docs', 'audit-backlog.md'), 'utf8')
    for (const fragment of excludedTitles()) {
      expect(backlog, `"${fragment}" must be registered in audit-backlog`).toContain(fragment)
    }
  })
})
