// RFC-294 N1 — canonical architecture manifests and content-addressed provenance.
//
// The committed JSON is a cache, not a second truth: every test rebuilds it
// from production source with the same generator used by scripts/architecture-census.ts.
// Mutation cases prove that missing FKs, collapsed edge roles, stale source
// digests and tampered historical payloads all fail closed.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  CANONICAL_MANIFEST_PATHS,
  PROVENANCE_ARTIFACTS,
  PUBLIC_SURFACE_OPAQUE_TYPE_ALLOWLIST,
  TARGET_CONTEXT_EDGES,
  TARGET_PUBLIC_CONTEXTS,
  artifactContentDigest,
  artifactPayload,
  buildCanonicalArtifacts,
  projectGovernanceArtifacts,
  stableJson,
  validateCanonicalArtifacts,
  type CanonicalArtifacts,
} from './rfc294Canonical'
import { KNOWN_VIOLATIONS } from '../../../../scripts/depcheck'
import { defineBackgroundJob, defineManagedWorker } from '../../src/platform/background/definitions'
import { toPublicError } from '../../src/platform/errors/publicError'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as Record<string, unknown>
}

function committedArtifacts(): CanonicalArtifacts {
  return Object.fromEntries(
    Object.entries(CANONICAL_MANIFEST_PATHS).map(([name, path]) => [name, readJson(path)]),
  ) as unknown as CanonicalArtifacts
}

function cloneArtifacts(value: CanonicalArtifacts): CanonicalArtifacts {
  return structuredClone(value)
}

function git(...args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  }
}

function designEdges(): Array<{
  fromContext: string
  toContext: string
  role: string
  contract: string
}> {
  const design = readFileSync(
    resolve(REPO_ROOT, 'design/RFC-294-backend-layered-target-architecture/design.md'),
    'utf8',
  )
  const aliases = new Map<string, string>()
  for (const match of design.matchAll(/\b([A-Z]+)\["([a-z0-9-]+)"\]/g)) {
    aliases.set(match[1]!, match[2]!)
  }
  const mermaid = /```mermaid\nflowchart LR\n([\s\S]*?)\n```/.exec(design)?.[1]
  if (mermaid === undefined) throw new Error('RFC-294 context Mermaid block not found')
  const edges: Array<{ fromContext: string; toContext: string; role: string; contract: string }> =
    []
  for (const line of mermaid.split('\n')) {
    const required =
      /^\s*([A-Z]+)(?:\[[^\]]+\])?\s+-\.\s+"implements ([^"]+)"\s+\.->\s+([A-Z]+)/.exec(line)
    if (required !== null) {
      edges.push({
        fromContext: aliases.get(required[1]!) ?? required[1]!,
        toContext: aliases.get(required[3]!) ?? required[3]!,
        role: 'required-implementation',
        contract: required[2]!,
      })
      continue
    }
    const offered = /^\s*([A-Z]+)(?:\[[^\]]+\])?\s+-->\s+([A-Z]+)/.exec(line)
    if (offered !== null) {
      edges.push({
        fromContext: aliases.get(offered[1]!) ?? offered[1]!,
        toContext: aliases.get(offered[2]!) ?? offered[2]!,
        role: 'offered-consumption',
        contract: 'exact-public-entrypoint',
      })
    }
  }
  const matrixLine = design
    .split('\n')
    .find((line) => line.startsWith('| IA `public/types` type-only'))
  if (matrixLine === undefined) throw new Error('RFC-294 authority type-only matrix not found')
  const contexts = [...matrixLine.matchAll(/`([a-z][a-z0-9-]+)`/g)]
    .map((match) => match[1]!)
    .filter((value) => value !== 'public' && value !== 'types')
  for (const fromContext of contexts) {
    edges.push({
      fromContext,
      toContext: 'identity-access',
      role: 'authority-type-only',
      contract: 'identity-access/public/types:AuthorizationSubjectRef+opaque-authority',
    })
  }
  return edges.sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
}

