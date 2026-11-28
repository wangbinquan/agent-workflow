// RFC-626 §4.2: the port fixture of the V3 switch tests, assembled the way the automatic
// upgrade assembles the real ports — `direct`, a conversion that can be prepared, the keep
// policies for the finalize step — with a counter on every port, so the orchestration tests
// can say how often each step of an upgrade happened and with what it was called.
//
// The shared fixture (`rfc395V3SwitchFixture.ts`) is not changed. It is wrapped here:
//  - its content port returns a manifest without writing the listing the plan names; the real
//    adapter writes it, so the wrapper does (a test can turn that off);
//  - its target is one in-memory generation; the wrapper gives it an identity, so that a new
//    run gets a new, empty target and a generation built for another target contract cannot
//    be opened — which is what the real target port does;
//  - its conversion has no `prepare`; the wrapper adds one whose plan names the ended tasks;
//  - its source has no tables; the wrapper can add a `tasks` table that is read through the
//    raw channel, the way the automatic task count reads it.
//
// A process that is killed is simulated by an error of the category the operation wrapper
// does not record as a failure (`killed`): the journal is left exactly as the last write left
// it, and the session ends. Calling `start` again is the next start of the process.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  createBootUpgradeFacts,
  type BootUpgradeFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { ConversionPlanSection } from '@/platform/persistence/migration/conversion/plan'
import type {
  ConversionResolutions,
  ConversionSummary,
} from '@/platform/persistence/migration/conversion/sink'
import type { TaskSettlement } from '@/platform/persistence/migration/conversion/types'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import type { MigrationProgress } from '@/platform/persistence/migration/run/progress'
import type {
  ConversionRunRequest,
  FinalizeDisposition,
  FreezeContentManifest,
  FrozenSourceHandle,
} from '@/platform/persistence/migration/run/types'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import {
  autoUpgrade,
  type AutoUpgradeDependencies,
} from '@/modules/system-operations/application/epochSwitch/autoUpgrade'
import {
  planPinName,
  type EpochSwitchDependencies,
} from '@/modules/system-operations/application/epochSwitch/session'
import type {
  AutoUpgradeRecordPort,
  EpochSourcePort,
  TargetGenerationHandle,
} from '@/modules/system-operations/application/ports/epochSwitch'
import type { AutoUpgradeRecordKind } from '@/modules/system-operations/domain/epochSwitch/autoUpgrade'
import {
  parseMigrationPlanDocument,
  type MigrationPlanDocument,
} from '@/modules/system-operations/domain/epochSwitch/documents'
import {
  EpochSwitchError,
  type EpochSwitchFaultPoint,
} from '@/modules/system-operations/domain/epochSwitch/model'
import { parsePlanPin, type PlanPin } from '@/modules/system-operations/domain/epochSwitch/planPin'
import { createAutoUpgradeRecords } from '@/modules/system-operations/infrastructure/epochSwitch/autoUpgradeRecords'
import { fixtureDigest, fixturePlan, makeSwitchFixture } from './rfc395V3SwitchFixture'

/** The process died here: the operation wrapper records no failure for this category. */
export const killed = () =>
  new EpochSwitchError('test-process-killed', { category: 'owner-conflict' })

/** The fixture's plan as the engine builds it for the request's resolution. */
export function directFixturePlan(
  request: ConversionRunRequest,
  settlements: readonly TaskSettlement[],
  material: { readonly targetContractDigest?: string; readonly ruleSetDigest?: string } = {},
): ConversionPlanSection {
  const { digest: _digest, ...plain } = fixturePlan(request)
  const base = {
    ...plain,
    ...(material.targetContractDigest
      ? { targetContractDigest: material.targetContractDigest }
      : {}),
    ...(material.ruleSetDigest ? { ruleSetDigest: material.ruleSetDigest } : {}),
  }
  const payload =
    request.resolution === 'automatic'
      ? {
          ...base,
          resolution: 'automatic' as const,
          settlements: [...settlements].sort((a, b) =>
            a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0,
          ),
        }
      : base
  return { ...payload, digest: valueDigest(payload) }
}

export function noResolutions(settledTasks: readonly TaskSettlement[]): ConversionResolutions {
  return {
    settledTasks,
    setAside: { total: 0, rows: [] },
    missingContent: { total: 0, rows: [] },
    kept: { total: 0, byCode: {}, rows: [] },
    acknowledged: { total: 0, byCode: {} },
  }
}

