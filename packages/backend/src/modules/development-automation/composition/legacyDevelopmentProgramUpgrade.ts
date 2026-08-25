interface ProgramContractRef {
  readonly contractId: string
  readonly version: number
}

interface LegacyDevelopmentProgramUpgradeInput {
  readonly sourceContract: ProgramContractRef
  readonly targetContract: ProgramContractRef
  readonly implementation: {
    readonly kind: 'program'
    readonly runtimeKind: 'bash' | 'node' | 'python'
  }
  readonly source: string
}

type LegacyDevelopmentProgramKind = 'prepare-materials' | 'prepare-approval'

function compatibleProgramKind(
  input: LegacyDevelopmentProgramUpgradeInput,
): LegacyDevelopmentProgramKind | null {
  if (input.implementation.runtimeKind !== 'node' || input.sourceContract.version !== 1) {
    return null
  }
  if (
    input.sourceContract.contractId === 'development.prepare-materials' &&
    input.targetContract.contractId === 'development.prepare-materials' &&
    input.targetContract.version === 3
  ) {
    return 'prepare-materials'
  }
  if (
    input.sourceContract.contractId === 'development.prepare-approval' &&
    input.targetContract.contractId === 'development.draft-approval' &&
    input.targetContract.version === 2
  ) {
    return 'prepare-approval'
  }
  return null
}

function compatibilityWrapper(kind: LegacyDevelopmentProgramKind, legacySource: string): string {
  return `import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const compatibilityKind = ${JSON.stringify(kind)}
const legacySource = ${JSON.stringify(legacySource)}

function directInput() {
  const inline = process.env.AW_PORT_CONTRACT_INPUT
  const file = process.env.AW_PORT_FILE_CONTRACT_INPUT
  const value = inline ?? (file ? readFileSync(file, 'utf8') : '{}')
  return JSON.parse(value)
}

function legacyInput(input) {
  const roundRef = process.env.AW_NODE_RUN_ID || 'development-program-compatibility'
  const common = {
    roundRef,
    executionNonce: '0'.repeat(64),
    contextsJson: '[]',
    connectionRef: null,
  }
  if (compatibilityKind === 'prepare-materials') {
    const workRequest = input.workRequest
    const issueState = {
      repositoryRef: 'compatibility-repository',
      request: workRequest,
      materialArtifactRefs: [],
    }
    return {
      ...common,
      contextsJson: JSON.stringify([{
        id: 'compatibility-issue-context',
        typeId: 'development.issue-handling',
        schemaVersion: 1,
        revision: 1,
        lifecycleState: 'active',
        stateJson: JSON.stringify(issueState),
        artifactRefs: [],
      }]),
      contractInput: {
        workRequest,
        materialTargetDirectory: input.outputDirectory,
      },
    }
  }
  return {
    ...common,
    contractInput: {
      mergeRequest: {
        mergeRequestRef: input.mergeRequest,
        headSha: input.currentVersion,
      },
      connectionRef: { id: 'compatibility-approval-gateway', revision: 1 },
    },
  }
}

function fixtureResult() {
  return compatibilityKind === 'prepare-approval'
    ? { outcome: 'completed', draft: 'Compatibility fixture approval draft.' }
    : { outcome: 'completed' }
}

function completedResult(input, summary) {
  if (compatibilityKind === 'prepare-materials') {
    return { outcome: 'completed', explanation: summary }
  }
  const gateConclusions = Array.isArray(input.gateConclusions)
    ? input.gateConclusions.map((gate) => {
        const name = typeof gate?.name === 'string' ? gate.name : 'gate'
        const conclusion = typeof gate?.conclusion === 'string' ? gate.conclusion : 'unknown'
        return '- ' + name + ': ' + conclusion
      })
    : []
  const draft = [
    '# External approval draft',
    '',
    'Merge request: ' + String(input.mergeRequest ?? ''),
    'Current version: ' + String(input.currentVersion ?? ''),
    'Approval type: ' + String(input.approvalType ?? ''),
    '',
    'Gate conclusions:',
    ...(gateConclusions.length === 0 ? ['- none'] : gateConclusions),
    '',
    summary,
  ].join('\\n')
  return { outcome: 'completed', explanation: summary, draft }
}

function main() {
  const input = directInput()
  if (process.env.AW_TASK_ID === 'execution-contract-fixture') return fixtureResult()
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', legacySource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AW_PORT_CONTRACT_INPUT: JSON.stringify(legacyInput(input)),
      AW_PORT_FILE_CONTRACT_INPUT: '',
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 5 * 1024 * 1024,
  })
  if (child.error) throw child.error
  if (child.status !== 0) {
    throw new Error('legacy program failed: ' + (child.stderr || 'exit ' + String(child.status)))
  }
  const output = JSON.parse(child.stdout.trim())
  const summary = typeof output.summary === 'string' && output.summary.trim().length > 0
    ? output.summary.trim()
    : 'Legacy program completed.'
  return output.status === 'ok'
    ? completedResult(input, summary)
    : { outcome: 'blocked', explanation: summary }
}

try {
  process.stdout.write(JSON.stringify(main()))
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\\n')
  process.exitCode = 1
}
`
}

/**
 * Development owns the semantic mapping between its retired v1 contracts and
 * the current minimal contracts. The common Digital Employee OS only invokes
 * this optional package hook and freezes the returned program artifact.
 */
export function upgradeLegacyDevelopmentProgram(
  input: LegacyDevelopmentProgramUpgradeInput,
): { readonly runtimeKind: 'node'; readonly source: string } | null {
  const kind = compatibleProgramKind(input)
  return kind === null
    ? null
    : { runtimeKind: 'node', source: compatibilityWrapper(kind, input.source) }
}
