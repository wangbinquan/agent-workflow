import { dirname, join } from 'node:path'
import type { CandidateDeliveryPort } from '@/modules/development-automation/application/ports/reconcilerPorts'
import type { ActionWorkspaceEffects } from '@/modules/development-automation/application/ports/actionWorkspaceEffects'
import type {
  AutomationWorkspaceEffects,
  AutomationWorkspaceEffectsFactory,
} from '@/modules/development-automation/application/ports/automationWorkspaceEffects'
import { createFileActionWorkspaceEffects } from '@/modules/development-automation/infrastructure/local/fileActionWorkspaceEffects'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import { bindCandidateDeliveryParticipant } from '@/modules/source-control/composition'
import type { ConflictMergeWorkspaceEffects } from '@/modules/source-control/public/types'
import { createFileConflictMergeWorkspaceEffects } from '@/modules/source-control/infrastructure/local/fileConflictMergeWorkspaceEffects'
import type {
  EmployeeCaseWorkspaceEffects,
  EmployeeCaseWorkspaceEffectsFactory,
} from '@/modules/source-control/application/ports/employeeCaseWorkspaceEffects'
import { createFileEmployeeCaseWorkspaceEffectsFactory } from '@/modules/source-control/infrastructure/local/fileEmployeeCaseWorkspaceEffects'
import { GatedEvidenceArtifacts, type EvidenceEffect } from './rfc370EvidenceArtifacts'
import { createFileEvidenceDocumentCommands } from '@/modules/development-automation/infrastructure/local/fileEvidenceDocumentCommands'

export type WorkspaceEffectGate = (effect: string, reference?: string) => Promise<void>
const immediate: WorkspaceEffectGate = async () => {}

