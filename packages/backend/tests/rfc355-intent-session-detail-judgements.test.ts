// RFC-355 T8（RFC-294 W4-E4a）—— 从 `routes/intentSessions.ts` 详情 handler 里收回来的
// 两条纯判据的正向 / 边界 / 缺省覆盖。
//
// 这两段此前是路由里的内联表达式，没有任何可直接断言的面：想验「同名请求只出一条」
// 或「换代后不再出建议」，只能起一整个 HTTP harness。收进 domain 后它们是纯函数，
// 这里逐条钉死用户可见行为，任何未来的 refactor 改动这些档位都会立刻变红。

import { describe, expect, test } from 'bun:test'
import { intentDraftLifecycleOf } from '../src/modules/intent/domain/draftLifecycle'
import {
  intentMountSuggestionsOf,
  type IntentMountSuggestionTurn,
} from '../src/modules/intent/domain/mountSuggestions'

describe('RFC-355 T8 —— 草稿生命周期三档', () => {
  test('当前草稿永远是 current，哪怕它也被提交过', () => {
    expect(intentDraftLifecycleOf({ isCurrent: true, commitSeq: 7, resolution: 'discarded' })).toBe(
      'current',
    )
  })

  test('非当前但提交过 ⇒ committed（commitSeq 为 0 也算提交过）', () => {
    expect(intentDraftLifecycleOf({ isCurrent: false, commitSeq: 0, resolution: undefined })).toBe(
      'committed',
    )
  })

  test('非当前、没提交过、有显式 resolution ⇒ 按 resolution', () => {
    expect(
      intentDraftLifecycleOf({ isCurrent: false, commitSeq: null, resolution: 'discarded' }),
    ).toBe('discarded')
  })

  test('缺省档是 superseded，不是 discarded——「被后一版顶掉」不等于「被用户丢弃」', () => {
    expect(
      intentDraftLifecycleOf({ isCurrent: false, commitSeq: null, resolution: undefined }),
    ).toBe('superseded')
  })
})

const TURN: IntentMountSuggestionTurn = {
  id: 'turn-1',
  seq: 3,
  kind: 'questions',
  contextRevision: 5,
  mountRequests: [{ resourceType: 'agent', name: 'auditor', reason: 'needs review' }],
}

const VISIBLE = [
  { resourceType: 'agent', resourceId: 'a1', name: 'auditor', description: 'the auditor' },
  { resourceType: 'agent', resourceId: 'a2', name: 'auditor', description: null },
  { resourceType: 'skill', resourceId: 's1', name: 'auditor', description: null },
] as const

describe('RFC-355 T8 —— 挂载建议判据', () => {
  test('正向：候选只列同类型同名、且当前未挂载的可见资源', () => {
    const suggestions = intentMountSuggestionsOf({
      latestAgentTurn: TURN,
      hasLaterApproval: false,
      sessionContextRevision: 5,
      mounted: [{ resourceType: 'agent', resourceId: 'a1' }],
      visibleResources: VISIBLE,
    })
    expect(suggestions).toEqual({
      sourceTurnId: 'turn-1',
      sourceTurnSeq: 3,
      contextRevision: 5,
      items: [
        {
          resourceType: 'agent',
          name: 'auditor',
          reason: 'needs review',
          candidates: [{ resourceId: 'a2', name: 'auditor', description: null }],
        },
      ],
    })
  })

  test('同类型同名的重复请求只出一条', () => {
    const suggestions = intentMountSuggestionsOf({
      latestAgentTurn: {
        ...TURN,
        mountRequests: [
          { resourceType: 'agent', name: 'auditor' },
          { resourceType: 'agent', name: 'auditor', reason: '第二次提' },
        ],
      },
      hasLaterApproval: false,
      sessionContextRevision: 5,
      mounted: [],
      visibleResources: VISIBLE,
    })
    expect(suggestions?.items).toHaveLength(1)
    // 去重取**第一条**：后面那条的 reason 不该覆盖先到的。
    expect(suggestions?.items[0]?.reason).toBeNull()
  })

  test('去重键用 NUL 分隔——(a:b, c) 与 (a, b:c) 不是同一条', () => {
    const suggestions = intentMountSuggestionsOf({
      latestAgentTurn: {
        ...TURN,
        mountRequests: [
          { resourceType: 'agent:x', name: 'y' },
          { resourceType: 'agent', name: 'x:y' },
        ] as never,
      },
      hasLaterApproval: false,
      sessionContextRevision: 5,
      mounted: [],
      visibleResources: [],
    })
    expect(suggestions?.items).toHaveLength(2)
  })

  test('上下文换代后不再出建议（旧轮次提的挂载已经不适用了）', () => {
    expect(
      intentMountSuggestionsOf({
        latestAgentTurn: TURN,
        hasLaterApproval: false,
        sessionContextRevision: 6,
        mounted: [],
        visibleResources: VISIBLE,
      }),
    ).toBeNull()
  })

  test('已经批过一次之后不再出建议', () => {
    expect(
      intentMountSuggestionsOf({
        latestAgentTurn: TURN,
        hasLaterApproval: true,
        sessionContextRevision: 5,
        mounted: [],
        visibleResources: VISIBLE,
      }),
    ).toBeNull()
  })

  test('只有 questions / changeset 轮次会出建议', () => {
    for (const kind of ['message', 'answers', 'mount-approval', 'running', 'error']) {
      expect(
        intentMountSuggestionsOf({
          latestAgentTurn: { ...TURN, kind },
          hasLaterApproval: false,
          sessionContextRevision: 5,
          mounted: [],
          visibleResources: VISIBLE,
        }),
      ).toBeNull()
    }
    expect(
      intentMountSuggestionsOf({
        latestAgentTurn: { ...TURN, kind: 'changeset' },
        hasLaterApproval: false,
        sessionContextRevision: 5,
        mounted: [],
        visibleResources: VISIBLE,
      }),
    ).not.toBeNull()
  })

  test('没有 agent 轮次 / 请求解析失败 / 一条候选都凑不出 ⇒ null（前端整块不渲染）', () => {
    expect(
      intentMountSuggestionsOf({
        latestAgentTurn: undefined,
        hasLaterApproval: false,
        sessionContextRevision: 5,
        mounted: [],
        visibleResources: VISIBLE,
      }),
    ).toBeNull()
    expect(
      intentMountSuggestionsOf({
        latestAgentTurn: { ...TURN, mountRequests: null },
        hasLaterApproval: false,
        sessionContextRevision: 5,
        mounted: [],
        visibleResources: VISIBLE,
      }),
    ).toBeNull()
    expect(
      intentMountSuggestionsOf({
        latestAgentTurn: { ...TURN, mountRequests: [] },
        hasLaterApproval: false,
        sessionContextRevision: 5,
        mounted: [],
        visibleResources: VISIBLE,
      }),
    ).toBeNull()
  })

  test('请求本身没有可见候选时仍出这一条——用户要看见「它想挂但你没有」', () => {
    const suggestions = intentMountSuggestionsOf({
      latestAgentTurn: TURN,
      hasLaterApproval: false,
      sessionContextRevision: 5,
      mounted: [
        { resourceType: 'agent', resourceId: 'a1' },
        { resourceType: 'agent', resourceId: 'a2' },
      ],
      visibleResources: VISIBLE,
    })
    expect(suggestions?.items).toEqual([
      { resourceType: 'agent', name: 'auditor', reason: 'needs review', candidates: [] },
    ])
  })
})
