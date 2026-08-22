// RFC-310 T121 —— `/code`（数字员工）业务页的确定性视觉夹具。
//
// 为什么是 route 拦截而不是真播种：这几页的真实数据里全是 ULID、相对时间、
// 运行时长——播出来的页面每次跑都不一样，像素基线一天都活不下去。既有的
// `operations-surface-fixtures` / `task-operations-fixtures` 用的就是这条路子：
// 把列表端点用固定 JSON 顶掉，页面渲染的一切都由本文件决定。
//
// 覆盖面（与 plan.md §T121 一致）：`/code` 首页导航、员工列表（有/无内容两态）、
// 执行器库、规则集列表、指派列表。独立 `/code/outcomes` 已由 RFC-310 T212
// 退役，运行成效改由当前数字员工卡片的专属视觉场景覆盖。

import type { Page } from '@playwright/test'

/** 一切相对时间的锚点：夹具里不出现 `Date.now()`。 */
export const CODE_SURFACE_VISUAL_TIME = new Date('2026-08-01T12:00:00.000Z')

const T = CODE_SURFACE_VISUAL_TIME.getTime()

function identity(
  id: string,
  name: string,
  publishedRevision: number | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    publishedRevision,
    ownerUserId: 'owner-1',
    visibility: 'private',
    createdAt: T - 30 * 86_400_000,
    updatedAt: T - 86_400_000,
    archivedAt: null,
    ...extra,
  }
}

export function codeEmployeesFixture(): Record<string, unknown>[] {
  return [
    identity('emp-java-delivery', 'Java delivery employee', 3, {
      description:
        'Implements requirement bundles and repairs failing pipelines for the payments monolith.',
      businessStatus: 'enabled',
      stepCount: 5,
    }),
    identity('emp-cpp-maintenance', 'C++ maintenance employee', 1, {
      description:
        'Applies review feedback and resolves merge conflicts on the device firmware repos.',
      businessStatus: 'enabled',
      stepCount: 3,
    }),
    identity('emp-docs-draft', 'Documentation employee', null, {
      description: 'Draft — not published yet.',
      businessStatus: 'disabled',
      stepCount: 2,
    }),
  ]
}

export function codeActionTemplatesFixture(): Record<string, unknown>[] {
  return [
    identity('tpl-implement', 'Java implement change', 4, {
      capabilityId: 'change.implement',
      executorKind: 'agent',
    }),
    identity('tpl-review-fix', 'Apply review feedback', 2, {
      capabilityId: 'mr.feedback.apply',
      executorKind: 'agent',
    }),
    identity('tpl-conflict', 'Resolve merge conflict', 1, {
      capabilityId: 'conflict.repair',
      executorKind: 'agent',
    }),
    identity('tpl-format', 'Run repository formatter', 6, {
      capabilityId: 'change.implement',
      executorKind: 'script',
    }),
  ]
}

export function codeAdaptersFixture(): Record<string, unknown>[] {
  return [
    identity('adapter-jira', 'Jira requirement source', 2, { purpose: 'requirement-source' }),
    identity('adapter-approval', 'Change advisory approval', 1, { purpose: 'approval' }),
  ]
}

export function codePoliciesFixture(): Record<string, unknown>[] {
  return [
    identity('pol-default', 'Default delivery rules', 5),
    identity('pol-firmware', 'Firmware conservative rules', 2),
    identity('pol-draft', 'Weekend batch rules (draft)', null),
  ]
}