function designPublicContexts(): string[] {
  const design = readFileSync(
    resolve(REPO_ROOT, 'design/RFC-294-backend-layered-target-architecture/design.md'),
    'utf8',
  )
  const table = /### 3\.4 各模块最小 public surface\n[\s\S]*?\n\| 模块[\s\S]*?\n(.*?)\n\n/s.exec(
    design,
  )?.[1]
  if (table === undefined) throw new Error('RFC-294 §3.4 public-surface table not found')
  const excluded = new Set(['resource 子模块', 'resource-catalog/package', 'platform/contracts'])
  return [
    ...new Set(
      table
        .split('\n')
        .map((line) => /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1]?.replaceAll('`', '').trim())
        .filter(
          (value): value is string =>
            value !== undefined && !/^:?-{3,}:?$/.test(value) && !excluded.has(value),
        )
        .map((value) => (value === 'resource-catalog/core' ? 'resource-catalog' : value)),
    ),
  ].sort()
}

describe('RFC-294 N1b canonical architecture manifests', () => {
  const generated = buildCanonicalArtifacts(REPO_ROOT)

  test('the seven canonical manifests and report are exact generated projections', () => {
    const reportMetrics = generated.report.metrics as Record<string, unknown>
    expect(Number(reportMetrics.backendProductionFiles)).toBeGreaterThan(700)
    expect(reportMetrics.unresolvedFirstParty).toEqual([])
    expect(validateCanonicalArtifacts(generated)).toEqual([])
    expect(committedArtifacts()).toEqual(generated)
  }, 60_000)

  test('design DAG, required implementation graph and IA type matrix equal the canonical target edges', () => {
    const expected = TARGET_CONTEXT_EDGES.map(({ fromContext, toContext, role, contract }) => ({
      fromContext,
      toContext,
      role,
      contract,
    })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
    expect(designEdges()).toEqual(expected)
  })

  test('design §3.4 module rows equal the canonical public-surface target contexts', () => {
    expect(designPublicContexts()).toEqual([...TARGET_PUBLIC_CONTEXTS].sort())
    expect(generated.publicSurfaces.targetContexts).toEqual(TARGET_PUBLIC_CONTEXTS)
  })

  test('recursive public fields have no silent or stale opaque type references', () => {
    const entries = generated.publicSurfaces.entries as Array<Record<string, unknown>>
    const observed = [
      ...new Set(
        entries.flatMap((entry) =>
          Array.isArray(entry.unresolvedTypeRefs)
            ? entry.unresolvedTypeRefs.map((value) => String(value))
            : [],
        ),
      ),
    ].sort()
    expect(observed).toEqual([...PUBLIC_SURFACE_OPAQUE_TYPE_ALLOWLIST].sort())
    expect(observed).toContain('Pick')
    expect(observed).not.toContain('K')
    expect(observed.some((value) => value.startsWith('$cycle:'))).toBe(false)

    const resourceRef = entries.find(
      (entry) => entry.id === 'public:resource-catalog:types:ResourceRef',
    )!
    expect(resourceRef.unresolvedTypeRefs).toEqual([])
    expect(resourceRef.publicTypeConsumerIds).toContain(
      'public:resource-catalog:types:GetResourceAclRequest',
    )

    const unknown = cloneArtifacts(generated)
    ;(
      (unknown.publicSurfaces.entries as Array<Record<string, unknown>>)[0]!
        .unresolvedTypeRefs as string[]
    ).push('UnclassifiedContract')
    expect(validateCanonicalArtifacts(unknown)).toContain(
      'public surface opaque type allowlist mismatch',
    )
  })

  test('edge-neutral catalog and digital-employee fields have exact owner, writer, consumer and rollback ledgers', () => {
    const fields = generated.publicSurfaces.governedFieldSurfaces as Array<Record<string, unknown>>
    expect(fields.map((entry) => entry.id).sort()).toEqual([
      'field:StartTaskDeps.catalogVisibility',
      'field:employee_cases.name',
      'field:shared.TaskCatalogVisibility',
      'field:tasks.catalog_visibility',
      'field:tasks.digital_employee_case_id',
    ])
    const launchProjection = fields.find(
      (entry) => entry.id === 'field:StartTaskDeps.catalogVisibility',
    )!
    expect(launchProjection.writers).toHaveLength(4)
    const catalogColumn = fields.find((entry) => entry.id === 'field:tasks.catalog_visibility')!
    expect(
      (catalogColumn.consumers as Array<Record<string, unknown>>).some(
        (consumer) =>
          consumer.ownerEntryId ===
          'owner:packages/backend/src/modules/task-execution/application/adapters/task-catalog-adapter.ts#source',
      ),
    ).toBe(true)

    const dangling = cloneArtifacts(generated)
    const field = (
      dangling.publicSurfaces.governedFieldSurfaces as Array<Record<string, unknown>>
    )[0]!
    ;(field.owner as Record<string, unknown>).ownerEntryId = 'owner:does-not-exist'
    expect(validateCanonicalArtifacts(dangling)).toContain(
      `missing governed field owner: ${String(field.id)}`,
    )
  })

  test('global foreign keys, required-port classification and implementation DAG are closed', () => {
    expect(validateCanonicalArtifacts(generated)).toEqual([])
    expect(generated.crossContextImports.implementationSccs).toEqual([])
    const requiredPorts = generated.crossContextImports.requiredPorts as Array<
      Record<string, unknown>
    >
    expect(requiredPorts.length).toBeGreaterThan(10)
    expect(
      requiredPorts.some(
        (entry) => entry.id === 'required:development-automation:ReconcilerPorts-legacy-aggregate',
      ),
    ).toBe(true)
    expect(
      requiredPorts.every((entry) => entry.status === 'active' || entry.status === 'declared-debt'),
    ).toBe(true)
    expect(
      requiredPorts
        .filter((entry) => entry.status === 'active')
        .every(
          (entry) =>
            (entry.consumerOwnerEntryIds as unknown[]).length > 0 &&
            (entry.providerAdapters as unknown[]).length > 0 &&
            (entry.compositionFiles as unknown[]).length === 1,
        ),
    ).toBe(true)
    expect(
      requiredPorts
        .filter((entry) => entry.status === 'declared-debt')
        .every((entry) => typeof entry.removeAfterWave === 'string'),
    ).toBe(true)
    const exceptions = generated.crossContextImports.architectureExceptions as Array<
      Record<string, unknown>
    >
    expect(exceptions.length).toBeGreaterThan(100)
    expect(
      exceptions.every(
        (entry) =>
          typeof entry.fromSymbol === 'string' &&
          typeof entry.toSymbol === 'string' &&
          typeof entry.expiresOn === 'string' &&
          typeof entry.mutationTest === 'string',
      ),
    ).toBe(true)
  })

  test('off-DAG public imports, composition debt, facade shape and owner digests follow the review projection', () => {
    const observed = generated.crossContextImports.observedEdges as Array<Record<string, unknown>>
    const offeredPairs = new Set(
      (generated.crossContextImports.targetEdges as Array<Record<string, unknown>>)
        .filter((edge) => edge.role === 'offered-consumption')
        .map((edge) => `${String(edge.fromContext)}->${String(edge.toContext)}`),
    )
    expect(
      observed
        .filter((edge) => edge.role === 'offered-consumption')
        .filter(
          (edge) => !offeredPairs.has(`${String(edge.fromContext)}->${String(edge.toContext)}`),
        ),
    ).toEqual([])
    const offDag = observed.filter((edge) => edge.role === 'off-dag-offered')
    expect(offDag.length).toBeGreaterThanOrEqual(9)
    expect(offDag.every((edge) => typeof edge.removeAfterWave === 'string')).toBe(true)
    expect(
      offDag.some(
        (edge) =>
          edge.fromContext === 'task-execution' &&
          edge.toContext === 'collaboration' &&
          edge.removeAfterWave === 'W4',
      ),
    ).toBe(true)

    const facades = generated.facades.entries as Array<Record<string, unknown>>
    expect(
      facades
        .map((entry) => entry.status)
        .every((status) => status === 'thin-facade' || status === 'legacy-implementation'),
    ).toBe(true)
    expect(
      facades.filter((entry) => entry.status === 'thin-facade').map((entry) => entry.file),
    ).toEqual([
      'packages/backend/src/services/clarifyAutoDispatch.ts',
      'packages/backend/src/services/clarifyQueue.ts',
      'packages/backend/src/services/clarifyRerunLedger.ts',
      'packages/backend/src/services/clarifyRounds.ts',
      'packages/backend/src/services/clarifySeal.ts',
      'packages/backend/src/services/protocol.ts',
      'packages/backend/src/services/resourceAccessPolicy.ts',
    ])

    const owners = generated.moduleSymbolOwners.entries as Array<Record<string, unknown>>
    const digested = owners.filter((entry) => typeof entry.signatureDigest === 'string')
    expect(digested.length).toBeLessThan(owners.length)
    expect(
      digested.every(
        (entry) =>
          String(entry.file).startsWith('external:') ||
          /\/modules\/[^/]+\/public\/(?:commands|events|participants|queries|types)\.ts$/.test(
            String(entry.file),
          ),
      ),
    ).toBe(true)
    const owner = (file: string, symbol = '$file'): Record<string, unknown> =>
      owners.find((entry) => entry.file === file && entry.symbol === symbol)!
    expect(owner('packages/backend/src/services/isolatedAgentRun.ts')).toMatchObject({
      targetContext: 'platform',
      removeAfterWave: 'W9',
    })
    expect(
      owner('packages/backend/src/modules/task-execution/composition/nodeMechanics.ts'),
    ).toMatchObject({ targetLayer: 'engine', removeAfterWave: 'W4-E1' })
    expect(
      owner(
        'packages/backend/src/modules/development-automation/composition/employeeTypePackage.ts',
      ),
    ).toMatchObject({ targetLayer: 'application', removeAfterWave: 'W4-E8' })
    expect(owner('packages/backend/src/modules/task-execution/composition.ts')).toMatchObject({
      targetLayer: 'composition',
      removeAfterWave: null,
    })
  })

  test('node_runs INSERT and transaction callback denominators are source-complete', () => {
    const sites = generated.mutationEntrypoints.nodeRunInsertSites as Array<Record<string, unknown>>
    expect(sites.map(({ file, status }) => ({ file, status }))).toEqual([
      {
        file: 'packages/backend/src/services/nodeRunMint.ts',
        status: 'canonical-writer',
      },
      {
        file: 'packages/backend/src/services/taskQuestionDispatch.ts',
        status: 'reviewed-dispatch-exception',
      },
    ])
    expect(
      (generated.transactionExternalEffects.entries as Array<Record<string, unknown>>).length,
    ).toBeGreaterThan(50)
  })

  test('RFC-328 task-owned effects and every code-host binding are canonical and mutation-sensitive', () => {
    const ledger = generated.transactionExternalEffects.taskExecutionEffectLedger as Record<
      string,
      unknown
    >
    const entries = ledger.entries as Array<Record<string, unknown>>
    const bindings = ledger.codeHostBindings as Array<Record<string, unknown>>
    expect(entries.length).toBeGreaterThan(8)
    expect(ledger.unknown).toEqual([])
    expect(bindings.length).toBeGreaterThan(50)
    expect(
      bindings
        .filter((entry) => entry.action === 'mr.approve')
        .every((entry) => entry.recoveryClass === 'R-ACTOR'),
    ).toBe(true)

    const unjournaled = cloneArtifacts(generated)
    const unjournaledLedger = unjournaled.transactionExternalEffects
      .taskExecutionEffectLedger as Record<string, unknown>
    const unjournaledEntry = (unjournaledLedger.entries as Array<Record<string, unknown>>)[0]!
    delete unjournaledEntry.resourceKeySetResolver
    expect(validateCanonicalArtifacts(unjournaled)).toContain(
      `task-execution effect '${String(unjournaledEntry.id)}' lacks resourceKeySetResolver`,
    )

    const incomplete = cloneArtifacts(generated)
    const incompleteLedger = incomplete.transactionExternalEffects
      .taskExecutionEffectLedger as Record<string, unknown>
    const incompleteBindings = incompleteLedger.codeHostBindings as Array<Record<string, unknown>>
    const removed = incompleteBindings.shift()!
    expect(validateCanonicalArtifacts(incomplete)).toContain(
      `code-host recovery matrix: missing code-host recovery binding '${String(removed.id)}'`,
    )
  })

  test('RFC-328 durable writers close four authorities and all six control subtypes', () => {
    const ledger = generated.mutationEntrypoints.taskExecutionAuthorityLedger as Record<
      string,
      unknown
    >
    const entries = ledger.entries as Array<Record<string, unknown>>
    const gateways = ledger.controlGateways as Array<Record<string, unknown>>
    expect(entries.length).toBeGreaterThan(30)
    expect(ledger.unknown).toEqual([])
    expect(ledger.unknownControlGateways).toEqual([])
    expect([...new Set(entries.map((entry) => entry.authorityKind))].sort()).toEqual([
      'control-revision',
      'recovery-proof',
      'terminal-maintenance',
      'worker-epoch',
    ])
    expect([...new Set(gateways.map((entry) => entry.subtype))].sort()).toEqual([
      'continuation-admission',
      'daemon-shutdown',
      'gate-control',
      'membership-control',
      'recovery-candidate-revoke',
      'terminal-control',
    ])

    const unclassified = cloneArtifacts(generated)
    const unclassifiedLedger = unclassified.mutationEntrypoints
      .taskExecutionAuthorityLedger as Record<string, unknown>
    const unclassifiedEntry = (unclassifiedLedger.entries as Array<Record<string, unknown>>)[0]!
    delete unclassifiedEntry.requiredBrandedProof
    expect(validateCanonicalArtifacts(unclassified)).toContain(
      `task-execution authority '${String(unclassifiedEntry.id)}' lacks requiredBrandedProof`,
    )

    const missingSubtype = cloneArtifacts(generated)
    const missingSubtypeLedger = missingSubtype.mutationEntrypoints
      .taskExecutionAuthorityLedger as Record<string, unknown>
    const missingGateways = missingSubtypeLedger.controlGateways as Array<Record<string, unknown>>
    missingGateways.splice(
      missingGateways.findIndex((entry) => entry.subtype === 'daemon-shutdown'),
      1,
    )
    expect(validateCanonicalArtifacts(missingSubtype)).toContain(
      'task-execution control subtype is empty: daemon-shutdown',
    )
  })

  test('RFC-317 subset ledgers project into canonical owner/import/facade truth', () => {
    const current = {
      commonsManifest: readJson('architecture/commons-manifest.json'),
      commonsDebt: readJson('architecture/commons-debt.json'),
      guardManifest: readJson('architecture/guard-manifest.json'),
      ledgerBaselines: readJson('architecture/ledger-baselines.json'),
    }
    const projected = projectGovernanceArtifacts(generated, current)
    for (const key of Object.keys(current) as Array<keyof typeof current>) {
      expect(artifactPayload(current[key])).toEqual(artifactPayload(projected[key]))
    }
    expect(
      (current.commonsManifest.kernels as Array<Record<string, unknown>>).every(
        (entry) =>
          Array.isArray(entry.canonicalOwnerEntryIds) && entry.canonicalOwnerEntryIds.length > 0,
      ),
    ).toBe(true)
    expect(
      (current.commonsDebt.entries as Array<Record<string, unknown>>).every(
        (entry) =>
          Array.isArray(entry.canonicalImportEdgeIds) && entry.canonicalImportEdgeIds.length > 0,
      ),
    ).toBe(true)
  })

  test('RFC-317 projection retires settled boundary debt without minting new exceptions', () => {
    const current = {
      commonsManifest: readJson('architecture/commons-manifest.json'),
      commonsDebt: readJson('architecture/commons-debt.json'),
      guardManifest: readJson('architecture/guard-manifest.json'),
      ledgerBaselines: readJson('architecture/ledger-baselines.json'),
    }
    const seeded = structuredClone(current)
    const seedEntries = seeded.commonsDebt.entries as Array<Record<string, unknown>>
    const exemplar = seedEntries.find((entry) => entry.rule === 'R1-inbound-module-internals')!
    seedEntries.push({
      ...exemplar,
      from: 'packages/backend/src/services/__retired_boundary_fixture__.ts',
      to: 'packages/backend/src/modules/identity-access/application/__retired_fixture__',
      specifier: '@/modules/identity-access/application/__retired_fixture__',
      canonicalImportEdgeIds: ['import:retired-fixture'],
      canonicalFromOwnerEntryId: 'owner:retired-fixture',
      canonicalToOwnerEntryIds: ['owner:retired-fixture'],
      canonicalFacadeIds: [],
    })
    const seededBaseline = seeded.commonsDebt.baseline as Record<string, unknown>
    seededBaseline.inboundEdges = Number(seededBaseline.inboundEdges) + 1

    const projected = projectGovernanceArtifacts(generated, seeded)
    const entries = projected.commonsDebt.entries as Array<Record<string, unknown>>
    const baseline = projected.commonsDebt.baseline as Record<string, unknown>
    const seedIdentities = new Set(
      seedEntries.map(
        (entry) =>
          `${String(entry.rule)}|${String(entry.from)}|${String(entry.specifier)}|${String(entry.edgeKind)}|${String(entry.syntax)}`,
      ),
    )

    expect(
      entries.some(
        (entry) => entry.from === 'packages/backend/src/services/__retired_boundary_fixture__.ts',
      ),
    ).toBe(false)
    expect(
      entries.every((entry) =>
        seedIdentities.has(
          `${String(entry.rule)}|${String(entry.from)}|${String(entry.specifier)}|${String(entry.edgeKind)}|${String(entry.syntax)}`,
        ),
      ),
    ).toBe(true)
    expect(baseline.inboundEdges).toBe(
      entries.filter((entry) => entry.rule === 'R1-inbound-module-internals').length,
    )
    expect(baseline.outboundEdges).toBe(
      entries.filter((entry) => entry.rule === 'R2-outbound-module-to-legacy').length,
    )
  })

  test('the public-error mapper never copies private messages, causes or unknown detail keys', () => {
    const privateError = Object.assign(new Error('/secret/path: SELECT token FROM credentials'), {
      code: 'forbidden',
      details: { token: 'secret-token' },
      cause: new Error('private cause'),
      debugSql: 'SELECT * FROM credentials',
    })
    const forbidden = toPublicError(privateError, 'corr-1')
    expect(forbidden).toEqual({
      code: 'forbidden',
      category: 'forbidden',
      message: 'Access is forbidden.',
      correlationId: 'corr-1',
    })
    expect(JSON.stringify(forbidden)).not.toMatch(/secret|SELECT|cause|debugSql/)

    const stale = toPublicError(
      {
        code: 'resource-operation-stale',
        message: 'private target',
        details: { expectedRevision: 4, actualRevision: 5 },
      },
      'corr-2',
    )
    expect(stale.details).toEqual({ expectedRevision: 4, actualRevision: 5 })
    expect(
      toPublicError(
        {
          code: 'resource-operation-stale',
          details: { expectedRevision: 4, actualRevision: 5, token: 'must-reject' },
        },
        'corr-3',
      ),
    ).not.toHaveProperty('details')
    expect(toPublicError({ code: 'unknown', message: '/private' }, 'corr-4')).toEqual({
      code: 'internal-error',
      category: 'internal',
      message: 'An internal error occurred.',
      correlationId: 'corr-4',
    })
  })

  test('managed background definitions expose frozen start/run/stop/health lifecycle contracts', () => {
    const lifecycle = {
      id: 'fixture',
      owner: 'fixture-owner',
      phase: 'after-ready' as const,
      dependencies: ['db'],
      readiness: () => 'ready' as const,
      state: () => ({ running: true }),
      start: () => undefined,
      stop: () => undefined,
      health: () => ({ status: 'healthy' as const, checkedAt: '2026-08-26T00:00:00Z' }),
      run: async () => undefined,
    }
    const job = defineBackgroundJob({ ...lifecycle, kind: 'periodic', cadenceMs: 1_000 })
    const worker = defineManagedWorker({ ...lifecycle, kind: 'long-running' })
    expect(Object.isFrozen(job)).toBe(true)
    expect(Object.isFrozen(job.dependencies)).toBe(true)
    expect(Object.isFrozen(worker)).toBe(true)
  })

  test('the two transport-to-db debts no longer point at completed RFC-317 work', () => {
    const transportDebt = KNOWN_VIOLATIONS.filter((entry) => entry.rule === 'no-transport-to-db')
    expect(transportDebt).toHaveLength(2)
    expect(
      transportDebt.map(({ from, owner, removeWave }) => ({ from, owner, removeWave })),
    ).toEqual([
      {
        from: 'packages/backend/src/ws/registry.ts',
        owner: 'identity-access + owning visibility contexts',
        removeWave: 'W4',
      },
      {
        from: 'packages/backend/src/ws/server.ts',
        owner: 'identity-access + bootstrap',
        removeWave: 'W9',
      },
    ])
    expect(transportDebt.every((entry) => !entry.removeWhen.includes('RFC-317 B10'))).toBe(true)
  })

  test('mutation: deleting an owner, staling a digest or collapsing an edge role fails closed', () => {
    const missingOwner = cloneArtifacts(generated)
    ;(missingOwner.moduleSymbolOwners.entries as unknown[]).shift()
    expect(validateCanonicalArtifacts(missingOwner).some((error) => error.includes('owner'))).toBe(
      true,
    )

    const staleDigest = cloneArtifacts(generated)
    staleDigest.publicSurfaces.sourceDigest = 'sha256:stale'
    expect(validateCanonicalArtifacts(staleDigest)).toContain('sourceDigest mismatch')

    const collapsedEdge = cloneArtifacts(generated)
    ;(collapsedEdge.crossContextImports.targetEdges as unknown[]).splice(0, 1)
    expect(
      validateCanonicalArtifacts(collapsedEdge).some((error) => error.includes('target edge')),
    ).toBe(true)
  })

  test('mutation: a dangling public consumer edge and a required-port without an owner fail closed', () => {
    const danglingConsumer = cloneArtifacts(generated)
    const surface = (danglingConsumer.publicSurfaces.entries as Array<Record<string, unknown>>)[0]!
    surface.consumerEdgeIds = ['import:does-not-exist']
    expect(
      validateCanonicalArtifacts(danglingConsumer).some((error) =>
        error.includes('missing public consumer edge'),
      ),
    ).toBe(true)

    const danglingTypeConsumer = cloneArtifacts(generated)
    const nested = (
      danglingTypeConsumer.publicSurfaces.entries as Array<Record<string, unknown>>
    ).find(
      (entry) =>
        Array.isArray(entry.publicTypeConsumerIds) && entry.publicTypeConsumerIds.length > 0,
    )!
    nested.publicTypeConsumerIds = ['public:does-not-exist:types:Missing']
    expect(validateCanonicalArtifacts(danglingTypeConsumer)).toContain(
      `missing public type consumer: ${String(nested.id)}`,
    )

    const danglingPort = cloneArtifacts(generated)
    const port = (
      danglingPort.crossContextImports.requiredPorts as Array<Record<string, unknown>>
    )[0]!
    port.ownerEntryId = 'owner:does-not-exist'
    expect(
      validateCanonicalArtifacts(danglingPort).some((error) =>
        error.includes('missing required-port owner'),
      ),
    ).toBe(true)
  })

  test('mutation: incomplete exact exceptions and unreviewed node_runs writers fail closed', () => {
    const staleException = cloneArtifacts(generated)
    const exception = (
      staleException.crossContextImports.architectureExceptions as Array<Record<string, unknown>>
    )[0]!
    exception.removeAfterWave = ''
    expect(
      validateCanonicalArtifacts(staleException).some((error) =>
        error.includes('incomplete architecture exception'),
      ),
    ).toBe(true)

    const newWriter = cloneArtifacts(generated)
    const site = (
      newWriter.mutationEntrypoints.nodeRunInsertSites as Array<Record<string, unknown>>
    )[0]!
    site.status = 'unreviewed'
    expect(validateCanonicalArtifacts(newWriter)).toContain('unreviewed node_runs INSERT site')
  })

  test('negative fixture: a fabricated empty corpus cannot satisfy canonical validation', () => {
    const fabricated = {
      fixtureSource: 'export const fabricatedArchitectureCorpus = {}',
      mutationEntrypoints: { sourceDigest: 'x', entries: [], nodeRunInsertSites: [] },
      transactionExternalEffects: { sourceDigest: 'x', entries: [] },
      backgroundJobs: { sourceDigest: 'x', entries: [], ambientWiringEntries: [] },
      crossContextImports: {
        sourceDigest: 'x',
        observedEdges: [],
        targetEdges: [],
        requiredPorts: [],
        architectureExceptions: [],
        implementationSccs: [],
      },
      facades: { sourceDigest: 'x', entries: [] },
      publicSurfaces: { sourceDigest: 'x', targetContexts: [], entries: [] },
      moduleSymbolOwners: {
        sourceDigest: 'x',
        denominator: { productionFiles: 1 },
        entries: [],
      },
      report: { sourceDigest: 'x' },
    } as unknown as CanonicalArtifacts
    expect(validateCanonicalArtifacts(fabricated).length).toBeGreaterThan(0)
  })
})

describe('RFC-294 N1a content-addressed current artifact provenance', () => {
  // RFC-294 review 2026-08-30 §A3：不再要求 `git show <currentSnapshotSha>:<path>` 与当前
  // 文件 byte-equal。那条断言只证明「pin 指向的提交里有一份一样的文件」，而四份治理账本各自
  // 已被更强的判据钉在源码上（commons R1/R2 exact equality、guard-manifest 两向钉死、
  // ledger-baselines「与源码逐字相等」+ T17），它带来的只是每次刷新都要多一笔 repin 提交
  // （自 2026-08-13 起 142/1313 个 commit 是 `chore(architecture)` refresh/pin）。现在
  // `currentSnapshotSha` 的语义是「生成器运行时所对照的已提交祖先」：仍必须是 40 位 SHA、
  // 仍必须在 HEAD 历史上可达，contentDigest 仍必须与当前 payload 相等。
  for (const path of PROVENANCE_ARTIFACTS) {
    test(`${path} carries content-addressed provenance reachable from HEAD`, () => {
      const current = readJson(path)
      const provenance = current.provenance as Record<string, unknown>
      const originSha = String(provenance.originSha)
      const currentSnapshotSha = String(provenance.currentSnapshotSha)
      expect(originSha).toMatch(/^[0-9a-f]{40}$/)
      expect(currentSnapshotSha).toMatch(/^[0-9a-f]{40}$/)
      expect(provenance.digestAlgorithm).toBe('sha256')
      expect(provenance.digestScope).toBe('canonical-json-without-provenance')
      expect(provenance.contentDigest).toBe(artifactContentDigest(current))
      expect(git('merge-base', '--is-ancestor', originSha, 'HEAD').ok).toBe(true)
      expect(git('merge-base', '--is-ancestor', currentSnapshotSha, 'HEAD').ok).toBe(true)
    })
  }

  test('mutation: payload tampering changes the digest even when provenance metadata is untouched', () => {
    const current = readJson(PROVENANCE_ARTIFACTS[0])
    const tampered = structuredClone(current)
    tampered.note = `${String(tampered.note)} tampered`
    expect(artifactContentDigest(tampered)).not.toBe(
      (current.provenance as Record<string, unknown>).contentDigest,
    )
  })
})
