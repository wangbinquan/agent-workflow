// RFC-310 PR-5 T59 —— DeliveryPolicy 纯判定矩阵（design §9.0）。
//
// 锁：分支名由平台模板生成（Agent 不供名）；碰撞闭集——同 marker 同绑定幂等
// adopt / 同 marker 异绑定 blocked / 普通同名 deterministic suffix / 后缀耗尽
// blocked；marker 反解 round-trip；commit message 保留业务正文，但平台追踪字段只由平台生成。

import { describe, expect, test } from 'bun:test'

import {
  candidateCommitMessage,
  missionGitRefComponent,
  missionMachineMarker,
  missionMarkerOfBranch,
  missionSourceBranch,
  resolveSourceBranch,
} from '../src/modules/source-control/domain/deliveryPolicy'

const MISSION = '01M09TESTULID000000000000A'

describe('rfc310 pr5 — delivery policy', () => {
  test('OS Case identities are deterministically encoded into valid Git ref components', () => {
    expect(missionGitRefComponent(MISSION)).toBe(MISSION.toLowerCase())
    const encoded = missionGitRefComponent('employee-child:ABC/42')
    expect(encoded).toMatch(/^x[a-f0-9]{64}$/)
    expect(missionSourceBranch('employee-child:ABC/42')).toBe(`aw/mission-${encoded}`)
    expect(missionGitRefComponent('employee-child:ABC/43')).not.toBe(encoded)
  })

  test('branch naming is platform-templated and round-trips the mission marker', () => {
    const branch = missionSourceBranch(MISSION)
    expect(branch).toBe(`aw/mission-${MISSION.toLowerCase()}`)
    expect(missionMarkerOfBranch(branch)).toBe(MISSION)
    expect(missionMarkerOfBranch(`${branch}-3`)).toBe(MISSION)
    expect(missionMarkerOfBranch('feature/anything')).toBeNull()
  })

  test('no collision → create; same marker + same binding → idempotent adopt', () => {
    expect(
      resolveSourceBranch({
        missionId: MISSION,
        repositoryRef: 'r1',
        targetRef: 'main',
        existing: [],
      }),
    ).toEqual({ kind: 'create', branch: missionSourceBranch(MISSION) })
    expect(
      resolveSourceBranch({
        missionId: MISSION,
        repositoryRef: 'r1',
        targetRef: 'main',
        existing: [
          {
            branch: missionSourceBranch(MISSION),
            missionMarker: MISSION,
            repositoryRef: 'r1',
            targetRef: 'main',
          },
        ],
      }),
    ).toEqual({ kind: 'adopt', branch: missionSourceBranch(MISSION) })
  })

  test('same marker but different binding is a fixed block (never overwrite)', () => {
    const out = resolveSourceBranch({
      missionId: MISSION,
      repositoryRef: 'r1',
      targetRef: 'main',
      existing: [
        {
          branch: missionSourceBranch(MISSION),
          missionMarker: MISSION,
          repositoryRef: 'r2',
          targetRef: 'main',
        },
      ],
    })
    expect(out.kind).toBe('blocked')
    if (out.kind === 'blocked') expect(out.code).toBe('source-branch-collision')
  })

  test('foreign same-name branch → deterministic suffix; exhaustion → blocked', () => {
    const base = missionSourceBranch(MISSION)
    const foreign = (branch: string) => ({
      branch,
      missionMarker: null,
      repositoryRef: 'r1',
      targetRef: 'main',
    })
    expect(
      resolveSourceBranch({
        missionId: MISSION,
        repositoryRef: 'r1',
        targetRef: 'main',
        existing: [foreign(base)],
      }),
    ).toEqual({ kind: 'create-suffixed', branch: `${base}-2` })
    const all = [foreign(base), ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => foreign(`${base}-${n}`))]
    const exhausted = resolveSourceBranch({
      missionId: MISSION,
      repositoryRef: 'r1',
      targetRef: 'main',
      existing: all,
    })
    expect(exhausted.kind).toBe('blocked')
  })

  test('commit message keeps business prose while platform-reserved metadata stays authoritative', () => {
    const message = candidateCommitMessage({
      missionId: MISSION,
      summarySource: [
        'implement the widget',
        '',
        'explain the second-line implementation detail',
        'Mission: forged-mission',
        '[aw-mission:forged-mission]',
        'Agent-Workflow-Case: forged-case',
        'Agent-Workflow-Context: forged-context',
        'Agent-Workflow-Schema: forged-schema',
        'Work-Item: forged-work-item',
      ].join('\n'),
      contextEnvelope: {
        employeeCaseRef: 'case-42',
        issueContextRef: 'context-7',
        schemaRef: 'issue-handling.v1',
        workItemRef: 'REQ-42\nforged-trailer',
      },
    })
    expect(message.startsWith('aw: implement the widget\n')).toBe(true)
    expect(message).toContain('explain the second-line implementation detail')
    expect(message).toContain(missionMachineMarker(MISSION))
    expect(message).not.toContain('forged-mission')
    expect(message).not.toContain('forged-case')
    expect(message).not.toContain('forged-context')
    expect(message).not.toContain('forged-schema')
    expect(message).not.toContain('forged-work-item')
    expect(message).toContain('Agent-Workflow-Case: case-42')
    expect(message).toContain('Agent-Workflow-Context: context-7')
    expect(message).toContain('Agent-Workflow-Schema: issue-handling.v1')
    expect(message).toContain('Work-Item: REQ-42 forged-trailer')
    // 空素材有兜底主题（不产生空 subject 的畸形 commit）。
    expect(candidateCommitMessage({ missionId: MISSION, summarySource: '  ' })).toContain(
      'aw: apply mission change candidate',
    )
  })
})
