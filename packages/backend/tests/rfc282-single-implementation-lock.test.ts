// RFC-282 A2 (§4.1) — source-level single-implementation lock.
//
// Three families of facts, each with a ratcheted exception ledger:
//   1. every resource-conversion function has exactly ONE definition point and
//      its call sites live inside an explicit whitelist (adding a call site
//      must edit this file — review-visible);
//   2. forbidden token families: runtime wire/config knowledge must not appear
//      outside services/runtime/** (and the two C3-pending opencode embed
//      modules), and driver internals must not be laundered back out through
//      `export … from`;
//   3. the RFC282 exception ledgers themselves are STALE-RATCHETED (copied
//      from scripts/depcheck.ts's staleIgnores): an entry that no longer
//      matches fails the suite, so the ledgers can only shrink. Ledger empty =
//      完工判据 1 (proposal §8).
//
// The lock proves its own teeth (RFC-280 实现门 P2-D: a guard that cannot
// catch a violation is not a guard): a sanity block feeds known-bad fixtures
// through the same matchers.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const FILES = walk(SRC).map((p) => ({
  rel: relative(SRC, p).replaceAll('\\', '/'),
  text: readFileSync(p, 'utf8'),
}))

/** Strip line comments and block comments so doc references don't trip token
 *  matchers. Keeps string literals intact (naive but sufficient: the tokens we
 *  ban do not appear inside template literals with comment markers). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// ---------------------------------------------------------------------------
// 1. conversion functions: one definition, whitelisted call sites
// ---------------------------------------------------------------------------

interface ConversionLock {
  readonly face: string
  readonly fn: string
  /** file that owns the ONE definition */
  readonly definedIn: string
  /** files allowed to CALL it (definition file implicitly allowed) */
  readonly callers: readonly string[]
}

// Call-site whitelists mirror today's wiring; B/C batches shrink them.
const CONVERSION_LOCKS: readonly ConversionLock[] = [
  {
    face: 'mcp-wire-opencode',
    fn: 'renderOpencodeMcpEntry',
    definedIn: 'services/execution/agentInjection.ts',
    callers: [],
  },
  {
    face: 'mcp-wire-claude',
    fn: 'renderClaudeMcpServerEntry',
    definedIn: 'services/execution/agentInjection.ts',
    callers: [],
  },
  {
    face: 'agent-entry-opencode',
    fn: 'renderOpencodeAgentEntry',
    definedIn: 'services/execution/agentInjection.ts',
    callers: ['services/runtime/opencode/driver.ts', 'services/runtime/opencode/inlineConfig.ts'],
  },
  {
    face: 'subagent-entries-claude',
    fn: 'renderClaudeSubagentEntries',
    definedIn: 'services/execution/agentInjection.ts',
    callers: ['services/runtime/claudeCode/inject.ts'],
  },
  {
    face: 'skill-staging',
    fn: 'stageSkills',
    definedIn: 'services/runtime/stageSkills.ts',
    callers: ['services/runtime/opencode/driver.ts', 'services/runtime/claudeCode/config.ts'],
  },
  {
    face: 'plugin-spec',
    fn: 'buildPluginSpecArray',
    definedIn: 'services/runtime/opencode/pluginSpec.ts',
    callers: ['services/runtime/opencode/inlineConfig.ts'],
  },
  {
    face: 'permission-map-claude',
    fn: 'mapAgentPermissionToClaudeTools',
    definedIn: 'services/runtime/claudeCode/permissionMap.ts',
    callers: [],
  },
  {
    face: 'boundary-opencode',
    fn: 'composeOpencodeBoundary',
    definedIn: 'services/execution/workspaceBoundary.ts',
    callers: ['services/runtime/opencode/inlineConfig.ts'],
  },
  {
    face: 'boundary-claude',
    fn: 'composeClaudeBoundarySettings',
    definedIn: 'services/execution/workspaceBoundary.ts',
    callers: [],
  },
]

