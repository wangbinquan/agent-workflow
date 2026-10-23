// RFC-395 II-a A3：所有 familyHistory 站点与帧语义账本双向锁定，防止漏记或遗留无效例外。
// RFC-395 II-a A3: branchTrace now gets the same history snapshot through its injected reader.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ledger from '../fixtures/rfc395-selection-semantics-ledger.json'
import { familyHistorySites, selectionSemanticsViolations } from '../helpers/selectionSemantics'

const backend = resolve(import.meta.dir, '../..')
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : []
  })
}

describe('RFC-395 II-a A3 selection semantics ledger', () => {
  test('every familyHistory call is recorded and every recorded site still exists', () => {
    const files = sources(join(backend, 'src')).filter(
      (file) => !file.replaceAll('\\', '/').includes('/runSelection/oracle/'),
    )
    expect(files.length).toBeGreaterThan(1000)
    const actual = files.flatMap((file) =>
      familyHistorySites(relative(backend, file), readFileSync(file, 'utf8')),
    )
    expect(selectionSemanticsViolations(actual, ledger.sites)).toEqual([])
    for (const entry of ledger.sites) {
      expect(entry.today.length).toBeGreaterThan(10)
      expect(entry.whyFrameless.length).toBeGreaterThan(10)
      expect(actual.find((site) => site.site === entry.site)?.source).toBe(entry.source)
    }
  })

  test('negative controls find added calls, changed filters, deleted sites and bracket calls', () => {
    const initial = familyHistorySites(
      'src/example.ts',
      `async function review() { return reader.familyHistory(taskId, { nodeId }) }`,
    )
    const added = familyHistorySites(
      'src/example.ts',
      `async function review() { await reader.familyHistory(taskId, { nodeId }); return reader['familyHistory'](taskId, {}) }`,
    )
    expect(added.map((site) => site.site)).toEqual([
      'src/example.ts#review:1',
      'src/example.ts#review:2',
    ])
    expect(selectionSemanticsViolations(added, initial)).toContain(
      'unrecorded:src/example.ts#review:2',
    )
    const changed = familyHistorySites(
      'src/example.ts',
      `async function review() { return reader.familyHistory(taskId, { nodeId, containerRunId }) }`,
    )
    expect(selectionSemanticsViolations(changed, initial)).toEqual([
      'changed:src/example.ts#review:1',
    ])
    expect(selectionSemanticsViolations([], initial)).toEqual(['missing:src/example.ts#review:1'])
    expect(selectionSemanticsViolations(initial, initial)).toEqual([])
    expect(selectionSemanticsViolations([...initial, ...initial], initial)).toContain(
      'actual:duplicate:src/example.ts#review:1',
    )
    expect(
      familyHistorySites(
        'src\\example.ts',
        `async function review() { return reader.familyHistory(taskId, { nodeId }) }`,
      ),
    ).toEqual(initial)
    expect(
      familyHistorySites(
        'src/example.ts',
        `// reader.familyHistory(taskId, {})
const text = 'familyHistory'`,
      ),
    ).toEqual([])
  })
})
