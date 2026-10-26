// RFC-395 A4/A5 fix round: retain HEAD bytes and error precedence while avoiding
// eager decoding/hashing; snapshot completeness is checked at the caller boundary.
import { expect, spyOn, test } from 'bun:test'
import { decodeLegacyClarifyAnswerColumns } from '@/modules/collaboration/infrastructure/clarifyAnswerCodec'
import { clarifyAnswerContentForPrompt } from '@/modules/collaboration/domain/clarifyAnswerContent'
import { copyPortArchive, portArchiveTaskRoot } from '@/platform/content/locations/portArchive'
import { decodePrompt, encodePrompt } from '@/platform/content/locations/prompt'
import { isHostedArchiveTemporary } from '@/platform/content/locations/hostedArchive'
import { isHostedPluginReference } from '@/platform/content/locations/plugin'
import * as hash from '@/util/hash'
import { bindOracleRow } from '@/modules/task-execution/infrastructure/migration/oracle/scope'
import { join } from 'node:path'
import {
  CreateAgentSchema,
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  type WorkflowDefinition,
  type Agent,
} from '@agent-workflow/shared'
import { prepareAgentReferenceUpdate } from '@/modules/resource-catalog/infrastructure/agentReferenceWrite'
import { extractWorkflowAgentRefs } from '@/modules/resource-catalog/infrastructure/legacy/resourceRefs'
import type { RunHistoryFacts } from '@/modules/task-execution/infrastructure/migration/oracle/historySnapshot'

const answer = {
  questionId: 'q',
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText: 'HEAD',
}

test('answer-only projections decode once and never inspect draft or attribution columns', () => {
  const reads = { answers: 0, drafts: 0, attributions: 0 }
  const columns = {
    get answersJson() {
      reads.answers += 1
      return JSON.stringify([answer])
    },
    get draftAnswersJson() {
      reads.drafts += 1
      return '{"q":{"selectedOptionIndices":[],"customText":"draft"}}'
    },
    get answerAttributionsJson() {
      reads.attributions += 1
      return '{}'
    },
  }
  const decoded = decodeLegacyClarifyAnswerColumns(columns)
  expect(reads).toEqual({ answers: 0, drafts: 0, attributions: 0 })
  expect(decoded.firstAnswer('q')).toEqual(answer)
  expect(decoded.requireAnswers()).toEqual([answer])
  expect(decoded.requireAnswerMap().get('q')).toEqual(answer)
  expect(decoded.optionalAnswers).toEqual([answer])
  expect(reads).toEqual({ answers: 1, drafts: 0, attributions: 0 })
  expect(decoded.draftAnswers).toEqual({ q: { selectedOptionIndices: [], customText: 'draft' } })
  expect(decoded.answerAttributions).toEqual({})
  void decoded.draftAnswers
  void decoded.answerAttributions
  expect(reads).toEqual({ answers: 1, drafts: 1, attributions: 1 })
})

test('closed clarify content preserves historical scalar, object and malformed prompt text', () => {
  for (const [raw, expected] of [
    [' { "x" : 1 } ', '{"x":1}'],
    ['null', 'null'],
    ['true', 'true'],
    ['1.0', '1'],
    ['"hello"', '"hello"'],
    ['malformed {', 'malformed {'],
  ] as const)
    expect(
      clarifyAnswerContentForPrompt(decodeLegacyClarifyAnswerColumns({ answersJson: raw }).content),
    ).toBe(expected)
})

test('opaque archive copies preserve bytes without parsing their roster', () => {
  const parse = spyOn(JSON, 'parse')
  try {
    for (const raw of [null, '', 'broken {', ' { "v": 1, "items": [] } '])
      expect(copyPortArchive(raw)).toBe(raw)
    expect(parse).not.toHaveBeenCalled()
  } finally {
    parse.mockRestore()
  }
})

test('reading or storing an inline prompt hashes only when its digest is requested', () => {
  const digest = spyOn(hash, 'sha256Hex')
  try {
    const storage = { promptText: '', promptPath: 'old/path' }
    const ref = decodePrompt(storage)!
    expect(encodePrompt(ref)).toEqual(storage)
    expect(ref.size).toBe(0)
    expect(digest).not.toHaveBeenCalled()
    expect(ref.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(ref.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(digest).toHaveBeenCalledTimes(1)
  } finally {
    digest.mockRestore()
  }
})

test('moved location classifiers keep the HEAD prefix and temporary-root rules', () => {
  expect(portArchiveTaskRoot('t')).toBe(join('runs', 't', 'ports'))
  for (const [path, expected] of [
    ['cs-plugin:', true],
    ['cs-plugin:invalid', true],
    ['cs-plugin:x/y', true],
    ['CS-plugin:x/y', false],
    ['local/path', false],
  ] as const)
    expect(isHostedPluginReference(path)).toBe(expected)
  for (const [path, expected] of [
    ['cs-archive:tasks/.tmp-a', true],
    ['cs-archive:tasks/.tmp-', false],
    ['cs-archive:tasks/.tmp-a/nested', false],
    ['cs-archive:runs/.tmp-a', false],
  ] as const)
    expect(isHostedArchiveTemporary(path)).toBe(expected)
})

test('projection missing-field accessors are shared and explicit undefined is still missing', () => {
  const left = bindOracleRow({ id: 'left', seq: undefined }, false)
  const right = bindOracleRow({ id: 'right' }, false)
  expect(Object.getPrototypeOf(left)).toBe(Object.getPrototypeOf(right))
  expect(() => left.seq).toThrow('oracle-snapshot-field-missing:left:seq')
  expect(() => right.seq).toThrow('oracle-snapshot-field-missing:right:seq')
})

// Compile-time negative control: review history always reads parentNodeRunId.
// @ts-expect-error a top-level history row must declare parent identity.
const incompleteHistory: RunHistoryFacts = { id: 'r', nodeId: 'n', seq: null, status: 'done' }
void incompleteHistory

test('call collectors retain HEAD TypeErrors for absent nodes and null node elements', () => {
  for (const raw of [{}, { nodes: null }, { nodes: [null] }]) {
    const definition = raw as unknown as WorkflowDefinition
    expect(() => collectWorkflowCallRefs(definition)).toThrow(TypeError)
    expect(() => collectWorkgroupCallRefs(definition)).toThrow(TypeError)
  }
  // HEAD's legacy agent extractor explicitly skips null; its policy differs from calls.
  expect(
    extractWorkflowAgentRefs({ nodes: [null] } as unknown as Parameters<
      typeof extractWorkflowAgentRefs
    >[0]),
  ).toEqual(new Set())
  expect(extractWorkflowAgentRefs({})).toEqual(new Set())
})

test('agent update preparation preserves the pre-transaction duplicate-port error', () => {
  const current: Agent = {
    ...CreateAgentSchema.parse({ name: 'before' }),
    id: 'agent',
    ownerUserId: null,
    visibility: 'private',
    builtin: false,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  expect(() =>
    prepareAgentReferenceUpdate({
      current,
      patch: {
        inputs: [
          { name: 'duplicate', kind: 'string' },
          { name: 'duplicate', kind: 'string' },
        ],
      },
      updatedAt: 2,
      expectedUpdatedAt: -1,
      expectedAclRevision: -1,
    }),
  ).toThrow('input port name must be unique')
})
