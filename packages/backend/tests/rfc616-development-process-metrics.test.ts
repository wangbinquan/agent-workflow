// RFC-616 §6.3 (design/RFC-616-process-metrics/design.md) — what the development employee type declares for
// process metrics.
//
// The common employee module never reads a type's own documents, so two measures exist only if the type states
// them: which work items are rework (first-pass rate) and which review comments on the merge request people
// wrote (human feedback). This file locks both for the development type:
//   · rework is exactly the three repair work items, each of them a work item of the type's manifest; finding
//     or classifying a problem, handing it to another employee and preparing an approval are not rework;
//   · the feedback projection keeps every comment a person wrote — also in a thread a bot answered last — and
//     drops bots and the platform's own replies;
//   · both answers have the shape the common module validates, and the type package really offers them;
//   · the graph delivery type, which merges that lifecycle in, carries both declarations; graph@1 has neither.

import { describe, expect, test } from 'bun:test'

import {
  describeProcessMetrics,
  projectHumanFeedbackJson,
} from '@/modules/development-automation/application/employeeProcessMetrics'
import {
  developmentEmployeeRuntimeCodec,
  mergeRequestContextSchema,
  runtimePackage,
} from '@/modules/development-automation/application/employeeTypePackage'
import { createGraphDeliveryLifecycleTypePackage } from '@/modules/development-automation/application/graph-development/deliveryLifecycle'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'
import { graphEmployeeTypePackage } from '@/modules/development-automation/application/graph-development/employeeType'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeGraphDeliveryLifecycleRuntimeCodec,
  composeGraphDeliveryLifecycleTypePackage,
} from '@/modules/development-automation/composition/graphDeliveryLifecycle'
import {
  readHumanFeedbackProjection,
  readProcessMetricsDeclaration,
} from '@/modules/digital-employee/application/processMetricsDeclarations'

type AuthorClass = 'human' | 'bot' | 'self'

interface MessageInput {
  readonly authorClass: AuthorClass
  readonly body: string
  readonly createdAt: string | null
}

interface ThreadInput {
  readonly threadRef: string
  /** As the collector records it: the class and body of the thread's latest comment that is not the platform's. */
  readonly authorClass: AuthorClass
  readonly body: string
  readonly resolved?: boolean
  readonly messages?: readonly MessageInput[]
}

const MERGE_REQUEST = 'development.merge-request'
const manifest = runtimePackage.descriptor.authoringManifest
const workItem = (workItemRef: string) =>
  manifest.workItems.find((item) => item.workItemRef === workItemRef)

/** A merge-request context exactly as the type stores it: built through the type's own schema. */
function mergeRequestState(threads: readonly ThreadInput[]): string {
  return JSON.stringify(
    mergeRequestContextSchema.parse({
      status: 'active',
      mergeRequestRef: 'repository-1!7',
      headSha: 'a'.repeat(40),
      issueHandlingContextRef: 'context-issue',
      readyToMerge: false,
      unresolvedReviewCount: threads.filter(
        (thread) => thread.resolved !== true && thread.authorClass !== 'self',
      ).length,
      reviewThreads: threads.map((thread) => ({
        threadRef: thread.threadRef,
        revision: `1:${thread.threadRef}`,
        authorClass: thread.authorClass,
        resolved: thread.resolved ?? false,
        body: thread.body,
        path: null,
        ...(thread.messages === undefined
          ? {}
          : {
              messages: thread.messages.map((message, index) => ({
                messageRef: `${thread.threadRef}-${index}`,
                parentMessageRef: index === 0 ? null : `${thread.threadRef}-0`,
                authorClass: message.authorClass,
                body: message.body,
                path: null,
                createdAt: message.createdAt,
              })),
            }),
      })),
    }),
  )
}

function items(contextTypeId: string, stateJson: string) {
  return (
    JSON.parse(projectHumanFeedbackJson(contextTypeId, stateJson)) as {
      items: { text: string; at: number; workItemRef?: string }[]
    }
  ).items
}