describe('RFC-282 A2 — conversion definition points are unique', () => {
  for (const lock of CONVERSION_LOCKS) {
    test(`${lock.face}: '${lock.fn}' defined once, called only from the whitelist`, () => {
      const defRe = new RegExp(`(?:export )?function ${lock.fn}\\(`)
      const defFiles = FILES.filter((f) => defRe.test(f.text)).map((f) => f.rel)
      expect(defFiles).toEqual([lock.definedIn])

      const callRe = new RegExp(`(?<![.\\w])${lock.fn}\\(`)
      const callFiles = FILES.filter(
        (f) => f.rel !== lock.definedIn && callRe.test(stripComments(f.text)),
      ).map((f) => f.rel)
      const allowed = new Set(lock.callers)
      const strays = callFiles.filter((f) => !allowed.has(f))
      expect(strays).toEqual([])
      // Ratchet the other way too: a whitelist entry that no longer calls it
      // is stale and must be pruned.
      const staleWhitelist = lock.callers.filter((c) => !callFiles.includes(c))
      expect(staleWhitelist).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// 2. forbidden token families outside services/runtime/**
// ---------------------------------------------------------------------------

/** C3-pending modules: the opencode embed production line still lives at src
 *  root; it MOVES wholesale in C3 (its entries here die with that batch). */
// Currently EMPTY — today's non-comment code is already clean; C3 moves the
// embed production line wholesale, so no entries are expected to appear.
const RUNTIME_TOKEN_EXCEPTIONS: readonly string[] = []

const FORBIDDEN_TOKENS = ['OPENCODE_CONFIG_CONTENT', '--mcp-config', '.claude/'] as const

describe('RFC-282 A2 — runtime wire knowledge stays inside the fence', () => {
  test('forbidden tokens appear only under services/runtime/ (+ C3-pending exceptions)', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      if (f.rel.startsWith('services/runtime/')) continue
      if (RUNTIME_TOKEN_EXCEPTIONS.includes(f.rel)) continue
      const code = stripComments(f.text)
      for (const token of FORBIDDEN_TOKENS) {
        if (code.includes(token)) offenders.push(`${f.rel} :: ${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('C3-pending exceptions are live (stale ratchet)', () => {
    // Empty ledger short-circuits; the loop is the ratchet for future entries.
    for (const rel of RUNTIME_TOKEN_EXCEPTIONS) {
      const f = FILES.find((x) => x.rel === rel)
      expect(f, `${rel} vanished — prune the exception`).toBeDefined()
      const code = stripComments(f!.text)
      expect(
        FORBIDDEN_TOKENS.some((t) => code.includes(t)),
        `${rel} no longer carries a forbidden token — prune the exception`,
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. re-export laundering + ESLint exception ledger (three-tuple + ratchet)
// ---------------------------------------------------------------------------

const REEXPORT_RE =
  /^export\s+(?:\{[^}]*\}|\*)\s+from\s+['"][^'"]*runtime\/(?:opencode|claudeCode)\/[^'"]*['"]/m

/** (file, next-line import text) tuples allowed to carry an eslint-disable for
 *  no-restricted-imports. Owning batch in the comment at the site. Ledger
 *  empty = 完工判据 1. */
const RFC282_IMPORT_EXCEPTIONS: readonly { file: string; importText: string }[] = [
  {
    file: 'services/runner.ts',
    importText:
      "export { accumulateTokens, extractTextFromEvent, inferEventKind } from './runtime/opencode/events'",
  },
  {
    file: 'services/runner.ts',
    importText: "export { buildCommand } from './runtime/opencode/spawn'",
  },
  {
    file: 'services/runner.ts',
    importText:
      "export { buildInlineAgentEntry, buildInlineConfig } from './runtime/opencode/inlineConfig'",
  },
  {
    file: 'services/runtimeRegistry.ts',
    importText: "import { CLAUDE_PLATFORM_OWNED_FLAGS } from '@/services/runtime/claudeCode/spawn'",
  },
]

describe('RFC-282 A2 — re-export laundering & the import-exception ledger', () => {
  test('no NEW export-from of driver internals outside the ledger', () => {
    const ledgeredReexports = new Set(
      RFC282_IMPORT_EXCEPTIONS.filter((e) => e.importText.startsWith('export')).map(
        (e) => `${e.file}::${e.importText}`,
      ),
    )
    const offenders: string[] = []
    for (const f of FILES) {
      if (f.rel.startsWith('services/runtime/')) continue
      for (const line of stripComments(f.text).split('\n')) {
        if (REEXPORT_RE.test(line) && !ledgeredReexports.has(`${f.rel}::${line.trim()}`)) {
          offenders.push(`${f.rel} :: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('every eslint-disable of no-restricted-imports is in the ledger (and vice versa — stale ratchet)', () => {
    const found: { file: string; importText: string }[] = []
    for (const f of FILES) {
      const lines = f.text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes('eslint-disable-next-line no-restricted-imports')) {
          found.push({ file: f.rel, importText: (lines[i + 1] ?? '').trim() })
        }
      }
    }
    const foundKeys = new Set(found.map((e) => `${e.file}::${e.importText}`))
    const ledgerKeys = new Set(RFC282_IMPORT_EXCEPTIONS.map((e) => `${e.file}::${e.importText}`))
    const unledgered = [...foundKeys].filter((k) => !ledgerKeys.has(k))
    const stale = [...ledgerKeys].filter((k) => !foundKeys.has(k))
    expect(unledgered).toEqual([]) // new exception without a ledger entry
    expect(stale).toEqual([]) // ledger entry whose site was fixed — prune it
  })
})

// ---------------------------------------------------------------------------
// 4. inline-duplicate ledger (RFC282_DEFINITION_EXCEPTIONS) — counted, ratcheted
// ---------------------------------------------------------------------------

interface DuplicateEntry {
  readonly what: string
  readonly owning: string
  readonly signature: RegExp
  /** files expected to carry the duplicate today; convergence shrinks this */
  readonly sites: readonly { file: string; count: number }[]
}

export const RFC282_DEFINITION_EXCEPTIONS: readonly DuplicateEntry[] = [
  // B4 CONVERGED (2026-08-12): memory weave → agentInjection.weaveMemoryBlock;
  // mcp-config write → ONE claude helper; plugin filter → declarePlugins /
  // selectShippedPlugins; managed predicate → managedSkillsOf. The pinned
  // counts below now lock the SINGLE remaining spelling of each.
  {
    what: 'memory weave — drivers must use weaveMemoryBlock (no inline template)',
    owning: 'B4',
    signature: /\$\{ctx\.injectedMemoryBlock\}/,
    sites: [],
  },
  {
    what: 'claude mcp-config write — the ONE helper',
    owning: 'B4',
    signature: /= join\([^)]+, 'mcp-config\.json'\)/,
    sites: [{ file: 'services/runtime/claudeCode/driver.ts', count: 1 }],
  },
  {
    what: 'plugin enabled filter — declarePlugins + selectShippedPlugins only',
    owning: 'B4',
    signature: /\((?:p|plugin)\) => (?:p|plugin)\.enabled !== false|if \(p\.enabled === false\)/,
    sites: [
      { file: 'services/execution/agentInjection.ts', count: 1 },
      { file: 'services/runtime/opencode/pluginSpec.ts', count: 1 },
    ],
  },
  {
    what: "managed-skill predicate — managedSkillsOf (+ skillBootVerify's distinct boot gate)",
    owning: 'B4',
    signature: /sourceKind === 'managed'/,
    sites: [
      { file: 'services/execution/agentInjection.ts', count: 1 },
      { file: 'services/skillBootVerify.ts', count: 1 },
    ],
  },
]

describe('RFC-282 A2 — inline-duplicate ledger (counts pinned, both directions)', () => {
  for (const entry of RFC282_DEFINITION_EXCEPTIONS) {
    test(`${entry.what} [→ ${entry.owning}]`, () => {
      const expected = new Map(entry.sites.map((s) => [s.file, s.count]))
      for (const f of FILES) {
        const code = stripComments(f.text)
        const hits = code.split('\n').filter((l) => entry.signature.test(l)).length
        const want = expected.get(f.rel) ?? 0
        expect(
          hits,
          `${f.rel}: '${String(entry.signature)}' hit ${hits}×, ledger says ${want}× — ` +
            (hits > want ? 'a NEW duplicate crept in' : 'convergence happened: shrink the ledger'),
        ).toBe(want)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 4b. B3 — the disabled-plugin error code has ONE spelling site
// ---------------------------------------------------------------------------

describe('RFC-282 B3 — plugin-disabled code is single-sourced', () => {
  test("the 'plugin-disabled' literal exists only at the policy table (+ the issue-code type union)", () => {
    const allowed = new Map([
      ['services/execution/resourcePolicy.ts', 1], // PLUGIN_DISABLED_ERROR_CODE definition
      ['services/agentResourceIntegrity.ts', 1], // the TS literal-type union member
    ])
    for (const f of FILES) {
      const hits = stripComments(f.text).split("'plugin-disabled'").length - 1
      expect(
        hits,
        `${f.rel}: 'plugin-disabled' literal ${hits}×, allowed ${allowed.get(f.rel) ?? 0}× — emitters must import PLUGIN_DISABLED_ERROR_CODE`,
      ).toBe(allowed.get(f.rel) ?? 0)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. the lock's own teeth (sanity — RFC-280 实现门 P2-D)
// ---------------------------------------------------------------------------

describe('RFC-282 A2 — sanity: the matchers actually catch violations', () => {
  test('the walk sees a real codebase', () => {
    expect(FILES.length).toBeGreaterThan(200)
  })

  test('a smuggled forbidden token would be caught', () => {
    const fixture = 'const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) }'
    expect(FORBIDDEN_TOKENS.some((t) => stripComments(fixture).includes(t))).toBe(true)
  })

  test('a commented-out token is NOT flagged (comment stripping works)', () => {
    const fixture = '// mentions OPENCODE_CONFIG_CONTENT in prose only\nconst x = 1\n'
    expect(FORBIDDEN_TOKENS.some((t) => stripComments(fixture).includes(t))).toBe(false)
  })

  test('a smuggled re-export would be caught', () => {
    expect(REEXPORT_RE.test("export { x } from './runtime/opencode/spawn'")).toBe(true)
    expect(REEXPORT_RE.test("export * from '../runtime/claudeCode/events'")).toBe(true)
    expect(REEXPORT_RE.test("import { x } from './runtime/opencode/spawn'")).toBe(false)
  })

  test('a second definition of a locked conversion would be caught', () => {
    const defRe = /(?:export )?function renderOpencodeMcpEntry\(/
    expect(defRe.test('export function renderOpencodeMcpEntry(m: Mcp) {')).toBe(true)
  })
})
