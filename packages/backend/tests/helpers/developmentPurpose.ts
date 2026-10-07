import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { EvidenceDocumentCommands } from '@/modules/development-automation/application/evidenceDocumentCommands'
import type {
  EvidenceStagingFactory,
  EvidenceStagingLease,
  EvidenceStagingNamespace,
  EvidenceStagingReference,
} from '@/modules/development-automation/public/types'
import type {
  EvidenceBudget,
  EvidenceBundleRecord,
} from '@/modules/development-automation/domain/evidence'
import type {
  AdapterProgramReference,
  AdapterProgramFactory,
  AdapterProcessObservation,
  RequirementAdapterEffects,
  PipelineAdapterEffects,
  ApprovalAdapterEffects,
} from '@/modules/integration/public/participants'

export const held = <T>() => Promise.withResolvers<T>()
export const unusedPurposeEffect = (): never => {
  throw new Error('unchosen physical effect')
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** One content model covers program writes, adoption, document writes and later reads. */
export class MemoryPurposeContent {
  readonly namespace: EvidenceStagingNamespace = {
    kind: 'evidence-staging-namespace',
    reference: {},
  }
  readonly stages = new Map<object, MemoryPurposeStage>()
  readonly bundles = new Map<string, EvidenceBundleRecord>()
  readonly blobs = new Map<string, Uint8Array>()
  readonly calls: string[] = []
  before: (operation: string) => void | Promise<void> = () => {}
  readonly staging: EvidenceStagingFactory
  readonly documents: EvidenceDocumentCommands
  readonly evidence: EvidenceArtifactPort

  constructor() {
    const operations = memoryContentOperations(this)
    this.staging = operations.staging
    this.documents = operations.documents
    this.evidence = operations.evidence
  }

  put(bytes: Uint8Array) {
    const sha256 = digest(bytes)
    this.blobs.set(sha256, bytes)
    return { sha256, bytes: bytes.byteLength }
  }
  stage(reference: EvidenceStagingReference) {
    expect(reference.namespace.reference).toBe(this.namespace.reference)
    const stage = this.stages.get(reference.reference)
    if (stage === undefined) throw new Error('selected stage reference not found')
    return stage
  }
}

function memoryContentOperations(content: MemoryPurposeContent) {
  class Factory implements EvidenceStagingFactory {
    readonly namespace = content.namespace
    create() {
      expect<EvidenceStagingFactory>(this).toBe(content.staging)
      const allocate = () => {
        const stage = new MemoryPurposeStage(content)
        content.stages.set(stage.reference.reference, stage)
        return stage
      }
      content.calls.push('create')
      const pending = content.before('create')
      return pending === undefined ? allocate() : pending.then(allocate)
    }
  }
  const staging = Object.freeze(new Factory())
  const documents: EvidenceDocumentCommands = {
    async writeDocument(input) {
      expect(this).toBe(content.documents)
      const allocation = content.staging.create()
      const stage = 'then' in allocation ? await allocation : allocation
      try {
        const write = stage.writeText({ relativeName: input.relativePath, text: input.content })
        if (write !== undefined) await write
        return await stage.importTree(input.budget)
      } finally {
        const close = stage.close()
        if (close !== undefined) await close
      }
    },
  }
  const decoder = new TextDecoder()
  const evidence: EvidenceArtifactPort = {
    contents: {
      readText(ref) {
        const bytes = content.blobs.get(ref)
        return bytes === undefined ? null : decoder.decode(bytes)
      },
      readRange(input) {
        const bytes = content.blobs.get(input.sha256)
        if (bytes === undefined) return { ok: false, code: 'evidence-file-missing' }
        const end = Math.min(bytes.byteLength, input.offsetBytes + input.limitBytes)
        return {
          ok: true,
          bytes: bytes.slice(input.offsetBytes, end),
          totalBytes: bytes.byteLength,
          truncated: end < bytes.byteLength,
          nextOffset: end < bytes.byteLength ? end : null,
        }
      },
    },
    documents: {
      readText(input) {
        const entry = content.bundles
          .get(input.bundleRef)
          ?.entries.find((x) => x.relativePath === input.relativePath)
        const bytes = entry === undefined ? undefined : content.blobs.get(entry.sha256)
        return bytes === undefined ? null : decoder.decode(bytes)
      },
    },
    downloads: {
      open(ref) {
        const bytes = content.blobs.get(ref)
        if (bytes === undefined) return null
        const stream = (part: Uint8Array) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(part)
              controller.close()
            },
          })
        return {
          openAll: () => stream(bytes),
          open: (start, end) => stream(bytes.slice(start, end + 1)),
        }
      },
    },
    contexts: {
      save: async (text) => content.put(new TextEncoder().encode(text)).sha256,
      load: (ref) => content.evidence.contents.readText(ref),
    },
    getBundle: (ref) => content.bundles.get(ref) ?? null,
    putFile: unusedPurposeEffect,
    putBlobFromFile: unusedPurposeEffect,
    importStagedTree: unusedPurposeEffect,
    materializeBundle: unusedPurposeEffect,
    materializeBlob: unusedPurposeEffect,
    hasBlob: (ref) => content.blobs.has(ref),
  }

  return { staging, documents, evidence }
}

