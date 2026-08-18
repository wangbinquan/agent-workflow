// RFC-310 PR-5 T59 —— DeliveryPolicy 纯判定矩阵（design §9.0）。
//
// 锁：分支名由平台模板生成（Agent 不供名）；碰撞闭集——同 marker 同绑定幂等
// adopt / 同 marker 异绑定 blocked / 普通同名 deterministic suffix / 后缀耗尽
// blocked；marker 反解 round-trip；commit message 模板只吃 summary 素材首行。

import { describe, expect, test } from 'bun:test'

import {
  candidateCommitMessage,
  missionMachineMarker,
  missionMarkerOfBranch,
  missionSourceBranch,
  resolveSourceBranch,
} from '../src/modules/source-control/domain/deliveryPolicy'

const MISSION = '01M09TESTULID000000000000A'

describe('rfc310 pr5 — delivery policy', () => {
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

  test('commit message is platform-templated: first line of the summary source only, marker appended', () => {
    const message = candidateCommitMessage({
      missionId: MISSION,
      summarySource: 'implement the widget\nignore this second line entirely',
    })
    expect(message.startsWith('aw: implement the widget\n')).toBe(true)
    expect(message).toContain(missionMachineMarker(MISSION))
    expect(message).not.toContain('second line')
    // 空素材有兜底主题（不产生空 subject 的畸形 commit）。
    expect(candidateCommitMessage({ missionId: MISSION, summarySource: '  ' })).toContain(
      'aw: apply mission change candidate',
    )
  })
})