/** Only these fixture adapters decode references; production consumers see opaque strings. */
export class WorkspaceReferenceCodec {
  readonly #prefix = 'aw-fixture-workspace:'
  reference(path: string): string {
    return `${this.#prefix}${encodeURIComponent(path)}`
  }
  physical(reference: string): string {
    return reference.startsWith(this.#prefix)
      ? decodeURIComponent(reference.slice(this.#prefix.length))
      : reference
  }
}

class OpaqueContentScope implements AutomationWorkspaceEffects {
  constructor(
    readonly codec: WorkspaceReferenceCodec,
    readonly native: AutomationWorkspaceEffects,
    readonly gate: WorkspaceEffectGate,
    readonly calls: string[],
  ) {
    Object.freeze(this)
  }
  async #before(effect: string, reference?: string) {
    this.calls.push(effect)
    await this.gate(effect, reference)
  }
  async exists(reference: string) {
    await this.#before('exists', reference)
    return this.native.exists(this.codec.physical(reference))
  }
  async inspect(reference: string, followLinks: boolean) {
    await this.#before('inspect', reference)
    return this.native.inspect(this.codec.physical(reference), followLinks)
  }
  async listNames(reference: string) {
    await this.#before('listNames', reference)
    return this.native.listNames(this.codec.physical(reference))
  }
  async listEntries(reference: string) {
    await this.#before('listEntries', reference)
    return this.native.listEntries(this.codec.physical(reference))
  }
  async readBytes(reference: string) {
    await this.#before('readBytes', reference)
    return this.native.readBytes(this.codec.physical(reference))
  }
  async readText(reference: string) {
    await this.#before('readText', reference)
    return this.native.readText(this.codec.physical(reference))
  }
  async readLink(reference: string) {
    await this.#before('readLink', reference)
    return this.native.readLink(this.codec.physical(reference))
  }
  async createDirectory(reference: string, recursive: boolean) {
    await this.#before('createDirectory', reference)
    return this.native.createDirectory(this.codec.physical(reference), recursive)
  }
  async copyFile(source: string, target: string, exclusive: boolean) {
    await this.#before('copyFile', target)
    return this.native.copyFile(this.codec.physical(source), this.codec.physical(target), exclusive)
  }
  async setMode(reference: string, mode: number) {
    await this.#before('setMode', reference)
    return this.native.setMode(this.codec.physical(reference), mode)
  }
  async writeText(reference: string, text: string) {
    await this.#before('writeText', reference)
    return this.native.writeText(this.codec.physical(reference), text)
  }
  async close() {
    await this.#before('close')
    return this.native.close()
  }
}

export class OpaqueContentFactory implements AutomationWorkspaceEffectsFactory {
  readonly #native = createFileAutomationWorkspaceEffectsFactory()
  readonly calls: string[] = []
  constructor(
    readonly codec: WorkspaceReferenceCodec,
    readonly gate: WorkspaceEffectGate = immediate,
  ) {
    Object.freeze(this)
  }
  resolve(reference: string, ...segments: readonly string[]): string {
    return this.codec.reference(join(this.codec.physical(reference), ...segments))
  }
  parent(reference: string): string {
    return this.codec.reference(dirname(this.codec.physical(reference)))
  }
  async acquire() {
    this.calls.push('acquire')
    await this.gate('acquire')
    return new OpaqueContentScope(this.codec, await this.#native.acquire(), this.gate, this.calls)
  }
}

export class OpaqueConflictEffects implements ConflictMergeWorkspaceEffects {
  readonly #native = createFileConflictMergeWorkspaceEffects()
  readonly calls: string[] = []
  readonly allocations: string[] = []
  readonly discards: string[] = []
  constructor(
    readonly codec: WorkspaceReferenceCodec,
    readonly gate: WorkspaceEffectGate = immediate,
  ) {
    Object.freeze(this)
  }
  async #before(effect: string, reference?: string) {
    this.calls.push(effect)
    await this.gate(effect, reference)
  }
  async allocate(root?: string) {
    await this.#before('allocate', root)
    const path = await this.#native.allocate(
      root === undefined ? undefined : this.codec.physical(root),
    )
    const reference = this.codec.reference(path)
    this.allocations.push(reference)
    return reference
  }
  async cloneBaseline(workspace: string, baseline: string) {
    await this.#before('cloneBaseline', workspace)
    return this.#native.cloneBaseline(this.codec.physical(workspace), this.codec.physical(baseline))
  }
  async run(...[reference, args, options]: Parameters<ConflictMergeWorkspaceEffects['run']>) {
    await this.#before('run', reference)
    return this.#native.run(this.codec.physical(reference), args, options)
  }
  async installPlatformExclude(reference: string) {
    await this.#before('installPlatformExclude', reference)
    return this.#native.installPlatformExclude(this.codec.physical(reference))
  }
  async readConflictFile(reference: string, relativePath: string) {
    await this.#before('readConflictFile', reference)
    return this.#native.readConflictFile(this.codec.physical(reference), relativePath)
  }
  async mergeHeadExists(reference: string) {
    await this.#before('mergeHeadExists', reference)
    return this.#native.mergeHeadExists(this.codec.physical(reference))
  }
  async discard(reference: string) {
    this.discards.push(reference)
    await this.#before('discard', reference)
    return this.#native.discard(this.codec.physical(reference))
  }
}

export class OpaqueActionEffects implements ActionWorkspaceEffects {
  readonly #native = createFileActionWorkspaceEffects()
  readonly calls: string[] = []
  readonly allocations: string[] = []
  readonly discards: string[] = []
  constructor(
    readonly codec: WorkspaceReferenceCodec,
    readonly contents: OpaqueContentFactory,
    readonly gate: WorkspaceEffectGate = immediate,
  ) {
    Object.freeze(this)
  }
  async #before(effect: string, reference?: string) {
    this.calls.push(effect)
    await this.gate(effect, reference)
  }
  async allocate(root?: string) {
    await this.#before('allocate', root)
    const path = await this.#native.allocate(
      root === undefined ? undefined : this.codec.physical(root),
    )
    const reference = this.codec.reference(path)
    this.allocations.push(reference)
    return reference
  }
  async cloneBaseline(workspace: string, baseline: string) {
    await this.#before('cloneBaseline', workspace)
    return this.#native.cloneBaseline(this.codec.physical(workspace), this.codec.physical(baseline))
  }
  async run(...[reference, args, options]: Parameters<ActionWorkspaceEffects['run']>) {
    await this.#before('run', reference)
    return this.#native.run(this.codec.physical(reference), args, options)
  }
  async installPlatformExclude(reference: string) {
    await this.#before('installPlatformExclude', reference)
    return this.#native.installPlatformExclude(this.codec.physical(reference))
  }
  async requireEntry(reference: string) {
    await this.#before('requireEntry', reference)
    return this.#native.requireEntry(this.codec.physical(reference))
  }
  async discard(reference: string) {
    this.discards.push(reference)
    await this.#before('discard', reference)
    return this.#native.discard(this.codec.physical(reference))
  }
}

export class OpaqueEvidenceArtifacts extends GatedEvidenceArtifacts {
  readonly documentCommands: ReturnType<typeof createFileEvidenceDocumentCommands>
  constructor(
    readonly codec: WorkspaceReferenceCodec,
    root: string,
    gate: (effect: EvidenceEffect, reference: string) => Promise<void> = immediate,
  ) {
    super(root, gate)
    this.documentCommands = Object.freeze(
      createFileEvidenceDocumentCommands({ stagingRoot: join(root, 'staging'), evidence: this }),
    )
    Object.freeze(this)
  }
  override async materializeBundle(bundle: string, destination: string) {
    return super.materializeBundle(bundle, this.codec.physical(destination))
  }
  override async materializeBlob(blob: string, destination: string) {
    return super.materializeBlob(blob, this.codec.physical(destination))
  }
  override async importStagedTree(
    ...[root, budget]: Parameters<GatedEvidenceArtifacts['importStagedTree']>
  ) {
    return super.importStagedTree(this.codec.physical(root), budget)
  }
  override async putFile(reference: string) {
    return super.putFile(this.codec.physical(reference))
  }
  override async putBlobFromFile(reference: string) {
    return super.putBlobFromFile(this.codec.physical(reference))
  }
}