export interface FixtureTask {
  readonly id: string
  readonly name: string | null
  readonly status: string
}

export function directSwitchFixture(options: { readonly direct?: boolean } = {}) {
  const f = makeSwitchFixture()
  const base = f.deps
  const calls = {
    discover: 0,
    freeze: 0,
    capture: 0,
    reclaim: 0,
    inventoryOpen: 0,
    verifyContent: 0,
    backupCreate: 0,
    backupMatches: 0,
    bootCapture: 0,
    dryRun: 0,
    stagedConversion: 0,
    prepare: 0,
    prepareClosed: 0,
    convert: 0,
    targetCreate: 0,
    targetOpen: 0,
    retire: 0,
    finalize: 0,
    validate: 0,
    plan: 0,
    run: 0,
    status: 0,
  }
  const seen = {
    freeze: [] as Parameters<EpochSourcePort['freeze']>[0][],
    contentOpen: [] as (string | undefined)[],
    backup: [] as (string | undefined)[],
    /** Every manifest the content port returned from `capture`, and each one a backup was given. */
    captured: [] as FreezeContentManifest[],
    /** How far the run was each time it asked for a collection. */
    reclaimAfter: [] as { capture: number; backup: number; convert: number; validated: number }[],
    backupManifests: [] as (FreezeContentManifest | null | undefined)[],
    boot: [] as { stage: string; resolution: string | undefined }[],
    requests: [] as ConversionRunRequest[],
    openRun: [] as Parameters<TargetGenerationHandle['openRun']>[],
    finalize: [] as Parameters<TargetGenerationHandle['finalize']>[0][],
    validate: [] as Parameters<TargetGenerationHandle['validate']>[0][],
    created: [] as string[],
    opened: [] as { generationId: string; admitted: boolean }[],
    retire: [] as string[],
    /** Each `run` call with what the journal said when it was made. */
    runs: [] as {
      approve: string | undefined
      newRun: boolean
      phase: string | null
      ordinal: number | null
      failure: string | null
    }[],
  }
  /** What the conversion, the target and the machine of this installation produce. */
  const scenario = {
    settlements: [] as TaskSettlement[],
    resolutions: null as ConversionResolutions | null,
    dispositions: [] as FinalizeDisposition[],
    bootFacts: [] as BootUpgradeFact[],
    /** The old database's `tasks` table; null leaves the source without one. */
    tasks: null as FixtureTask[] | null,
    /** Another rule set than the fixture's: what a changed converter derives for the source. */
    ruleSetDigest: null as string | null,
    /** False: the listing the plan names is not on the disk when it is read back. */
    writeListing: true,
    /**
     * True: the content port hands its last listing over once (`takeCaptured`), as the
     * assembly of the automatic upgrade has it. False: the port has no such method.
     */
    handOver: false,
    /** Another digest than the fixture's: the content changed since it was last listed. */
    manifestDigest: null as string | null,
    /** Reported by the rehearsal of the manual flow. */
    stagingPeakBytes: null as number | null,
    atCheckpoint: undefined as ((point: string) => void | Promise<void>) | undefined,
    beforeAppend: undefined as
      | ((kind: AutoUpgradeRecordKind, data: Readonly<Record<string, unknown>>) => void)
      | undefined,
    afterAppend: undefined as
      | ((kind: AutoUpgradeRecordKind, data: Readonly<Record<string, unknown>>) => void)
      | undefined,
    beforeRun: undefined as ((input: { newRun?: boolean }) => void) | undefined,
    afterRetire: undefined as (() => void) | undefined,
  }
  const events: MigrationProgress[] = []
  const checkpoints: string[] = []
  const logs: { line: string; warning: boolean }[] = []
  /** Which binary built the generation that is installed: what `open` compares. */
  let installed: { generationId: string; contract: string; plan: string } | null = null
  /** The listing the content port wrote last, until the execution step takes it. */
  let lastListing: { destination: string; manifest: FreezeContentManifest } | null = null

  const stored = createAutoUpgradeRecords(f.root)
  const records: AutoUpgradeRecordPort = {
    list: () => stored.list(),
    async append(operationId, kind, data) {
      scenario.beforeAppend?.(kind, data)
      const record = await stored.append(operationId, kind, data)
      scenario.afterAppend?.(kind, data)
      return record
    },
    receipt: (operationId, value) => stored.receipt(operationId, value),
    acceptance: (operationId, runId) => stored.acceptance(operationId, runId),
  }

  const text = (value: string) => ({ type: 'text' as const, value })
  /** The frozen source with the scenario's tasks, readable only through the raw channel. */
  const withTasks = (handle: FrozenSourceHandle): FrozenSourceHandle => {
    const tasks = scenario.tasks
    if (!tasks) return handle
    const preflight: FrozenSourceHandle['preflight'] = {
      ...handle.preflight,
      tables: [
        ...handle.preflight.tables,
        {
          table: 'tasks',
          rows: tasks.length,
          physicalTable: 'tasks',
          destination: { kind: 'business', tables: ['tasks'] },
          disposition: 'converted',
          reason: 'fixture',
        },
      ],
    }
    return {
      ...handle,
      preflight,
      reader: {
        ...handle.reader,
        preflight: async () => preflight,
        async readRawChunk(table, afterKey) {
          if (table !== 'tasks') return handle.reader.readRawChunk(table, afterKey, 1000)
          const rows =
            afterKey === null
              ? tasks.map((task) => ({
                  key: [text(task.id)],
                  cells: {
                    id: { storageClass: 'text', value: text(task.id) },
                    name:
                      task.name === null
                        ? { storageClass: 'null', value: { type: 'null' as const } }
                        : { storageClass: 'text', value: text(task.name) },
                    status: { storageClass: 'text', value: text(task.status) },
                  },
                }))
              : []
          return {
            version: 1,
            sourceVersion: preflight.sourceVersion,
            table,
            migrationKey: ['id'],
            afterKey,
            firstKey: rows[0]?.key ?? null,
            lastKey: rows.at(-1)?.key ?? null,
            rows,
            sourceDigest: fixtureDigest,
          }
        },
      },
    }
  }

  const handle = f.target
  const finalize = handle.finalize.bind(handle)
  handle.finalize = async (input) => {
    calls.finalize++
    seen.finalize.push(input)
    const report = await finalize(input)
    return input.dangling ? { ...report, dispositions: scenario.dispositions } : report
  }
  const validate = handle.validate.bind(handle)
  handle.validate = async (input) => {
    calls.validate++
    seen.validate.push(input)
    return validate(input)
  }
  const openRun = handle.openRun.bind(handle)
  handle.openRun = (row, runOptions) => {
    seen.openRun.push([row, runOptions])
    return openRun(row, runOptions)
  }

  const plan = (request: ConversionRunRequest, settlements: readonly TaskSettlement[]) =>
    directFixturePlan(request, settlements, {
      targetContractDigest: deps.targetContractDigest,
      ...(scenario.ruleSetDigest ? { ruleSetDigest: scenario.ruleSetDigest } : {}),
    })

  const deps: EpochSwitchDependencies = {
    ...base,
    ...(options.direct === false ? {} : { direct: true }),
    // What the assembly of the automatic upgrade installs; here it counts, and says where.
    reclaim() {
      calls.reclaim++
      seen.reclaimAfter.push({
        capture: calls.capture,
        backup: calls.backupCreate,
        convert: calls.convert,
        validated: calls.validate,
      })
    },
    autoUpgradeRecords: records,
    progress: (event) => events.push(event),
    async autoUpgradeCheckpoint(point) {
      checkpoints.push(point)
      await scenario.atCheckpoint?.(point)
    },
    source: {
      async discover(input) {
        calls.discover++
        return withTasks(await base.source.discover(input))
      },
      async freeze(input) {
        calls.freeze++
        seen.freeze.push(input)
        const frozen = withTasks(await base.source.freeze(input))
        // What the real access reports when it freezes; a silent re-open passes no callback.
        input.progress?.({ phase: 'freeze', detail: 'source frozen', boundary: true })
        return frozen
      },
    },
    content: {
      async capture(input) {
        calls.capture++
        const captured = await base.content.capture(input)
        const manifest = scenario.manifestDigest
          ? { ...captured, digest: scenario.manifestDigest }
          : captured
        if (scenario.writeListing) {
          mkdirSync(dirname(input.destination), { recursive: true })
          writeFileSync(input.destination, canonicalSchemaJson(manifest))
        }
        input.progress?.({ phase: 'content-capture', detail: 'inventory', boundary: true })
        seen.captured.push(manifest)
        lastListing = { destination: input.destination, manifest }
        return manifest
      },
      takeCaptured(destination) {
        if (!scenario.handOver || lastListing?.destination !== destination) return null
        const { manifest } = lastListing
        lastListing = null
        return manifest
      },
      async open(input) {
        calls.inventoryOpen++
        seen.contentOpen.push(input.resolution)
        const inventory = await base.content.open(input)
        return {
          ...inventory,
          async verifyUnchanged(receipts) {
            calls.verifyContent++
            return inventory.verifyUnchanged(receipts)
          },
        }
      },
    },
    backup: {
      async create(input) {
        calls.backupCreate++
        seen.backup.push(input.resolution)
        seen.backupManifests.push(input.contentManifest)
        return base.backup.create(input)
      },
      async matches(receipt, watermark) {
        calls.backupMatches++
        return base.backup.matches(receipt, watermark)
      },
    },
    target: {
      preflight: (input) => base.target.preflight(input),
      discard: (input) => base.target.discard(input),
      async create(input) {
        calls.targetCreate++
        seen.created.push(input.generationId)
        if (installed && installed.generationId !== input.generationId)
          // A new generation is a new database: the in-memory target starts over.
          Object.assign(f.control, {
            run: null,
            rows: 0,
            state: 'prepared',
            approvals: [],
            receiptBytes: null,
            activationDigest: null,
            firstWrite: null,
          })
        installed = {
          generationId: input.generationId,
          contract: deps.targetContractDigest,
          plan: deps.targetPlanDigest(input.provider),
        }
        return base.target.create(input)
      },
      async open(input) {
        calls.targetOpen++
        // As the real port: a generation is opened only under the contract that built it.
        const admitted =
          installed !== null &&
          installed.generationId === input.generationId &&
          installed.contract === deps.targetContractDigest &&
          installed.plan === deps.targetPlanDigest(input.provider)
        seen.opened.push({ generationId: input.generationId, admitted })
        if (!admitted) throw new Error('v3-target-generation-mismatch')
        return base.target.open(input)
      },
      async retire(input) {
        calls.retire++
        seen.retire.push(input.generationId)
        // By the stored identity alone: neither the contract nor the structure is compared.
        const outcome =
          installed === null || installed.generationId !== input.generationId
            ? ('absent' as const)
            : await base.target.retire(input)
        scenario.afterRetire?.()
        return outcome
      },
    },
    conversionPlan: (request) => plan(request, []),
    conversion: {
      bootUpgradeEnvironment: {
        async capture(input) {
          calls.bootCapture++
          seen.boot.push({ stage: input.stage, resolution: input.resolution })
          return createBootUpgradeFacts(scenario.bootFacts)
        },
      },
      async dryRun(request) {
        calls.dryRun++
        const result = await base.conversion.dryRun(request)
        return scenario.stagingPeakBytes === null
          ? result
          : { ...result, stagingPeakBytes: scenario.stagingPeakBytes }
      },
      async run(request, sink) {
        calls.stagedConversion++
        return base.conversion.run(request, sink)
      },
      references: [
        { table: 'tasks', foreignKey: 'tasks_owner_user_id_fk', action: { kind: 'detach' } },
      ],
      async prepare(request) {
        calls.prepare++
        seen.requests.push(request)
        const prepared = plan(request, scenario.settlements)
        return {
          plan: prepared,
          async run(sink) {
            calls.convert++
            await sink.open({
              planDigest: prepared.digest,
              sourceWatermark: request.source.watermark,
              sourceVersion: request.source.preflight.sourceVersion,
              sourceGenerationId: request.source.preflight.sourceGenerationId,
              targetGeneration: request.targetGeneration,
              converterVersion: prepared.converterVersion,
              ruleSetDigest: prepared.ruleSetDigest,
              preUpgradeWatermark: null,
              stagingDigest: fixtureDigest,
              lookupDigest: fixtureDigest,
            })
            if (f.control.rows === 0) {
              base.faults?.('after-rows')
              base.faults?.('after-receipts')
              f.control.rows = 1
              base.faults?.('before-ack')
            }
            const summary: ConversionSummary = {
              status: f.control.actualBlocks.length ? 'blocked' : 'converted',
              tableReceipts: [],
              blocks: f.control.actualBlocks,
              records: [],
              historyOnly: f.control.actualRestrictions,
              stagingDigest: fixtureDigest,
              plan: prepared,
              ...(request.resolution === 'automatic'
                ? {
                    resolutions: scenario.resolutions ?? noResolutions(prepared.settlements ?? []),
                  }
                : {}),
            }
            await sink.finish(summary)
            return summary
          },
          close() {
            calls.prepareClosed++
          },
        }
      },
    },
  }
  const application = createEpochSwitchApplication(deps)
  const app: typeof application = {
    ...application,
    async plan(input) {
      calls.plan++
      return application.plan(input)
    },
    async run(input) {
      calls.run++
      const journal = await deps.journal.read(input.operationId)
      seen.runs.push({
        approve: input.approve,
        newRun: input.newRun === true,
        phase: journal?.payload.phase ?? null,
        ordinal: journal?.payload.run?.ordinal ?? null,
        failure: journal?.payload.failure?.detailCode ?? null,
      })
      scenario.beforeRun?.(input)
      return application.run(input)
    },
    async status(input) {
      calls.status++
      return application.status(input)
    },
  }
  const lock = {
    acquired: 0,
    released: 0,
    bound: [] as string[],
    async acquire() {
      lock.acquired++
    },
    async bind(id: string) {
      lock.bound.push(id)
    },
    async assertHeld() {},
    async release() {
      lock.released++
    },
  }
  const journal = async () => (await deps.journal.read(f.operationId))!
  return {
    ...f,
    deps,
    app,
    records,
    calls,
    seen,
    scenario,
    events,
    checkpoints,
    logs,
    lock,
    journal,
    /** One start of the automatic session; another call is the next start of the process. */
    start(overrides: Partial<AutoUpgradeDependencies> = {}, input: { retry?: boolean } = {}) {
      return autoUpgrade(
        {
          epoch: deps,
          application: app,
          records,
          lock,
          legacy: {
            status: async () => {
              throw new Error('no legacy operation')
            },
            finalize: async () => {
              throw new Error('no legacy operation')
            },
          },
          enabled: true,
          standalone: true,
          log: (line, warning) => logs.push({ line, warning: warning === true }),
          ...overrides,
        },
        input,
      )
    },
    /** The process dies the next `times` times the point is reached. */
    killAt(
      point: { readonly fault: EpochSwitchFaultPoint } | { readonly checkpoint: string },
      times = 1,
    ) {
      let left = times
      const hit = (reached: string, wanted: string) => {
        if (reached !== wanted || left <= 0) return
        left--
        throw killed()
      }
      if ('fault' in point) f.control.inject = (reached) => hit(reached, point.fault)
      else scenario.atCheckpoint = (reached) => hit(reached, point.checkpoint)
    },
    /** No point kills any more: what a restarted process finds. */
    disarm() {
      f.control.inject = undefined
      scenario.atCheckpoint = undefined
      scenario.beforeAppend = undefined
      scenario.afterAppend = undefined
      scenario.beforeRun = undefined
      scenario.afterRetire = undefined
    },
    async artifact(name: string): Promise<Uint8Array | null> {
      return deps.journal.readArtifact(f.operationId, name)
    },
    /** Where the journal keeps the operation's artifact of that name. */
    artifactPath(name: string): string {
      return epochArtifactPath(deps.journal.operationRoot(f.operationId), name)
    },
    async pinBytes(): Promise<Uint8Array | null> {
      return deps.journal.readArtifact(f.operationId, planPinName(await journal()))
    },
    async pin(): Promise<PlanPin | null> {
      const bytes = await deps.journal.readArtifact(f.operationId, planPinName(await journal()))
      return bytes ? parsePlanPin(bytes) : null
    },
    /** The plan the journal names, or the one with the given digest. */
    async plan(digest?: string): Promise<MigrationPlanDocument> {
      const bytes = await deps.journal.readArtifact(
        f.operationId,
        `plans/${digest ?? (await journal()).payload.plan!.digest}.json`,
      )
      return parseMigrationPlanDocument(Buffer.from(bytes!).toString('utf8'))
    },
    async session() {
      return (await records.list()).find((entry) => entry.operationId === f.operationId)!
    },
    /** The kinds of the session's records, in the order they were written. */
    async recordKinds(): Promise<readonly string[]> {
      const session = (await records.list()).find((entry) => entry.operationId === f.operationId)
      return session?.records.map((record) => record.kind) ?? []
    },
    /** Boundary progress lines as `phase:detail`, in the order they were reported. */
    boundaries: () =>
      events.filter((event) => event.boundary).map((event) => `${event.phase}:${event.detail}`),
  }
}
export type DirectSwitchFixture = ReturnType<typeof directSwitchFixture>
