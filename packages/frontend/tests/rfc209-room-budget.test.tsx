// RFC-209 —— 自由协作房间：零回合分隔线 + 右栏「成员发言预算」。
//
// 这条测试锁的回归：用户 2026-07-20 实报「自由讨论里第 x 回合的轮次总是跳」。fc 的那个数
// 其实是 max_rounds 的**预算计数器**（成员 run 累计行数，design/RFC-164 §4.4「硬顶 成员 run
// 总数 > max_rounds」），不是回合序数；它不再以「第 X 回合」的形式出现在消息流里，改在右栏
// 如实显示成「已用 / 上限」，否则用户完全看不到任务什么时候会触顶。
//
// 注意：既有 workgroup-room.test.tsx 的 fcRoom() 是 `messages: []`，所以「fc 零分隔线」
// 这条验收在本文件之前**零覆盖**（对抗设计门点名）。这里的 fixture 特意带上非零 round 的消息。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { api } from '../src/api/client'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { WorkgroupRoom } from '../src/components/workgroup/room/WorkgroupRoom'
import { workgroupRoomKey } from '../src/lib/workgroup-room'
import type { WorkgroupRoomMessage, WorkgroupRoomResponse } from '../src/lib/workgroup-room'
import type { TaskStatus } from '@agent-workflow/shared'
import '../src/i18n'

// RFC-217 T10 — the room query moved up to tasks.detail.tsx (single owner,
// G9); tests reproduce that owner with this thin host.
function RoomHost(props: { taskId: string; taskStatus: TaskStatus }) {
  const room = useQuery<WorkgroupRoomResponse>({
    queryKey: workgroupRoomKey(props.taskId),
    queryFn: ({ signal }) =>
      api.get(`/api/workgroup-tasks/${encodeURIComponent(props.taskId)}/room`, undefined, signal),
  })
  return <WorkgroupRoom taskId={props.taskId} taskStatus={props.taskStatus} room={room} />
}

function msg(id: string, round: number): WorkgroupRoomMessage {
  return {
    id,
    round,
    authorKind: 'member',
    authorMemberId: 'mem_a',
    authorUserId: null,
    kind: 'chat',
    bodyMd: `body ${id}`,
    mentionMemberIds: [],
    assignmentId: null,
    createdAt: 1000,
  }
}

function room(
  mode: 'leader_worker' | 'free_collab',
  messages: WorkgroupRoomMessage[],
  budgetUsed: number,
): WorkgroupRoomResponse {
  return {
    taskId: 't1',
    taskStatus: 'running',
    budgetUsed,
    config: {
      workgroupId: 'wg1',
      workgroupName: 'squad',
      mode,
      leaderMemberId: mode === 'leader_worker' ? 'mem_a' : null,
      switches: { shareOutputs: true, directMessages: true, blackboard: true },
      maxRounds: 20,
      completionGate: false,
      instructions: '',
      goal: 'ship it',
      members: [
        {
          id: 'mem_a',
          memberType: 'agent',
          agentName: 'writer',
          userId: null,
          displayName: 'Ann',
          roleDesc: '',
        },
      ],
    },
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false, summary: null },
    dw: null,
    messages,
    assignments: [],
    memberRuns: {},
    runHistory: [],
  }
}

function installFetch(data: WorkgroupRoomResponse) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/room')) return json(data)
    if (url.includes('/node-runs')) return json({ runs: [] })
    if (url.includes('/users/lookup')) return json({ users: [] })
    return json({})
  })
}

function renderRoom() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RoomHost taskId="t1" taskStatus="running" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('RFC-209 — 自由协作房间', () => {
  // 用户实测形态：跳号（3→5→8）+ 中间穿插 round 0。
  const fcMessages = [msg('01A', 0), msg('01B', 3), msg('01C', 0), msg('01D', 5), msg('01E', 8)]

  test('零回合分隔线（哪怕消息带着跳号的 round）', async () => {
    installFetch(room('free_collab', fcMessages, 7))
    renderRoom()
    await screen.findByTestId('wg-msg-01E')
    expect(document.querySelectorAll('[data-testid^="wg-round-"]')).toHaveLength(0)
  })

  test('右栏显示「成员发言预算 已用 / 上限」+ 批量准入提示', async () => {
    installFetch(room('free_collab', fcMessages, 7))
    renderRoom()
    const budget = await screen.findByTestId('workgroup-room-turn-budget')
    expect(budget.textContent).toContain('7 / 20')
    // 如实标注：一批唤醒要整批放得下才会启动，所以会提前触顶（fc 的门是
    // budgetUsed + items.length >= maxRounds）。
    expect(budget.textContent).toMatch(/整批|batch/i)
  })

  test('lw 房间不显示预算表（回合号已由分隔线传达），且分隔线单调', async () => {
    installFetch(
      room('leader_worker', [msg('01A', 0), msg('01B', 2), msg('01C', 0), msg('01D', 3)], 3),
    )
    renderRoom()
    await screen.findByTestId('wg-msg-01D')
    expect(screen.queryByTestId('workgroup-room-turn-budget')).toBeNull()
    // 「一直穿插第 0 回合」的直接回归锁
    expect(screen.queryByTestId('wg-round-0')).toBeNull()
    await waitFor(() => {
      const rounds = [...document.querySelectorAll('[data-testid^="wg-round-"]')].map((el) =>
        Number((el.getAttribute('data-testid') ?? '').replace('wg-round-', '')),
      )
      expect(rounds).toEqual([2, 3])
    })
  })
})
