// RFC-431: the standalone profile states every selection a standalone daemon uses, rooted at the app home it is
// given, and building them touches no disk (the profile is built before the startup lock). The stores that
// create directories open on first use: the evidence store under `appHome/evidence`, and the graph-development
// store at the app home root itself, where v0.19.3 and later already keep its blobs and bundles.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeStandaloneProfile, standaloneSelections } from '@/bootstrap/standalone'
import { NULLABLE_SELECTIONS, REQUIRED_SELECTIONS } from './helpers/deploymentSelectionPartition'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc431-standalone-'))
  roots.push(root)
  return root
}
const BUDGET = { maxFiles: 4, maxFileBytes: 1024, maxTotalBytes: 4096 }

test('the standalone profile states exactly the required and hosted-only selections', () => {
  const selections = standaloneSelections({ appHome: home() })
  expect(Object.keys(selections).sort()).toEqual(
    [...REQUIRED_SELECTIONS, ...NULLABLE_SELECTIONS].sort(),
  )
  for (const key of REQUIRED_SELECTIONS) expect(selections[key]).toBeDefined()
  for (const key of REQUIRED_SELECTIONS) expect(selections[key]).not.toBeNull()
  for (const key of NULLABLE_SELECTIONS) expect(selections[key]).toBeNull()
  expect(selections.hostedBackgroundOwners).toEqual([])
  expect(selections.recoveredExecutionTaskIds()).toEqual([])
  // The composed profile uses the same builder.
  expect(Object.keys(composeStandaloneProfile().selections).sort()).toEqual(
    Object.keys(selections).sort(),
  )
})

test('building the selections touches no disk, not even a missing app home', () => {
  const existing = home()
  standaloneSelections({ appHome: existing })
  expect(readdirSync(existing)).toEqual([])
  const missing = join(home(), 'not-created')
  standaloneSelections({ appHome: missing })
  expect(existsSync(missing)).toBe(false)
})

test('each local selection is rooted at the given app home', async () => {
  const appHome = home()
  const selections = standaloneSelections({ appHome })
  expect(selections.applicationConfiguration.notificationKey).toBe(join(appHome, 'config.json'))
  const stored = await selections.employeePrograms.put({
    runtimeKind: 'node',
    source: 'console.log("rfc431")',
    parameterValues: null,
  })
  expect(existsSync(join(appHome, stored.executableArtifactRef))).toBe(true)
})

test('the evidence store and the graph-development store open on first use at their own roots', async () => {
  const appHome = home()
  const selections = standaloneSelections({ appHome })
  const source = join(home(), 'blob.txt')
  writeFileSync(source, 'rfc431 evidence')
  expect(readdirSync(appHome)).toEqual([])

  const evidence = await selections.evidenceArtifacts.putBlobFromFile(source)
  expect(
    existsSync(join(appHome, 'evidence', 'blobs', evidence.sha256.slice(0, 2), evidence.sha256)),
  ).toBe(true)
  expect(existsSync(join(appHome, 'blobs'))).toBe(false)
  expect(await selections.evidenceArtifacts.hasBlob(evidence.sha256)).toBe(true)

  const graph = await selections.graphDevelopmentArtifacts.putBlobFromFile(source)
  expect(existsSync(join(appHome, 'blobs', graph.sha256.slice(0, 2), graph.sha256))).toBe(true)
  expect(await selections.graphDevelopmentArtifacts.hasBlob(graph.sha256)).toBe(true)
})

test('the requirement document writer creates its staging root on the first write, into the evidence store', async () => {
  const appHome = home()
  const selections = standaloneSelections({ appHome })
  const commands = selections.developmentPurposes.requirement.documentCommands
  expect(typeof commands.writeDocument).toBe('function')
  expect(existsSync(join(appHome, 'evidence'))).toBe(false)
  const bundle = await commands.writeDocument({
    relativePath: 'answer.md',
    content: 'rfc431 answer\n',
    budget: BUDGET,
  })
  expect(existsSync(join(appHome, 'evidence', 'staging'))).toBe(true)
  expect(await selections.evidenceArtifacts.getBundle(bundle.bundleId)).not.toBeNull()
})

test('two builds are independent: no store or binding is shared between app homes', () => {
  const first = standaloneSelections({ appHome: home() })
  const second = standaloneSelections({ appHome: home() })
  expect(first.evidenceArtifacts).not.toBe(second.evidenceArtifacts)
  expect(first.applicationConfiguration).not.toBe(second.applicationConfiguration)
  expect(first.taskRunSelection).not.toBe(second.taskRunSelection)
})
