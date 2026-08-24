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

/** Every `{spec file} › {test title}` pair Playwright's grep can match. */
function specEntries(): Array<{ file: string; title: string }> {
  return readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .flatMap((name) =>
      [
        ...readFileSync(join(E2E_DIR, name), 'utf8').matchAll(/^\s*test(?:\.\w+)?\(\s*'([^']+)'/gm),
      ].map((match) => ({ file: name, title: match[1] ?? '' })),
    )
}

/**
 * How many tests a fragment removes. Playwright's grep matches the FILE PATH as
 * well as the title, which is what makes a file-shaped fragment exclude a whole
 * file — the behaviour one of the two entries relies on and the other must not
 * accidentally trigger.
 */
function matchCount(fragment: string): number {
  return specEntries().filter((e) => e.file.includes(fragment) || e.title.includes(fragment)).length
}

describe('RFC-254 T31 — windows e2e exclusions stay honest', () => {
  // Each entry declares HOW MANY tests it is allowed to remove, because the two
  // are deliberately different shapes and only the reader knows which is which:
  //   * `focus-ring-clip` — one broken test among six healthy ones ⇒ by title.
  //   * `rfc250-workflow-camera` — blocked by one canvas defect; excluding just
  //     the first promotes the second to the failure (measured on POSIX) ⇒ by
  //     file, and honestly counted as however many tests that file holds.
  //     RFC-319 T37 added a fourth test to that file (`WF-23`, camera focus
  //     gating). It rides the same file-shaped exclusion for the same canvas
  //     reason, so the count moves 3 → 4 rather than the entry changing shape.
  const EXPECTED_REMOVALS: Record<string, number> = {
    'focus rings are not clipped anywhere': 1,
    'rfc250-workflow-camera': 4,
  }

  test('every exclusion removes exactly the tests it declares', () => {
    const fragments = excludedTitles()
    expect(fragments.sort()).toEqual(Object.keys(EXPECTED_REMOVALS).sort())
    for (const fragment of fragments) {
      // Zero means a rename slipped past and the leg goes red for a reason the
      // list claims to cover. More than declared means the fragment silently
      // widened and is dropping tests nobody decided to drop.
      expect(matchCount(fragment), `exclusion "${fragment}"`).toBe(
        EXPECTED_REMOVALS[fragment] ?? -1,
      )
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
