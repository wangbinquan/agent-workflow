import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import type { EpochSwitchApplication } from '../../public/commands'
import type { EpochSwitchArtifactReference } from '@/platform/persistence/migration/run/types'
import { EpochSwitchError } from '../../domain/epochSwitch/model'
import { environmentProfile } from '../../domain/epochSwitch/supportMatrix'
import { discoverEpochOperation, planEpochOperation, planView } from './planner'
import { withEpochOperation, readEpochPlan, type EpochSwitchDependencies } from './session'

export async function restoreEpochBackup(
  deps: EpochSwitchDependencies,
  input: Parameters<EpochSwitchApplication['restoreBackup']>[0],
) {
  if (!deps.unpackBackup) throw new EpochSwitchError('v3-backup-unpacker-required')
  const operationId = deps.newOperationId?.() ?? `dbm_e2_${crypto.randomUUID().replaceAll('-', '')}`
  const prior = await deps.journal.read(operationId)
  if (prior) {
    const p = prior.payload
    if (
      p.kind !== 'old-epoch-restore' ||
      p.source.location.kind !== 'backup' ||
      p.source.location.artifact !== input.artifact ||
      p.inputs.restoreConfig !== (input.restoreConfig ?? false) ||
      p.inputs.contentRoot?.runContentRoot !== input.contentRoot ||
      (input.target && p.target.provider !== input.target.provider) ||
      (input.target?.urlEnv &&
        (p.target.location?.kind !== 'postgresql-target' ||
          p.target.location.profileRef !== environmentProfile(input.target.urlEnv))) ||
      (input.scratchUrlEnv &&
        p.inputs.scratchProfileRef !== environmentProfile(input.scratchUrlEnv))
    )
      throw new EpochSwitchError('v3-restore-input-conflict')
    return withEpochOperation(deps, operationId, async (s) =>
      s.journal.payload.plan
        ? planView(s.journal, await readEpochPlan(s), deps.journal.operationRoot(operationId))
        : planEpochOperation(s, input),
    )
  }
  const root = deps.journal.operationRoot(operationId)
  const stored = await deps.journal.readArtifact(operationId, 'inputs/backup.json')
  const port = deps.journal.artifacts?.(operationId)
  let references: readonly EpochSwitchArtifactReference[] = []
  let materializedRoot: string | undefined
  let unpacked: Awaited<ReturnType<NonNullable<EpochSwitchDependencies['unpackBackup']>>>
  if (stored) {
    const previous = JSON.parse(Buffer.from(stored).toString('utf8')) as typeof unpacked & {
      artifact: string
      artifacts: readonly EpochSwitchArtifactReference[]
    }
    if (previous.artifact !== input.artifact)
      throw new EpochSwitchError('v3-restore-input-conflict')
    references = previous.artifacts
    if (references.length && !port) throw new EpochSwitchError('v3-artifact-capability-required')
    for (const ref of references) await port!.get(ref.name, ref.digest)
    unpacked = previous
    if (port && deps.materializeBackup)
      materializedRoot = (await deps.materializeBackup(previous.digest, port)).root
  } else {
    unpacked = await deps.unpackBackup(
      input.artifact,
      epochArtifactPath(root, 'inputs/backup'),
      port
        ? {
            get: (name, digest) => port.get(name, digest),
            async put(name, bytes) {
              const digest = await port.put(name, bytes)
              references = [...references.filter((ref) => ref.name !== name), { name, digest }]
              return digest
            },
          }
        : undefined,
    )
    await deps.journal.writeOnce(
      operationId,
      'inputs/backup.json',
      Buffer.from(JSON.stringify({ ...unpacked, artifact: input.artifact, artifacts: references })),
    )
  }
  await discoverEpochOperation(deps, input, {
    operationId,
    artifacts: references,
    materializedRoot,
    location: {
      kind: 'backup',
      sourceKind: unpacked.sourceKind,
      artifact: input.artifact,
      root: unpacked.root,
    },
    restoreConfig: input.restoreConfig ?? false,
    contentRoot: {
      kind: 'backup',
      root: unpacked.root,
      ...(input.contentRoot ? { runContentRoot: input.contentRoot } : {}),
      runsSupplied: input.contentRoot !== undefined || unpacked.runsSupplied === true,
      objects: deps.defaultContentRoot.objects,
    },
  })
  return withEpochOperation(deps, operationId, (s) =>
    planEpochOperation(s, { target: input.target, scratchUrlEnv: input.scratchUrlEnv }),
  )
}