export function codeAssignmentsFixture(): Record<string, unknown>[] {
  return [
    {
      scopeKind: 'global-default',
      scopeRef: null,
      employeeId: 'emp-java-delivery',
      employeeRevision: 3,
      selectionPolicyId: 'pol-default',
      selectionPolicyRevision: 5,
      executionPolicyId: 'pol-default',
      executionPolicyRevision: 5,
      defaultRequirementSourceKey: null,
    },
    {
      scopeKind: 'repository-group',
      scopeRef: 'group-firmware',
      employeeId: 'emp-cpp-maintenance',
      employeeRevision: 1,
      selectionPolicyId: 'pol-firmware',
      selectionPolicyRevision: 2,
      executionPolicyId: 'pol-firmware',
      executionPolicyRevision: 2,
      defaultRequirementSourceKey: 'jira',
    },
    {
      scopeKind: 'repository',
      scopeRef: 'repo-payments',
      employeeId: 'emp-java-delivery',
      employeeRevision: 3,
      selectionPolicyId: 'pol-default',
      selectionPolicyRevision: 5,
      executionPolicyId: 'pol-default',
      executionPolicyRevision: 5,
      defaultRequirementSourceKey: 'jira',
    },
  ]
}

/**
 * 首页导航投影：停在「设置范围」这一步。
 *
 * 特意不用零配置那一版——零配置只渲染第一步高亮，等于只锁了一小块；停在中段
 * 才同时有 done / current / next / pending 四种步骤态，把步骤条真正画满。
 */
export function codeSetupJourneyFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    journey: 'employee-setup',
    // key / detailKey / step key 全部照 `domain/journeyProjection.ts` 的真值取，
    // 编不出来的 key 会被 i18n 的 defaultValue 原样渲染成裸串——那种基线锁的是
    // 「文案坏了」的样子，不是产品的样子。
    current: { key: 'assign', ordinal: 3, total: 4, detailKey: 'setupAssignDetail' },
    next: {
      key: 'assignRepository',
      kind: 'navigate',
      detailKey: 'assignRepositoryDetail',
      owner: 'current-user',
      href: '/code/assignments?create=1&employee=emp-java-delivery',
      command: null,
      available: true,
      unavailableReason: null,
      wake: { source: null, resumeAt: null, deadlineAt: null, descriptionKey: null },
    },
    steps: [
      { key: 'define', state: 'done', owner: 'current-user', href: '/code/config/employees' },
      {
        key: 'publish',
        state: 'done',
        owner: 'current-user',
        href: '/code/config/employees/emp-java-delivery',
      },
      { key: 'assign', state: 'current', owner: 'current-user', href: '/code/assignments' },
      { key: 'launch', state: 'next', owner: 'current-user', href: null },
    ],
    reasonRefs: ['employee:emp-java-delivery@3'],
    projectionRevision: 'visual-fixture',
  }
}

/**
 * 终态 Mission 清单（RFC-311 之后：服务端收敛 + keyset 翻页 + 服务端 counts）。
 *
 * `nextCursor` 故意给成非空——「加载更多」是 RFC-311 新加的元素，只有 `hasNextPage`
 * 时才出现；给成 null 就永远锁不到它。counts 也故意与已加载行数**不相等**（22 > 6），
 * 这正是 RFC-311 修掉的那个 bug 的形状：统计若退回数已加载的行，这张基线会当场变。
 */
export function codeOutcomeMissionsFixture(): Record<string, unknown> {
  const mission = (
    id: string,
    status: string,
    employeeId: string | null,
    repositoryId: string,
    ageDays: number,
  ): Record<string, unknown> => ({
    id,
    status,
    automationMode: 'active',
    repositoryId,
    sourceKind: 'external-reference',
    externalId: null,
    deliveryKind: 'create-merge-request',
    employeeId,
    blockCode: null,
    terminalKind: status,
    createdAt: T - (ageDays + 1) * 86_400_000,
    updatedAt: T - ageDays * 86_400_000,
  })
  return {
    items: [
      mission('01MISSIONAAAAAAAAAAAAAA01', 'merged', 'emp-java-delivery', 'repo-payments', 1),
      mission('01MISSIONAAAAAAAAAAAAAA02', 'merged', 'emp-java-delivery', 'repo-payments', 2),
      mission(
        '01MISSIONAAAAAAAAAAAAAA03',
        'completed-no-change',
        'emp-cpp-maintenance',
        'repo-firmware',
        3,
      ),
      mission('01MISSIONAAAAAAAAAAAAAA04', 'failed', 'emp-java-delivery', 'repo-payments', 4),
      mission(
        '01MISSIONAAAAAAAAAAAAAA05',
        'closed-unmerged',
        'emp-cpp-maintenance',
        'repo-firmware',
        5,
      ),
      mission('01MISSIONAAAAAAAAAAAAAA06', 'canceled', null, 'repo-payments', 6),
    ],
    nextCursor: 'visual-fixture-cursor',
    counts: {
      merged: 12,
      'completed-no-change': 3,
      'closed-unmerged': 2,
      canceled: 1,
      failed: 4,
    },
  }
}

