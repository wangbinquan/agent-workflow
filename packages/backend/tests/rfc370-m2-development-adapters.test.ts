// RFC-370 M2: all nine adapter operations execute in the task image; stable
// mutation identities survive a fresh staging receiver and a lost response.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import { composeCrewStationEvidenceStaging } from '@/modules/development-automation/composition/crewstationEvidenceStaging'
import { composeCrewStationDevelopmentAdapters } from '@/modules/integration/composition/crewstationDevelopmentAdapters'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/local/fileEvidenceStore'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { DevelopmentAdapterContent } from '@/modules/integration/domain/developmentAdapterDefinition'
import type {
  AdapterProcessObservation,
  AdapterProgramReference,
} from '@/modules/integration/application/ports/developmentAdapterEffects'
import type { EvidenceStagingReference } from '@/modules/development-automation/application/ports/evidenceStaging'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-development-adapters-'))
  const objects = mkdtempSync(join(tmpdir(), 'aw-development-test-evidence-'))
  const program = join(root, 'adapter.mjs')
  const counter = join(root, 'count.txt')
  writeFileSync(counter, '0')
  writeFileSync(
    program,
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const counter = ${JSON.stringify(counter)};
    writeFileSync(counter, String(Number(readFileSync(counter,'utf8'))+1));
    writeFileSync(join(process.env.AW_ADAPTER_SINK, 'proof.txt'), 'durable proof');
    console.log(JSON.stringify({argv:process.argv.slice(2), head:process.env.AW_PIPELINE_HEAD,
      externalId:process.env.AW_EXTERNAL_ID, key:process.env.AW_IDEMPOTENCY_KEY,
      keys:Object.keys(process.env).filter(k=>k.startsWith('RFC370_'))}));
  `,
  )
  const native = (path: string) =>
    path === '/work' ? root : path.startsWith('/work/') ? join(root, path.slice(6)) : path
  const translate = (value: unknown): unknown =>
    typeof value === 'string'
      ? native(value)
      : Array.isArray(value)
        ? value.map(translate)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key, translate(val)]))
          : value
  const receipts = new Map<string, { input: string; value: unknown }>()
  const runKeys: string[] = []
  let loseNext = false
  const helper: WorkspaceHelper = {
    async call<T>(
      _task: string,
      operation: string,
      value: unknown,
      options?: Parameters<WorkspaceHelper['call']>[3],
    ): Promise<T> {
      const key = options?.operationId
      const encoded = JSON.stringify({ operation, value })
      if (operation === 'development-adapter' && (value as { method: string }).method === 'run')
        runKeys.push(key!)
      if (key && receipts.has(key)) {
        const saved = receipts.get(key)!
        if (saved.input !== encoded) throw new Error('hosted execution request changed')
        return saved.value as T
      }
      const result = await executeWorkspaceTaskImageOperation(
        operation,
        translate(value),
        undefined,
        root,
      )
      if (key) receipts.set(key, { input: encoded, value: result })
      if (
        loseNext &&
        operation === 'development-adapter' &&
        (value as { method: string }).method === 'run'
      ) {
        loseNext = false
        throw new Error('platform reply lost')
      }
      return result as T
    },
  }
  const content: DevelopmentAdapterContent = {
    schemaVersion: 1,
    contractVersion: 1,
    purpose: 'requirement-source',
    operations: ['acquire'],
    executableRef: program,
    parameterSchemaRef: null,
    connectionRef: null,
    secretProjection: [],
    outputBudget: { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 10000 },
    timeoutMs: 5000,
  }
  const evidence = new EvidenceStore(objects)
  const open = () => {
    const staging = composeCrewStationEvidenceStaging({
      helper,
      evidence,
      reference: (_task, path) => native(path),
    })
    return { staging, adapters: composeCrewStationDevelopmentAdapters({ helper, staging }) }
  }
  return {
    root,
    content,
    open,
    evidence,
    runKeys,
    native,
    count: () => Number(readFileSync(counter, 'utf8')),
    loseNext: () => {
      loseNext = true
    },
    close: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(objects, { recursive: true, force: true })
    },
  }
}

test('nine selected purpose operations preserve argv/env policy and stage their evidence', async () => {
  const f = fixture()
  try {
    const { staging, adapters: a } = f.open()
    const bound = await a.requirement.programs.bind(a.configurationFor(f.content))
    if (!bound.ok) throw new Error(bound.failure.code)
    type Common = { program: AdapterProgramReference; staging: EvidenceStagingReference }
    const operations: [string, (common: Common) => Promise<AdapterProcessObservation>][] = [
      ['--acquire', (c) => a.requirement.acquire({ ...c, externalId: 'issue' })],
      [
        '--writeback-questions',
        (c) => a.requirement.questionsWriteback({ ...c, externalId: 'issue', questionsJson: '[]' }),
      ],
      [
        '--collect-answers',
        (c) =>
          a.requirement.answersCollect({ ...c, externalId: 'issue', correlationRef: 'question' }),
      ],
      [
        '--collect-pipeline',
        (c) =>
          a.pipeline.collect({ ...c, headSha: 'head', targetSha: 'target', gateKeysCsv: 'check' }),
      ],
      [
        '--trigger-pipeline',
        (c) =>
          a.pipeline.trigger({
            ...c,
            headSha: 'head',
            gateKeysCsv: 'check',
            idempotencyKey: 'trigger',
          }),
      ],
      [
        '--rerun-pipeline',
        (c) =>
          a.pipeline.rerun({
            ...c,
            runRef: 'run',
            gateKey: 'check',
            headSha: 'head',
            idempotencyKey: 'rerun',
          }),
      ],
      [
        '--submit-approval',
        (c) =>
          a.approval.submit({
            ...c,
            stepRunRef: 'step',
            draftRef: 'draft',
            deadlineAt: 'later',
            idempotencyKey: 'submit',
            intentDigest: 'digest',
          }),
      ],
      ['--lookup-approval', (c) => a.approval.lookup({ ...c, idempotencyKey: 'submit' })],
      ['--observe-approval', (c) => a.approval.observe({ ...c, correlationRef: 'approval' })],
    ]
    for (const [flag, run] of operations) {
      const lease = await staging.factory.create()
      const result = await run({ program: bound.program, staging: lease.reference })
      expect(result.kind).toBe('completed')
      if (result.kind !== 'completed') throw new Error('execution failed')
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout).argv[0]).toBe(flag)
      expect(JSON.parse(result.stdout).keys).toEqual([])
      const bundle = await lease.importTree(f.content.outputBudget)
      expect(
        await f.evidence.documents.readText({
          bundleRef: bundle.bundleId,
          relativePath: 'proof.txt',
        }),
      ).toBe('durable proof')
      await lease.close()
    }
    expect(f.count()).toBe(9)
    const invalid = await a.requirement.programs.bind(
      a.configurationFor({ ...f.content, secretProjection: ['AW_SECRET_KEY'] }),
    )
    expect(invalid).toMatchObject({
      ok: false,
      failure: { code: 'adapter-secret-projection-invalid' },
    })
    const missing = await a.requirement.programs.bind(
      a.configurationFor({
        ...f.content,
        secretProjection: ['RFC370_MISSING_ADAPTER_SECRET_54321'],
      }),
    )
    expect(missing).toMatchObject({
      ok: false,
      failure: { code: 'adapter-secret-projection-missing' },
    })
    expect(f.count()).toBe(9)
  } finally {
    f.close()
  }
}, 30_000)

test('lost mutation reply retains one sink and a fresh receiver resumes the same frozen command', async () => {
  const f = fixture()
  try {
    const run = async (headSha = 'head') => {
      const { staging, adapters } = f.open()
      const lease = await staging.factory.create()
      const bound = await adapters.pipeline.programs.bind(adapters.configurationFor(f.content))
      if (!bound.ok) throw new Error(bound.failure.code)
      try {
        return await adapters.pipeline.trigger({
          program: bound.program,
          staging: lease.reference,
          headSha,
          gateKeysCsv: 'check',
          idempotencyKey: 'same-operation',
        })
      } finally {
        await lease.close()
      }
    }
    f.loseNext()
    await expect(run()).rejects.toThrow('reply lost')
    expect(f.count()).toBe(1)
    const receipt = await run()
    expect(receipt.kind).toBe('completed')
    expect(f.count()).toBe(1)
    expect(f.runKeys[0]).toBe(f.runKeys[1])
    expect(existsSync(join(f.root, 'evidence-staging'))).toBe(true)
    await expect(run('changed')).rejects.toThrow('request changed')
    expect(f.count()).toBe(1)
  } finally {
    f.close()
  }
}, 15_000)