/** The remaining native delivery fixture executes actual Git/CAS through translated refs. */
export class OpaqueCandidateDelivery implements CandidateDeliveryPort {
  readonly #native = bindCandidateDeliveryParticipant()
  constructor(readonly codec: WorkspaceReferenceCodec) {
    Object.freeze(this)
  }
  async stage(input: Parameters<CandidateDeliveryPort['stage']>[0]) {
    const staged = await this.#native.stage({
      ...input,
      baselineRepoPath: this.codec.physical(input.baselineRepoPath),
      overlayRoot: this.codec.physical(input.overlayRoot),
    })
    return staged.ok ? { ...staged, ws: this.codec.reference(staged.ws) } : staged
  }
  commit(input: Parameters<CandidateDeliveryPort['commit']>[0]) {
    return this.#native.commit({
      ...input,
      baselineRepoPath: this.codec.physical(input.baselineRepoPath),
      overlayRoot: this.codec.physical(input.overlayRoot),
    })
  }
  push(input: Parameters<CandidateDeliveryPort['push']>[0]) {
    return this.#native.push({
      ...input,
      baselineRepoPath: this.codec.physical(input.baselineRepoPath),
    })
  }
}

class OpaqueEmployeeCaseScope implements EmployeeCaseWorkspaceEffects {
  constructor(
    readonly codec: WorkspaceReferenceCodec,
    readonly native: EmployeeCaseWorkspaceEffects,
  ) {
    Object.freeze(this)
  }
  resolve(reference: string, ...segments: readonly string[]) {
    return this.codec.reference(this.native.resolve(this.codec.physical(reference), ...segments))
  }
  sibling(reference: string, suffix: string) {
    return this.codec.reference(this.native.sibling(this.codec.physical(reference), suffix))
  }
  async exists(reference: string) {
    return this.native.exists(this.codec.physical(reference))
  }
  async stat(reference: string) {
    return this.native.stat(this.codec.physical(reference))
  }
  async list(reference: string) {
    return this.native.list(this.codec.physical(reference))
  }
  async createDirectory(reference: string) {
    return this.native.createDirectory(this.codec.physical(reference))
  }
  async copyFile(source: string, target: string) {
    return this.native.copyFile(this.codec.physical(source), this.codec.physical(target))
  }
  async setMode(reference: string, mode: number) {
    return this.native.setMode(this.codec.physical(reference), mode)
  }
  async readBytes(reference: string) {
    return this.native.readBytes(this.codec.physical(reference))
  }
  async writeText(reference: string, text: string) {
    return this.native.writeText(this.codec.physical(reference), text)
  }
  async remove(reference: string) {
    return this.native.remove(this.codec.physical(reference))
  }
  async move(source: string, target: string) {
    return this.native.move(this.codec.physical(source), this.codec.physical(target))
  }
  async runGit(...[reference, operands]: Parameters<EmployeeCaseWorkspaceEffects['runGit']>) {
    return this.native.runGit(
      this.codec.physical(reference),
      operands.map((operand) =>
        operand.kind === 'reference'
          ? { kind: 'reference', reference: this.codec.physical(operand.reference) }
          : operand,
      ),
    )
  }
  async close() {
    return this.native.close()
  }
}

/** Existing complete Case owner remains selected for actual DE checkpoint/restore. */
export class OpaqueEmployeeCaseFactory implements EmployeeCaseWorkspaceEffectsFactory {
  readonly #native = createFileEmployeeCaseWorkspaceEffectsFactory()
  constructor(readonly codec: WorkspaceReferenceCodec) {
    Object.freeze(this)
  }
  async acquire() {
    return new OpaqueEmployeeCaseScope(this.codec, await this.#native.acquire())
  }
}

/** Deterministic completion events; no wall-clock sleeps or relaxed test budgets. */
export function heldEffect() {
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const completion = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    async wait() {
      enter()
      await completion
    },
  }
}

/** Surface an early operation failure instead of hanging until the original timeout. */
export async function enteredBeforeOutcome(
  effect: ReturnType<typeof heldEffect>,
  operation: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    effect.entered,
    operation.then(
      () => {
        throw new Error('operation completed before the selected effect was entered')
      },
      (error: unknown) => {
        throw error
      },
    ),
  ])
}
