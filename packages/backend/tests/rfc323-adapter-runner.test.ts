import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  type DevelopmentAdapterContent,
  validateAdapterContract,
} from '@/modules/integration/domain/developmentAdapterDefinition'
import { runPipelineCollect } from '@/modules/integration/infrastructure/developmentAdapterRunner'

const roots: string[] = []
const executableRef = resolve(import.meta.dir, 'fixtures', 'rfc323-adapter-env-probe.ts')
const headSha = '1'.repeat(40)
const targetSha = '2'.repeat(40)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stagedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc323-adapter-env-'))
  roots.push(root)
  return root
}

const content = (secretProjection: string[]): DevelopmentAdapterContent => ({
  schemaVersion: 1 as const,
  purpose: 'pipeline-gate' as const,
  operations: ['collect'],
  contractVersion: 1 as const,
  executableRef,
  parameterSchemaRef: null,
  connectionRef: 'enterprise/jenkins',
  secretProjection,
  outputBudget: { maxFiles: 4, maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 },
  timeoutMs: 5_000,
})

describe('RFC-323 Adapter runner environment projection', () => {
  test('projects only the declared secret and frozen non-secret connection ref', async () => {
    const root = stagedRoot()
    const result = await runPipelineCollect({
      adapterContent: content(['RFC323_ALLOWED_SECRET']),
      operation: { kind: 'pipeline.collect', headSha, targetSha, gateKeysCsv: 'ci,test' },
      stagedRoot: root,
      secretSource: {
        RFC323_ALLOWED_SECRET: 'allowed-value',
        RFC323_UNDECLARED_SECRET: 'must-not-leak',
      },
    })

    expect(result.ok).toBe(true)
    const observed = JSON.parse(readFileSync(join(root, 'env.json'), 'utf8')) as Record<
      string,
      string | null
    >
    expect(observed.RFC323_ALLOWED_SECRET).toBe('allowed-value')
    expect(observed.RFC323_UNDECLARED_SECRET).toBeNull()
    expect(observed.AW_ADAPTER_CONNECTION_REF).toBe('enterprise/jenkins')
    expect(observed.AW_PIPELINE_HEAD).toBe(headSha)
    expect(observed.AW_PIPELINE_TARGET).toBe(targetSha)
    expect(observed.AW_PIPELINE_GATES).toBe('ci,test')
    expect(observed.AW_ADAPTER_SINK).toBe(root)
    expect(observed.PATH).not.toBeNull()
    expect(observed.HOME).not.toBeNull()
    expect(observed.TMPDIR).not.toBeNull()
  })

  test('fails before spawn when a declared daemon-boot secret is missing', async () => {
    const root = stagedRoot()
    const result = await runPipelineCollect({
      adapterContent: content(['RFC323_MISSING_SECRET']),
      operation: { kind: 'pipeline.collect', headSha, targetSha, gateKeysCsv: 'ci' },
      stagedRoot: root,
      secretSource: {},
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: 'configuration',
        code: 'adapter-secret-projection-missing',
        retryability: 'after-configuration',
      },
    })
    expect(existsSync(join(root, 'env.json'))).toBe(false)
  })

  test('domain and runtime both reject reserved or non-portable environment keys', async () => {
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'AW_TOKEN', 'lowercase', '1TOKEN']) {
      expect(validateAdapterContract(content([key]))).toContainEqual({
        code: 'invalid-secret-key',
        detail: key,
      })
    }
    const root = stagedRoot()
    const result = await runPipelineCollect({
      adapterContent: content(['AW_TOKEN']),
      operation: { kind: 'pipeline.collect', headSha, targetSha, gateKeysCsv: 'ci' },
      stagedRoot: root,
      secretSource: { AW_TOKEN: 'must-not-run' },
    })
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'adapter-secret-projection-invalid' },
    })
    expect(existsSync(join(root, 'env.json'))).toBe(false)
  })

  test('maps aw-adapter@1 reserved exit codes without parsing provider text', async () => {
    for (const [exitCode, expected] of [
      [2, { category: 'configuration', retryability: 'after-configuration' }],
      [4, { category: 'business-failure', retryability: 'never' }],
      [5, { category: 'transient', retryability: 'same-input' }],
      [6, { category: 'stale-input', retryability: 'after-refresh' }],
    ] as const) {
      const result = await runPipelineCollect({
        adapterContent: content([]),
        operation: { kind: 'pipeline.collect', headSha, targetSha, gateKeysCsv: 'ci' },
        stagedRoot: stagedRoot(),
        extraEnv: { RFC323_ADAPTER_EXIT_CODE: String(exitCode) },
        secretSource: {},
      })
      expect(result).toMatchObject({
        ok: false,
        failure: { code: `adapter-exit-${exitCode}`, ...expected },
      })
    }
  })

  test('never copies provider stderr into a failure receipt', async () => {
    const sensitive = 'Authorization: Bearer rfc323-super-secret'
    const result = await runPipelineCollect({
      adapterContent: content([]),
      operation: { kind: 'pipeline.collect', headSha, targetSha, gateKeysCsv: 'ci' },
      stagedRoot: stagedRoot(),
      extraEnv: {
        RFC323_ADAPTER_EXIT_CODE: '4',
        RFC323_ADAPTER_STDERR: sensitive,
      },
      secretSource: {},
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { category: 'business-failure', code: 'adapter-exit-4' },
    })
    expect(JSON.stringify(result)).not.toContain(sensitive)
  })
})