export function codeMetricsFixture(): Record<string, unknown> {
  return {
    windowMs: 30 * 86_400_000,
    adoption: [
      {
        capability: 'change.implement',
        published: 18,
        adopted: 14,
        quietFix: 3,
        disagreed: 1,
        outstanding: 2,
      },
      {
        capability: 'mr.feedback.apply',
        published: 9,
        adopted: 8,
        quietFix: 1,
        disagreed: 0,
        outstanding: 0,
      },
      {
        capability: 'conflict.repair',
        published: 4,
        adopted: 3,
        quietFix: 0,
        disagreed: 1,
        outstanding: 1,
      },
    ],
    runs: [
      {
        capability: 'change.implement',
        rounds: 26,
        published: 18,
        failed: 5,
        awaiting: 2,
        incomplete: 1,
      },
      {
        capability: 'mr.feedback.apply',
        rounds: 11,
        published: 9,
        failed: 1,
        awaiting: 1,
        incomplete: 0,
      },
      {
        capability: 'conflict.repair',
        rounds: 6,
        published: 4,
        failed: 2,
        awaiting: 0,
        incomplete: 0,
      },
    ],
  }
}

async function fulfillGet(page: Page, pattern: RegExp, json: unknown): Promise<void> {
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({ json: json as Record<string, unknown> })
  })
}

/**
 * 装载 `/code` 业务页的全部只读端点。
 *
 * `employees: 'empty'` 只把员工列表换成空集——零配置首屏是真实用户见到的第一页，
 * 它的空状态与有内容态是两套完全不同的布局，各锁一张。
 */
export async function routeCodeSurfaceFixtures(
  page: Page,
  options: { employees?: 'populated' | 'empty' } = {},
): Promise<void> {
  const employees = options.employees === 'empty' ? [] : codeEmployeesFixture()
  await fulfillGet(page, /\/api\/code\/setup-journey(?:\?.*)?$/, codeSetupJourneyFixture())
  await fulfillGet(page, /\/api\/code\/digital-employees(?:\?.*)?$/, { items: employees })
  await fulfillGet(page, /\/api\/code\/action-templates(?:\?.*)?$/, {
    items: codeActionTemplatesFixture(),
  })
  await fulfillGet(page, /\/api\/code\/automation-policies(?:\?.*)?$/, {
    items: codePoliciesFixture(),
  })
  await fulfillGet(page, /\/api\/code\/verification-profiles(?:\?.*)?$/, { items: [] })
  await fulfillGet(page, /\/api\/integrations\/development-adapters(?:\?.*)?$/, {
    items: codeAdaptersFixture(),
  })
  await fulfillGet(page, /\/api\/code\/repository-assignments(?:\?.*)?$/, {
    items: codeAssignmentsFixture(),
  })
  await fulfillGet(page, /\/api\/cached-repos(?:\?.*)?$/, {
    items: [
      { id: 'repo-payments', urlRedacted: 'https://github.com/example/payments-monolith.git' },
      { id: 'repo-firmware', urlRedacted: 'https://github.com/example/device-firmware.git' },
    ],
  })
  await fulfillGet(page, /\/api\/repo-groups(?:\?.*)?$/, {
    items: [{ id: 'group-firmware', name: 'Firmware repositories' }],
  })
  await fulfillGet(page, /\/api\/code\/missions(?:\?.*)?$/, codeOutcomeMissionsFixture())
  await fulfillGet(page, /\/api\/code\/metrics(?:\?.*)?$/, codeMetricsFixture())
}
