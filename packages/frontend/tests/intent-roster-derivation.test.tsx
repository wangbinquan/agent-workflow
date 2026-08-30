// RFC-348 D6 — the six frontend intent surfaces derive their resource-type
// roster from the shared `INTENT_RESOURCE_TYPES` / `IntentResourceType`
// instead of hand-copying the six literals. A seventh intent type then reaches
// the create composer, the mount dialog, the op preview, the entry button, the
// provenance badge and the /intent route without a hand edit — and the
// `satisfies Record<IntentResourceType, …>` tables fail to compile until they
// cover it. Source-level locks (repo convention for hard-to-render surfaces).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INTENT_RESOURCE_TYPES } from '@agent-workflow/shared'

const src = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', rel), 'utf8')

const SITES = [
  'routes/intent.tsx',
  'components/IntentMountDialog.tsx',
  'components/IntentEntryButton.tsx',
  'components/IntentProvenanceBadge.tsx',
  'components/intent/IntentCreateComposer.tsx',
  'components/intent/IntentOpPreview.tsx',
] as const

/** The hand-written spellings RFC-348 removed. */
const LITERAL_UNION =
  /'agent'\s*\|\s*'skill'\s*\|\s*'mcp'\s*\|\s*'plugin'\s*\|\s*'workflow'\s*\|\s*'workgroup'/
const LITERAL_ARRAY =
  /\[\s*'agent',\s*'skill',\s*'mcp',\s*'plugin',\s*'workflow',\s*'workgroup'\s*\]/

describe('RFC-348 — intent resource-type roster derivation', () => {
  test('the shared roster is the six types (sanity for the locks below)', () => {
    expect([...INTENT_RESOURCE_TYPES]).toEqual([
      'agent',
      'skill',
      'mcp',
      'plugin',
      'workflow',
      'workgroup',
    ])
  })

  test('no site re-lists the six types by hand; every site names the shared roster', () => {
    for (const site of SITES) {
      const text = src(site)
      expect(text, `${site} still spells the union by hand`).not.toMatch(LITERAL_UNION)
      expect(text, `${site} still spells the array by hand`).not.toMatch(LITERAL_ARRAY)
      expect(
        text.includes('INTENT_RESOURCE_TYPES') || text.includes('IntentResourceType'),
        `${site} must import the shared roster`,
      ).toBe(true)
    }
  })

  test('per-type tables are compile-checked against the roster', () => {
    expect(src('components/intent/IntentCreateComposer.tsx')).toMatch(
      /satisfies Record<IntentResourceType, ReactNode>/,
    )
    expect(src('components/intent/IntentCreateComposer.tsx')).toContain(
      'INTENT_RESOURCE_TYPES.map(',
    )
    expect(src('components/intent/IntentOpPreview.tsx')).toMatch(
      /satisfies Record<\s*IntentResourceType,\s*\(input: OpPreviewRenderInput\) => ReactElement \| null\s*>/,
    )
    expect(src('components/IntentMountDialog.tsx')).toContain(
      'const MOUNT_TYPES = INTENT_RESOURCE_TYPES',
    )
    expect(src('routes/intent.tsx')).toContain('const ARTIFACT_TYPES = INTENT_RESOURCE_TYPES')
  })

  test('self-check: the locks catch the removed spellings', () => {
    expect("type X = 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup'").toMatch(
      LITERAL_UNION,
    )
    expect(
      "const T = ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const",
    ).toMatch(LITERAL_ARRAY)
  })
})
