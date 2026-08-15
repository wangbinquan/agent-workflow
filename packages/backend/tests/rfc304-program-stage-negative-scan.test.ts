// RFC-304 T11 — the negative scans, each with a reverse self-check.
//
// A negative scan's characteristic failure is scanning nothing: a typo in the
// pattern, a renamed directory, a rule that silently matches zero files. It
// stays green forever and reads as proof. So every scan here comes in a pair:
//
//   forward  — the real source is clean;
//   reverse  — a deliberately violating sample makes the SAME scanner report.
//
// Without the reverse half, "0 violations" means nothing.
//
// Scan 1 — a `kind: 'program'` stage must not dispatch an agent. That is the
// constitution's "program where a program suffices" (AC-10). The stage engine
// already makes it structurally hard (a program stage only ever reaches
// `runners.program`), but an implementation could still import a dispatcher
// directly, so the source is checked too.
//
// Scan 2 — a hook's work-item context must not be shadowable by the author's
// env overlay. `AW_CWI_*` is platform identity, not configuration. The
// behavioural test lives in rfc304-hook-runner; this locks the ORDER in the
// source, because the behaviour depends entirely on those writes coming after
// the assembly.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const MODULE_ROOT = resolve(BACKEND_SRC, 'modules', 'code-capability')

/**
 * Symbols that dispatch an agent. Matching on names rather than on imports is
 * deliberate: a dynamic `await import('@/services/scheduler')` would slip past
 * an import-only check, and that is exactly the shape someone reaches for when
 * they are working around a rule.
 */
