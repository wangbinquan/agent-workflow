// Documentation coverage guards, enumerated from the closed constants rather
// than from a hand-copied list.
//
// WHY THIS FILE EXISTS
//
// `NODE_KIND` has an unusual property: adding a member is enforced by the
// compiler in eight places (`satisfies Record<NodeKind, …>` / `never` guards —
// see docs/dev-gotchas.md §新增 NodeKind), but the places that merely *describe*
// the kinds are plain prose, and prose does not typecheck. Two of them are
// load-bearing:
//
//   1. `services/intent/intentDoc.ts` — INTENT.md tells the generating model its
//      node-form list is EXHAUSTIVE, so a kind missing there is a kind the
//      intent builder can never author. RFC-243 and RFC-269 both shipped kinds
//      without returning to it; the builder silently supported 10 of 13 until
//      2026-08-08. That one is guarded inside rfc234-intent-doc.test.ts.
//   2. `docs/workflow-yaml.md` — the human-facing definition reference. It fell
//      further behind (9 of 13: it also missed `script`, which RFC-253 did add
//      to INTENT.md) and its heading even asserted a count, which silently
//      became wrong.
//
// A doc that claims completeness and is not complete is worse than one that
// claims nothing, because readers stop looking. So the claim gets a test.
//
// These assertions are deliberately shallow — presence of a section, not its
// wording. Prose should stay editable without breaking tests; what must not
// change silently is whether a kind is documented AT ALL.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACL_RESOURCE_TYPES, NODE_KIND } from '@agent-workflow/shared'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const yamlDoc = readFileSync(join(REPO_ROOT, 'docs', 'workflow-yaml.md'), 'utf8')

describe('docs/workflow-yaml.md documents every NODE_KIND', () => {
  test('each kind has its own section', () => {
    for (const kind of NODE_KIND) {
      expect(yamlDoc, `no "### \`${kind}\`" section`).toContain(`### \`${kind}\``)
    }
  })

  test('it documents no kind that does not exist', () => {
    const known = new Set<string>(NODE_KIND)
    const documented = [...yamlDoc.matchAll(/^### `([a-z-]+)`$/gm)].map((m) => m[1]!)
    // every `### \`x\`` under nodes[] must be a real kind (the file has no other
    // backticked h3 sections; if that changes, scope this to the nodes section)
    for (const kind of documented) {
      expect(known.has(kind), `documents unknown kind '${kind}'`).toBe(true)
    }
    expect(documented.length).toBe(NODE_KIND.length)
  })

  // The heading used to read "nine kinds" and was wrong for three releases.
  // Either drop the number or keep it true — a stale count is a claim of
  // completeness that the file does not honour.
  test('the heading does not carry a stale count', () => {
    const heading = yamlDoc.split('\n').find((l) => l.startsWith('## `nodes[]`'))
    expect(heading).toBeDefined()
    const wordNumbers =
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b/i
    const m = wordNumbers.exec(heading!)
    if (m !== null) {
      const words = [
        'one',
        'two',
        'three',
        'four',
        'five',
        'six',
        'seven',
        'eight',
        'nine',
        'ten',
        'eleven',
        'twelve',
        'thirteen',
        'fourteen',
        'fifteen',
      ]
      expect(words.indexOf(m[1]!.toLowerCase()) + 1).toBe(NODE_KIND.length)
    }
    expect(/\b\d+\b/.exec(heading!)?.[0] ?? String(NODE_KIND.length)).toBe(String(NODE_KIND.length))
  })

  // RFC-271 retired single-file YAML export/import. The file kept its name (to
  // preserve inbound links from both READMEs) but must not advertise the
  // retired endpoints as live capability.
  test('it no longer advertises the retired YAML export/import capability', () => {
    expect(yamlDoc).not.toMatch(/the UI lets you\s+\*\*Export YAML\*\*/)
    // the retired endpoints may only appear inside the "this was retired" note
    const retiredNote = yamlDoc.slice(0, yamlDoc.indexOf('## Top-level shape'))
    for (const endpoint of ['POST /api/workflows/import', 'GET /api/workflows/:id/export']) {
      const occurrences = yamlDoc.split(endpoint).length - 1
      const inNote = retiredNote.split(endpoint).length - 1
      expect(occurrences, `${endpoint} mentioned outside the retirement note`).toBe(inNote)
    }
    expect(yamlDoc).toContain('resource-packages.md')
  })
})

// The same shape one level up. RFC-271 normalized the EXPRESSION and the ENGINE
// (`ResourceBundle` + `BundleApply`), so adding a resource type is now caught by
// the compiler wherever a `Record<AclResourceType, …>` exists — for example
// `services/bundle/provider.ts`'s TYPE_RANK. What stayed hand-written is the
// per-type payload spec inside INTENT.md: the model learns a resource's fields
// only from that prose, so a seventh resource type would land in the engine and
// remain invisible to the intent builder. Exactly the drift this repo just paid
// for at the node level, one layer up.
describe('INTENT.md documents every ACL resource type', () => {
  test('each resource type has a payload spec the model can follow', async () => {
    const { buildIntentDoc } = await import('../src/services/intent/intentDoc')
    const doc = buildIntentDoc({
      sessionTitle: 't',
      turns: [],
      currentDraftJson: null,
      validationErrors: [],
      pendingQuestions: [],
      hiddenDependencyNote: null,
      unavailableMountNote: null,
      envelopeNonce: 'aabbccdd11223344',
      langDirective: 'x',
      privileges: { mayAuthorScripts: true, mayAuthorCodeHostCalls: true },
    })
    for (const type of ACL_RESOURCE_TYPES) {
      expect(doc, `no payload spec for resource type '${type}'`).toContain(`- **${type}**:`)
    }
  })
})