describe('RFC-616 development type — rework work items', () => {
  test('rework is the three repair work items, and each of them is in the manifest', () => {
    const { reworkWorkItemRefs } = describeProcessMetrics()

    expect(reworkWorkItemRefs).toEqual(['repair-feedback', 'repair-pipeline', 'repair-conflict'])
    for (const workItemRef of reworkWorkItemRefs) {
      // Repair is work an executor does on the merge request after it was opened.
      expect([
        workItemRef,
        workItem(workItemRef)?.nodeKind,
        workItem(workItemRef)?.regionId,
      ]).toEqual([workItemRef, 'business-tool', 'care'])
    }
  })

  test('first-time work is not rework: finding or classifying a problem, collaboration, approval, delivery', () => {
    const rework = new Set(describeProcessMetrics().reworkWorkItemRefs)
    const firstTimeWork = [
      'classify-feedback',
      'acknowledge-feedback',
      'reply-feedback',
      'collect-pipeline',
      'classify-pipeline',
      'publish-conflict',
      'delegate',
      'prepare-approval',
      'submit-approval',
      'observe-approval',
    ]
    for (const workItemRef of firstTimeWork) {
      expect([workItemRef, workItem(workItemRef) !== undefined]).toEqual([workItemRef, true])
      expect([workItemRef, rework.has(workItemRef)]).toEqual([workItemRef, false])
    }
    // Nothing on the delivery spine (the first region) is rework, and no collaboration work item is.
    expect(
      manifest.workItems
        .filter((item) => item.regionId === 'delivery' || item.nodeKind === 'collaboration')
        .filter((item) => rework.has(item.workItemRef)),
    ).toEqual([])
  })

  test('the type package carries the declaration, in the shape the common module validates', () => {
    expect(runtimePackage.describeProcessMetrics()).toEqual(describeProcessMetrics())
    expect(
      readProcessMetricsDeclaration(() => JSON.stringify(runtimePackage.describeProcessMetrics())),
    ).toEqual({ reworkWorkItemRefs: ['repair-feedback', 'repair-pipeline', 'repair-conflict'] })
  })

  test('the registration bootstrap hands to the common module answers with the declaration', () => {
    // The common module asks the registration, not the package behind it: a registration without the member
    // leaves the development type without a first-pass measure.
    const declared = readProcessMetricsDeclaration(
      () => developmentEmployeeTypePackage.describeProcessMetricsJson?.() ?? 'null',
    )
    expect(declared).toEqual({
      reworkWorkItemRefs: ['repair-feedback', 'repair-pipeline', 'repair-conflict'],
    })
  })
})

describe('RFC-616 development type — human feedback', () => {
  const state = mergeRequestState([
    {
      // A person opened the thread and followed up; a bot answered last, so the thread itself reads as a bot's.
      threadRef: 'thread-person',
      authorClass: 'bot',
      body: 'lint: still two warnings',
      messages: [
        {
          authorClass: 'human',
          body: 'Please split this function.',
          createdAt: '2026-11-02T08:00:00.000Z',
        },
        {
          authorClass: 'self',
          body: 'Received. <!-- aw-self:case-1 -->',
          createdAt: '2026-11-02T08:01:00.000Z',
        },
        {
          authorClass: 'human',
          body: 'And add a test for the empty case.',
          createdAt: '2026-11-02T09:30:00+01:00',
        },
        { authorClass: 'bot', body: 'lint: still two warnings', createdAt: '2026-11-02T10:00:00Z' },
      ],
    },
    {
      threadRef: 'thread-bot',
      authorClass: 'bot',
      body: 'coverage dropped by 2%',
      messages: [
        { authorClass: 'bot', body: 'coverage dropped by 2%', createdAt: '2026-11-02T11:00:00Z' },
      ],
    },
    {
      threadRef: 'thread-platform',
      authorClass: 'self',
      body: '',
      messages: [
        {
          authorClass: 'self',
          body: 'Updated the merge request. <!-- aw-self:case-1 -->',
          createdAt: '2026-11-02T11:30:00Z',
        },
      ],
    },
    {
      // Resolving a thread does not undo the feedback.
      threadRef: 'thread-resolved',
      authorClass: 'human',
      body: 'Rename this, please.',
      resolved: true,
      messages: [
        { authorClass: 'human', body: 'Rename this, please.', createdAt: '2026-11-02T12:00:00Z' },
      ],
    },
    {
      threadRef: 'thread-untimed',
      authorClass: 'human',
      body: 'No time was recorded for this one.',
      messages: [
        { authorClass: 'human', body: '   ', createdAt: '2026-11-02T13:00:00Z' },
        { authorClass: 'human', body: 'Its time is not a time.', createdAt: 'last Tuesday' },
        { authorClass: 'human', body: 'No time was recorded for this one.', createdAt: null },
      ],
    },
    // Recorded before per-comment history existed: only the latest outside comment and its author class.
    { threadRef: 'thread-legacy-person', authorClass: 'human', body: 'An early comment.' },
    { threadRef: 'thread-legacy-bot', authorClass: 'bot', body: 'An early bot note.' },
  ])

  test("keeps each comment a person wrote and drops bots and the platform's own replies", () => {
    expect(items(MERGE_REQUEST, state)).toEqual([
      {
        text: 'Please split this function.',
        at: Date.UTC(2026, 10, 2, 8, 0, 0),
        workItemRef: 'repair-feedback',
      },
      {
        text: 'And add a test for the empty case.',
        at: Date.UTC(2026, 10, 2, 8, 30, 0),
        workItemRef: 'repair-feedback',
      },
      {
        text: 'Rename this, please.',
        at: Date.UTC(2026, 10, 2, 12, 0, 0),
        workItemRef: 'repair-feedback',
      },
      // A comment without a usable time still counts; 0 is the contract's "no time for this item".
      { text: 'Its time is not a time.', at: 0, workItemRef: 'repair-feedback' },
      { text: 'No time was recorded for this one.', at: 0, workItemRef: 'repair-feedback' },
      { text: 'An early comment.', at: 0, workItemRef: 'repair-feedback' },
    ])
  })

  test('feedback is reported against the work item that resolves review threads', () => {
    const handler = workItem('repair-feedback')
    expect(handler?.responsibilityLaneId).toBe('care-review')
    expect(new Set(items(MERGE_REQUEST, state).map((item) => item.workItemRef))).toEqual(
      new Set(['repair-feedback']),
    )
  })

  test('only the merge-request context holds review feedback; other contexts are not even read', () => {
    expect(items(MERGE_REQUEST, mergeRequestState([]))).toEqual([])
    for (const context of runtimePackage.descriptor.contextTypes) {
      if (context.typeId === MERGE_REQUEST) continue
      expect([context.typeId, items(context.typeId, 'not a document')]).toEqual([
        context.typeId,
        [],
      ])
    }
    expect(runtimePackage.descriptor.contextTypes.map((context) => context.typeId)).toContain(
      MERGE_REQUEST,
    )
  })

  test('a merge-request document the type cannot read is an error, not an empty answer', () => {
    expect(() => projectHumanFeedbackJson(MERGE_REQUEST, 'not a document')).toThrow()
    expect(() =>
      projectHumanFeedbackJson(MERGE_REQUEST, JSON.stringify({ reviewThreads: 'none' })),
    ).toThrow()
  })

  test('the context codec offers the projection, in the shape the common module validates', () => {
    const project = developmentEmployeeRuntimeCodec.projectHumanFeedbackJson
    expect(project).toBe(projectHumanFeedbackJson)

    const read = readHumanFeedbackProjection(() => projectHumanFeedbackJson(MERGE_REQUEST, state))
    expect(read).toEqual(items(MERGE_REQUEST, state))
    expect(read).toHaveLength(6)
    // The common module turns the error above into "not provided" rather than into zero items.
    expect(
      readHumanFeedbackProjection(() => projectHumanFeedbackJson(MERGE_REQUEST, 'not a document')),
    ).toBeNull()
  })
})