class MemoryPurposeStage implements EvidenceStagingLease {
  readonly reference: EvidenceStagingReference
  readonly files = new Map<string, string>()
  closed = false
  constructor(readonly content: MemoryPurposeContent) {
    this.reference = { kind: 'evidence-staging', namespace: content.namespace, reference: {} }
  }
  writeText(input: { readonly relativeName: string; readonly text: string }) {
    this.content.calls.push('write:' + input.relativeName)
    const write = () => {
      this.files.set(input.relativeName, input.text)
    }
    const pending = this.content.before('write')
    return pending === undefined ? write() : pending.then(write)
  }
  importTree(_budget: EvidenceBudget) {
    this.content.calls.push('import')
    const adopt = () => {
      const entries = [...this.files].map(([relativePath, text]) => ({
        relativePath,
        ...this.content.put(new TextEncoder().encode(text)),
      }))
      const bundle = {
        bundleId: 'object:bundle:' + this.content.bundles.size,
        entries,
        totalBytes: entries.reduce((n, x) => n + x.bytes, 0),
      }
      this.content.bundles.set(bundle.bundleId, bundle)
      return bundle
    }
    const pending = this.content.before('import')
    return pending === undefined ? adopt() : pending.then(adopt)
  }
  putDocument(text: string) {
    this.content.calls.push('put')
    const put = () => this.content.put(new TextEncoder().encode(text))
    const pending = this.content.before('put')
    return pending === undefined ? put() : pending.then(put)
  }
  close() {
    this.content.calls.push('close')
    const close = () => {
      this.closed = true
    }
    const pending = this.content.before('close')
    return pending === undefined ? close() : pending.then(close)
  }
}

/** Complete prototype methods exercise each operation's actual receiver. */
export class PurposeEffects
  implements RequirementAdapterEffects, PipelineAdapterEffects, ApprovalAdapterEffects
{
  readonly calls: { readonly kind: string; readonly input: object }[] = []
  observeOperation: (
    kind: string,
    input: {
      readonly program: AdapterProgramReference
      readonly staging: EvidenceStagingReference
    },
  ) => Promise<AdapterProcessObservation> = unusedPurposeEffect
  constructor(
    readonly namespace: EvidenceStagingNamespace,
    readonly programs: AdapterProgramFactory,
  ) {}
  private observeInput(
    kind: string,
    input: {
      readonly program: AdapterProgramReference
      readonly staging: EvidenceStagingReference
    },
  ) {
    this.calls.push({ kind, input })
    return this.observeOperation(kind, input)
  }
  acquire(input: Parameters<RequirementAdapterEffects['acquire']>[0]) {
    return this.observeInput('acquire', input)
  }
  questionsWriteback(input: Parameters<RequirementAdapterEffects['questionsWriteback']>[0]) {
    return this.observeInput('questions.writeback', input)
  }
  answersCollect(input: Parameters<RequirementAdapterEffects['answersCollect']>[0]) {
    return this.observeInput('answers.collect', input)
  }
  collect(input: Parameters<PipelineAdapterEffects['collect']>[0]) {
    return this.observeInput('pipeline.collect', input)
  }
  trigger(input: Parameters<PipelineAdapterEffects['trigger']>[0]) {
    return this.observeInput('pipeline.trigger', input)
  }
  rerun(input: Parameters<PipelineAdapterEffects['rerun']>[0]) {
    return this.observeInput('pipeline.rerun', input)
  }
  submit(input: Parameters<ApprovalAdapterEffects['submit']>[0]) {
    return this.observeInput('approval.submit', input)
  }
  lookup(input: Parameters<ApprovalAdapterEffects['lookup']>[0]) {
    return this.observeInput('approval.lookup', input)
  }
  observe(input: Parameters<ApprovalAdapterEffects['observe']>[0]) {
    return this.observeInput('approval.observe', input)
  }
}
