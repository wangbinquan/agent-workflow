// RFC-035 PR2 — source-level guard: the four retrofit components MUST
// use the shared tabs chain with a `.tabs--<modifier>` styling flavour,
// not the legacy bespoke class names. RFC-150 PR-3 rewrote the anchor:
// the modifier now arrives through the shared `<TabBar variant="...">`
// primitive instead of a hand-rolled `.tabs.tabs--<modifier>` literal —
// semantics unchanged (same DOM classes render), only the anchor follows
// the new form. CSS for the legacy classes (.inspector__tabs,
// .agent-import__tabs, .repo-source-tabs__bar) is preserved as a visual
// fallback during the cleanup window.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

// RFC-165: the RepoSourceRow entry is gone — the path/url segmented tabs were
// retired together with the local-path launch mode (the row is URL-only now).
const CASES: Array<{ file: string; variant: string }> = [
  { file: 'components/NodeDetailDrawer.tsx', variant: 'inspector' },
  { file: 'components/canvas/NodeInspector.tsx', variant: 'inspector' },
  { file: 'components/AgentImportDialog.tsx', variant: 'inline' },
]

describe('RFC-035 .tabs retrofit grep guard (RFC-150: TabBar variant form)', () => {
  for (const c of CASES) {
    test(`${c.file} renders <TabBar variant="${c.variant}">`, () => {
      const body = readFileSync(path.resolve(SRC, c.file), 'utf8')
      expect(body.includes('<TabBar'), `${c.file} must render the shared <TabBar>`).toBe(true)
      expect(
        body.includes(`variant="${c.variant}"`),
        `${c.file} missing variant="${c.variant}"`,
      ).toBe(true)
      // No hand-rolled tab strip may sneak back in next to the primitive.
      expect(body.includes('role="tablist"'), `${c.file} hand-rolls role="tablist"`).toBe(false)
      expect(body.includes('tabs__tab'), `${c.file} hand-rolls .tabs__tab markup`).toBe(false)
    })
  }

  test('the legacy class names are no longer in JSX className strings (CSS may still keep them)', () => {
    const bodies: Record<string, string> = {}
    for (const c of CASES) bodies[c.file] = readFileSync(path.resolve(SRC, c.file), 'utf8')
    // `Record<string,string>` index access reads as possibly-undefined
    // under strict TS even though we just populated the map above; `!` is
    // the minimal nudge to satisfy the compiler without changing runtime
    // behaviour.
    expect(bodies['components/NodeDetailDrawer.tsx']!.includes('inspector__tabs"')).toBe(false)
    expect(bodies['components/canvas/NodeInspector.tsx']!.includes('inspector__tabs"')).toBe(false)
    // AgentImportDialog: only the tabs block was retrofitted; other
    // namespaced .agent-import__* class names survive (cleanup PR will
    // remove them once the <Dialog> retrofit lands in PR3).
    expect(bodies['components/AgentImportDialog.tsx']!.includes('agent-import__tabs')).toBe(false)
    expect(bodies['components/AgentImportDialog.tsx']!.includes('agent-import__tab"')).toBe(false)
  })
})