describe('RFC-616 graph delivery type — the merged-in lifecycle brings both declarations', () => {
  const REWORK = ['repair-feedback', 'repair-pipeline', 'repair-conflict']

  test('graph@2 declares the rework work items of the lifecycle it merges in, and its manifest has each', () => {
    const composed = composeGraphDeliveryLifecycleTypePackage(graphEmployeeTypePackage)
    expect(
      readProcessMetricsDeclaration(() => composed.describeProcessMetricsJson?.() ?? 'null'),
    ).toEqual({ reworkWorkItemRefs: REWORK })
    const descriptor = JSON.parse(composed.descriptorJson) as {
      authoringManifest: { workItems: { workItemRef: string }[] }
    }
    const declared = new Set(descriptor.authoringManifest.workItems.map((item) => item.workItemRef))
    expect(REWORK.filter((workItemRef) => !declared.has(workItemRef))).toEqual([])
  })

  test('graph@1 has no merge request to look after, so it declares no rework', () => {
    expect(graphEmployeeTypePackage.describeProcessMetricsJson).toBeUndefined()
    expect(graphEmployeeRuntimeCodec.projectHumanFeedbackJson).toBeUndefined()
  })

  test('a lifecycle registration without the declaration leaves the composed type without one', () => {
    // An absent member means "not provided"; an inherited empty answer would be read as a measured zero.
    const undeclared = createGraphDeliveryLifecycleTypePackage(graphEmployeeTypePackage, {
      validateContractFixtureJson: (json) => json,
    })
    expect('describeProcessMetricsJson' in undeclared).toBe(false)
    expect(
      'describeProcessMetricsJson' in
        createGraphDeliveryLifecycleTypePackage(
          graphEmployeeTypePackage,
          developmentEmployeeTypePackage,
        ),
    ).toBe(true)
  })

  test('its codec projects the review comments of the merge-request context and nothing from a graph context', () => {
    const codec = composeGraphDeliveryLifecycleRuntimeCodec(graphEmployeeRuntimeCodec)
    const state = mergeRequestState([
      {
        threadRef: 'thread-person',
        authorClass: 'human',
        body: 'Please cover the empty-list case.',
        messages: [
          {
            authorClass: 'human',
            body: 'Please cover the empty-list case.',
            createdAt: '2026-11-20T08:00:00.000Z',
          },
          { authorClass: 'self', body: 'Covered in the next push.', createdAt: null },
        ],
      },
    ])
    const project = codec.projectHumanFeedbackJson
    expect(project).toBe(projectHumanFeedbackJson)
    expect(readHumanFeedbackProjection(() => project!(MERGE_REQUEST, state))).toEqual([
      {
        text: 'Please cover the empty-list case.',
        at: Date.parse('2026-11-20T08:00:00.000Z'),
        workItemRef: 'repair-feedback',
      },
    ])
    expect(readHumanFeedbackProjection(() => project!('graph-development.design', '{}'))).toEqual(
      [],
    )
  })
})