const AGENT_DISPATCH_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'runSystemAgent', re: /\brunSystemAgent\s*\(/ },
  { label: 'spawnAgentRuntime', re: /\bspawnAgentRuntime\s*\(/ },
  { label: 'dispatchAgentNode', re: /\bdispatchAgentNode\s*\(/ },
  { label: 'runAgentNode', re: /\brunAgentNode\s*\(/ },
  { label: 'scheduler import', re: /from\s+'@\/services\/scheduler'/ },
  { label: 'dynamic scheduler import', re: /import\s*\(\s*['"]@\/services\/scheduler['"]\s*\)/ },
]

/** Find agent-dispatch sites in a source text. Pure, so the reverse check can use it. */
export function scanForAgentDispatch(source: string): string[] {
  const hits: string[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    // Comments explain the rule; they are not violations of it.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const { label, re } of AGENT_DISPATCH_PATTERNS) {
      if (re.test(line)) hits.push(label)
    }
  }
  return hits
}

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFilesUnder(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('RFC-304 AC-10 — program stages do not dispatch agents', () => {
  test('the scanned tree exists and is non-empty', () => {
    // The scan's own precondition. A renamed module directory would otherwise
    // turn every assertion below into a vacuous pass.
    expect(existsSync(MODULE_ROOT)).toBe(true)
    expect(tsFilesUnder(MODULE_ROOT).length).toBeGreaterThan(0)
  })

  test('forward: no file in code-capability dispatches an agent', () => {
    // The AI path reaches a model through the injected `AiCaller` only, which
    // is what keeps `program` stages provably model-free.
    const offenders: Array<{ file: string; hits: string[] }> = []
    for (const file of tsFilesUnder(MODULE_ROOT)) {
      const hits = scanForAgentDispatch(readFileSync(file, 'utf8'))
      if (hits.length > 0) offenders.push({ file: file.slice(BACKEND_SRC.length + 1), hits })
    }
    expect(offenders).toEqual([])
  })

  test('reverse: the scanner reports a violating sample', () => {
    // Without this, a broken pattern would keep the forward test green forever.
    const violating = [
      "import { runTask } from '@/services/scheduler'",
      'export async function collectContext() {',
      '  const out = await runSystemAgent({ prompt: "summarise this diff" })',
      '  return out',
      '}',
    ].join('\n')
    const hits = scanForAgentDispatch(violating)
    expect(hits).toContain('scheduler import')
    expect(hits).toContain('runSystemAgent')
  })

  test('reverse: a DYNAMIC import is caught too', () => {
    // The workaround shape an import-only check would miss.
    const sneaky = "  const mod = await import('@/services/scheduler')"
    expect(scanForAgentDispatch(sneaky)).toContain('dynamic scheduler import')
  })

  test('a comment mentioning the forbidden symbol is not a violation', () => {
    // Otherwise the rule could not be explained where it applies, and the
    // explanation is most useful exactly there.
    const documented = '// MUST NOT call runSystemAgent() from a program stage.'
    expect(scanForAgentDispatch(documented)).toEqual([])
  })
})

describe('RFC-304 — capability work-item context is not author-overridable', () => {
  // T36 moved the mechanism: `hookRunner` and `monitorScripts` now share one
  // execution implementation (design D4), so the env assembly and the context
  // writes live there. The PROPERTY is unchanged and so is this guard — only
  // the file it reads. Retargeting rather than deleting matters: a guard that
  // is dropped when its subject moves is a guard that protected nothing after
  // the first refactor.
  const SCRIPT_RUN = resolve(MODULE_ROOT, 'application', 'capabilityScriptRun.ts')
  const CALLERS = [
    resolve(MODULE_ROOT, 'application', 'hookRunner.ts'),
    resolve(MODULE_ROOT, 'application', 'monitorScripts.ts'),
  ]

  test('the AW_CWI_* writes come AFTER the env assembly', () => {
    // The behaviour is asserted in rfc304-hook-runner; this locks the mechanism
    // it depends on. Writing the context before the assembly (or letting the
    // overlay apply afterwards) would let a team's hook claim to be running for
    // a different work item — the whole audit trail keyed off `AW_CWI_ROUND_ID`
    // would then be forgeable by its own author.
    const src = readFileSync(SCRIPT_RUN, 'utf8')
    const assemblyIdx = src.indexOf('const assembly = assembleScriptEnv(')
    const contextIdx = src.indexOf('childEnv.AW_CWI_CAPABILITY')
    expect(assemblyIdx).toBeGreaterThan(-1)
    expect(contextIdx).toBeGreaterThan(assemblyIdx)
  })

  test('a caller’s extra keys are applied after the assembly too, never merged into the overlay', () => {
    // `extraEnv` is how a caller adds `AW_CWI_STAGE` / `AW_CWI_SCRIPT`. Folding
    // it into `envOverlay` instead would route those keys through the author
    // filter and let a hook's own `env:` block shadow the stage it is mounted
    // on — the same forgery the test above prevents, one indirection out.
    const src = readFileSync(SCRIPT_RUN, 'utf8')
    const assemblyIdx = src.indexOf('const assembly = assembleScriptEnv(')
    const extraIdx = src.indexOf('Object.entries(spec.extraEnv')
    expect(extraIdx).toBeGreaterThan(assemblyIdx)
    // And the overlay must carry only the author's own env.
    expect(src).toContain('envOverlay: spec.env ?? {}')
  })

  test('every AW_CWI_ key any caller writes is registered in docs/env-flags.md', () => {
    // Duplicates the repo-wide RFC-284 guard on purpose, scoped to this family:
    // that one reports "some token is undocumented" across the whole tree, and
    // when it fires during this RFC's work, this test says which family.
    const docs = readFileSync(
      resolve(BACKEND_SRC, '..', '..', '..', 'docs', 'env-flags.md'),
      'utf8',
    )
    const sources = [SCRIPT_RUN, ...CALLERS].map((file) => readFileSync(file, 'utf8')).join('\n')
    // Both spellings: the shared runner writes `childEnv.AW_CWI_*` directly,
    // and a caller names its own keys inside an `extraEnv` literal.
    const keys = [...sources.matchAll(/\b(AW_CWI_[A-Z_]+)\b/g)].map((m) => m[1]!)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of new Set(keys)) {
      expect(docs).toContain(key)
    }
  })
})
