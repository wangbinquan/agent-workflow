// Regression lock — 2026-07-21 insecure-context save-pipeline incident.
//
// A single-binary deployment reached over plain http://<LAN-IP>:<port> is NOT
// a secure context, so the browser exposes no `crypto.subtle` there (only
// https:// and localhost get SubtleCrypto). The workflow editor hashed every
// snapshot straight through `globalThis.crypto.subtle.digest(...)`, so in
// that environment every save attempt threw `TypeError: ... reading 'digest'`
// before the PUT was even issued, the rejection was swallowed by
// `void prepareSave(...)`, and:
//   * autosave never fired — new nodes vanished on reload ("无法新建节点"),
//   * ensureSaved() never settled — Validate / Launch hung forever,
//   * the draft stayed dirty — every reload warned about unsaved changes.
//
// These tests emulate that environment by stubbing a `crypto` WITHOUT
// `subtle` and require the editor's hashes to still resolve — byte-for-byte
// identical to the WebCrypto digest (the server recomputes snapshot hashes,
// so the fallback and WebCrypto paths MUST agree). A source guard bans any
// new direct `crypto.subtle` dereference in the frontend; the sanctioned
// spelling is `globalThis.crypto?.subtle` handed to `sha256Hex`, which falls
// back to the pure-JS digest. End-to-end sibling: e2e/insecure-context-save.spec.ts.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowDefinition, WorkflowDraftSnapshot } from '@agent-workflow/shared'
import { hashWorkflowDraftSnapshot } from '@/lib/workflow-editor-draft'
import { workflowStarterCandidateHash } from '@/components/workflow-editor/WorkflowStarterDialog'
import { bytesToHex, sha256DigestJs, sha256Hex } from '@/lib/sha256'

const DEFINITION: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }

function snapshot(): WorkflowDraftSnapshot {
  return {
    name: 'workflow',
    description: 'insecure-context regression',
    definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
  }
}

// Everything EXCEPT subtle stays available — matches real insecure contexts,
// where crypto.getRandomValues exists but SubtleCrypto does not.
function stripSubtle(): void {
  const original = globalThis.crypto
  vi.stubGlobal('crypto', {
    getRandomValues: original.getRandomValues.bind(original),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('editor hashing without crypto.subtle (insecure http:// context)', () => {
  test('hashWorkflowDraftSnapshot resolves and matches the WebCrypto digest', async () => {
    const withSubtle = await hashWorkflowDraftSnapshot(snapshot())
    stripSubtle()
    expect(globalThis.crypto.subtle).toBeUndefined()
    await expect(hashWorkflowDraftSnapshot(snapshot())).resolves.toBe(withSubtle)
  })

  test('workflowStarterCandidateHash resolves and matches the WebCrypto digest', async () => {
    const withSubtle = await workflowStarterCandidateHash(DEFINITION)
    stripSubtle()
    expect(globalThis.crypto.subtle).toBeUndefined()
    await expect(workflowStarterCandidateHash(DEFINITION)).resolves.toBe(withSubtle)
  })
})

describe('pure-JS SHA-256 fallback correctness', () => {
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

  test('matches the NIST FIPS 180 test vectors', () => {
    expect(bytesToHex(sha256DigestJs(utf8('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(bytesToHex(sha256DigestJs(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(
      bytesToHex(sha256DigestJs(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    expect(bytesToHex(sha256DigestJs(new Uint8Array(1_000_000).fill(0x61)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  test('agrees with WebCrypto across every padding boundary (0..130 bytes) and larger buffers', async () => {
    const subtle = globalThis.crypto.subtle
    const lengths = [...Array.from({ length: 131 }, (_, i) => i), 1_000, 100_000]
    for (const length of lengths) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length * 7 + 3) & 0xff)
      const viaSubtle = await sha256Hex(bytes, subtle)
      expect(bytesToHex(sha256DigestJs(bytes)), `length=${length}`).toBe(viaSubtle)
    }
  })

  test('sha256Hex auto-falls back when the ambient crypto has no subtle', async () => {
    const bytes = utf8('工作流 — insecure context fallback')
    const viaSubtle = await sha256Hex(bytes, globalThis.crypto.subtle)
    stripSubtle()
    await expect(sha256Hex(bytes)).resolves.toBe(viaSubtle)
  })
})

// Source guards: the incident recurs the moment any frontend module assumes
// SubtleCrypto exists. Two bans keep the sanctioned route the only route:
//   1. the spelling `crypto.subtle` (non-optional dereference) is forbidden
//      everywhere in packages/frontend/src — write `globalThis.crypto?.subtle`
//      and hand it to sha256Hex, which must handle undefined;
//   2. `subtle.digest(` call sites live only in lib/sha256.ts.
describe('source guard — no direct SubtleCrypto dependence in the frontend', () => {
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

  test('the non-optional spelling `crypto.subtle` never appears', () => {
    const offenders = files.filter((file) => /crypto\.subtle/.test(readFileSync(file.abs, 'utf8')))
    expect(
      offenders.map((file) => file.rel),
      'Direct `crypto.subtle` dereference throws on plain-http LAN deployments. ' +
        'Spell it `globalThis.crypto?.subtle` and route the digest through lib/sha256.ts#sha256Hex.',
    ).toEqual([])
  })

  test('`subtle.digest(` call sites live only in lib/sha256.ts', () => {
    const offenders = files.filter(
      (file) =>
        file.rel !== 'lib/sha256.ts' && /subtle\.digest\(/.test(readFileSync(file.abs, 'utf8')),
    )
    expect(
      offenders.map((file) => file.rel),
      'Digest through lib/sha256.ts#sha256Hex so the pure-JS fallback keeps covering insecure contexts.',
    ).toEqual([])
  })

  test('the sanctioned home keeps both paths', () => {
    const sha256 = readFileSync(path.join(SRC, 'lib/sha256.ts'), 'utf8')
    expect(sha256).toContain('subtle.digest(')
    expect(sha256).toContain('sha256DigestJs')
  })
})
