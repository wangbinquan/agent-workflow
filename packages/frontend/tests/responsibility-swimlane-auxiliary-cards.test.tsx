// User regression 2026-08-23: the responsibility panorama collapsed direct
// description/document intake and external-ID intake into one source card,
// then routed both through material preparation. Keep all three public inputs
// and their distinct graph edges visible.

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { ResponsibilitySwimlaneMap } from '../src/components/digital-employees/ResponsibilitySwimlaneMap'
import type { EmployeeTypePackage } from '../src/components/digital-employees/types'

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
})

afterEach(cleanup)

const text = (value: string) => ({ 'zh-CN': value, 'en-US': value })

function fixtureType(): EmployeeTypePackage {
  return {
    workIntakeAuthoring: {
      acceptedKinds: ['body', 'files', 'body-and-files', 'external-id'],
      kindRequirements: [{ kind: 'external-id', workItemRef: 'prepare', slotRef: 'default' }],
      externalId: {
        description: text('从界面输入外部 ID'),
      },
    },
    authoringManifest: {
      schemaVersion: 1,
      lifecycleRegions: [
        {
          regionId: 'delivery',
          label: text('交付'),
          description: text('交付阶段'),
          order: 0,
          responsibilityLanes: [
            {
              laneId: 'main',
              label: text('主线'),
              description: text('主职责'),
              order: 0,
              kind: 'spine',
              optional: false,
            },
          ],
        },
      ],
      workIngresses: [
        {
          ingressRef: 'ui-input',
          regionId: 'delivery',
          responsibilityLaneId: 'main',
          order: 0,
          label: text('界面输入'),
          valueLabel: text('任务'),
          description: text('从新建任务界面接活'),
          sourceClass: 'manual',
          eventTypeRefs: [],
          configurationSurface: 'task-creation',
          nextWorkItemRef: 'prepare',
        },
        {
          ingressRef: 'issue',
          regionId: 'delivery',
          responsibilityLaneId: 'main',
          order: 10,
          label: text('ISSUE'),
          valueLabel: text('Webhook'),
          description: text('从 ISSUE Webhook 接活'),
          sourceClass: 'issue',
          eventTypeRefs: [{ id: 'support.ticket.received', revision: 1 }],
          configurationSurface: 'event-response-rules',
          nextWorkItemRef: 'prepare',
        },
      ],
      workItems: [
        {
          workItemRef: 'prepare',
          regionId: 'delivery',
          responsibilityLaneId: 'main',
          order: 10,
          label: text('准备工作材料'),
          description: text('准备界面或 ISSUE 材料'),
          workContractRef: { contractId: 'support.prepare', version: 1 },
          materialSummary: text('输入'),
          completionStandard: text('材料已准备'),
          nodeKind: 'business-tool',
          collaborationContractId: null,
          orderedDispatchAuthoring: null,
          humanReview: null,
          toolRoleGroups: [],
          nextWorkItemRefs: ['analyze'],
        },
        {
          workItemRef: 'analyze',
          regionId: 'delivery',
          responsibilityLaneId: 'main',
          order: 20,
          label: text('分析与实现'),
          description: text('分析问题并实现修改'),
          workContractRef: { contractId: 'support.analyze', version: 1 },
          materialSummary: text('工单'),
          completionStandard: text('问题已处理'),
          nodeKind: 'business-tool',
          collaborationContractId: null,
          orderedDispatchAuthoring: null,
          humanReview: {
            optionRef: 'review-plan',
            artifactPort: 'plan',
            planningRoleRef: 'planning',
            planningSlotRef: 'plan',
            label: text('人工审核方案'),
            description: text('批准后才实现'),
            reviewedPath: {
              beforeReviewLabel: text('方案分析'),
              afterApprovalLabel: text('分析与实现'),
            },
          },
          toolRoleGroups: [],
          nextWorkItemRefs: [],
        },
      ],
    },
    reactionRules: [],
  } as unknown as EmployeeTypePackage
}

describe('ResponsibilitySwimlaneMap auxiliary cards', () => {
  test('runtime review collapse still renders every projected ingress exactly once', () => {
    const { container } = render(
      <ResponsibilitySwimlaneMap
        type={fixtureType()}
        selectedWorkItemRef={null}
        language="en-US"
        onSelect={vi.fn()}
        reviewGateState={() => ({
          active: false,
          state: 'neutral',
          detail: 'Not selected',
        })}
      />,
    )

    expect(container.querySelectorAll('[data-work-ingress-ref]')).toHaveLength(3)
    for (const ingressRef of ['ui-input:direct', 'ui-input:external-id', 'issue']) {
      expect(container.querySelectorAll(`[data-work-ingress-ref="${ingressRef}"]`)).toHaveLength(1)
    }
    expect(container.querySelectorAll('[data-work-item-ref="prepare"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-work-item-ref="analyze"]')).toHaveLength(1)
    expect(container.querySelector('[data-review-option-ref="review-plan"]')).toBeNull()
  })

  test('renders generic ingress and human-review projections outside executable work items', () => {
    const onSelect = vi.fn()
    const onConfigureIngress = vi.fn()
    const onSelectReviewGate = vi.fn()
    const { container } = render(
      <ResponsibilitySwimlaneMap
        type={fixtureType()}
        selectedWorkItemRef={null}
        language="zh-CN"
        onSelect={onSelect}
        onConfigureIngress={onConfigureIngress}
        onSelectReviewGate={onSelectReviewGate}
        reviewGateState={() => ({
          state: 'waiting',
          detail: '等待人工审核',
          compactDetail: '等待审核',
        })}
      />,
    )

    expect(container.querySelectorAll('[data-work-item-ref]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-work-ingress-ref]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-review-option-ref]')).toHaveLength(1)
    expect(container.textContent).toContain('输入描述/文档')
    expect(container.textContent).toContain('输入 ID')
    expect(container.textContent).toContain('ISSUE')
    expect(container.textContent).toContain('分析与实现')
    expect(container.textContent).toContain('无需人工审核')
    expect(container.textContent).toContain('需人工审核')
    expect(container.textContent).toContain('人工审核方案')
    expect(
      Array.from(
        container.querySelectorAll(
          '.employee-toolbox-review-branch__reviewed-flow .employee-toolbox-card strong',
        ),
        (label) => label.textContent,
      ),
    ).toEqual(['方案分析', '人工审核方案'])
    expect(
      Array.from(
        container.querySelectorAll(
          '.employee-toolbox-review-branch__reviewed-flow .employee-toolbox-card__kind',
        ),
        (label) => label.textContent,
      ),
    ).toEqual(['工具', '审核'])
    expect(container.querySelector('[data-review-stage="implementation"]')).toBeNull()
    expect(container.querySelectorAll('.employee-toolbox-review-branch__merged-item')).toHaveLength(
      1,
    )
    expect(
      container.querySelector(
        '.employee-toolbox-review-branch__prefix .employee-toolbox-review-branch__merged-item',
      ),
    ).toBeNull()
    expect(container.querySelector('[data-review-bypass]')).not.toBeNull()
    expect(container.querySelector('[data-review-bypass-join]')).not.toBeNull()
    expect(container.querySelector('.employee-toolbox-review-branch__direct-label')).toBeNull()
    expect(container.querySelectorAll('[data-work-item-ref="analyze"]')).toHaveLength(1)
    expect(
      Array.from(container.querySelectorAll('[data-work-ingress-ref]'), (card) =>
        card.getAttribute('data-next-work-item-ref'),
      ),
    ).toEqual(['analyze', 'prepare', 'analyze'])
    expect(container.querySelector('[data-ingress-branch-work-item-ref="prepare"]')).not.toBeNull()
    expect(container.querySelector('[data-work-ingress-ref="ui-input:direct"] small')).toBeNull()
    expect(
      container.querySelector('[data-work-ingress-ref="ui-input:external-id"] small'),
    ).toBeNull()
    expect(container.querySelector('[data-work-ingress-ref="issue"] small')).toBeNull()
    expect(container.querySelector('.employee-toolbox-ingress-branch__merge')).not.toBeNull()
    expect(
      container.querySelector(
        '[data-responsibility-flow-connector="ingress-target"]' +
          '[data-ingress-route-arrow-to="prepare"]',
      ),
    ).not.toBeNull()
    const ingressRoutes = Array.from(
      container.querySelectorAll('[data-ingress-route-from]'),
      (route) => [
        route.getAttribute('data-ingress-route-from'),
        route.getAttribute('data-ingress-route-to'),
      ],
    )
    expect(ingressRoutes).toHaveLength(3)
    expect(ingressRoutes).toEqual(
      expect.arrayContaining([
        ['ui-input:direct', 'analyze'],
        ['ui-input:external-id', 'prepare'],
        ['issue', 'analyze'],
      ]),
    )
    expect(
      Array.from(container.querySelectorAll('[data-ingress-route-arrow-to]'), (arrow) =>
        arrow.getAttribute('data-ingress-route-arrow-to'),
      ),
    ).toEqual(['prepare'])
    expect(container.querySelectorAll('[data-flow-arrow]').length).toBeGreaterThan(0)
    expect(
      Array.from(container.querySelectorAll('[data-flow-arrow]')).every(
        (arrow) => arrow.getAttribute('class') === 'employee-responsibility-flow-connector__arrow',
      ),
    ).toBe(true)

    fireEvent.click(container.querySelector('[data-work-ingress-ref="ui-input:direct"]')!)
    expect(onConfigureIngress).toHaveBeenCalledWith(
      expect.objectContaining({ ingressRef: 'ui-input', nextWorkItemRef: 'prepare' }),
    )
    fireEvent.click(container.querySelector('[data-work-ingress-ref="ui-input:external-id"]')!)
    expect(onConfigureIngress).toHaveBeenCalledWith(
      expect.objectContaining({ ingressRef: 'ui-input', nextWorkItemRef: 'prepare' }),
    )
    fireEvent.click(container.querySelector('[data-work-ingress-ref="issue"]')!)
    expect(onConfigureIngress).toHaveBeenCalledWith(
      expect.objectContaining({ ingressRef: 'issue', nextWorkItemRef: 'prepare' }),
    )
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(container.querySelector('[data-review-option-ref="review-plan"]')!)
    expect(onSelectReviewGate).toHaveBeenCalledWith(
      expect.objectContaining({ parentWorkItemRef: 'analyze', optionRef: 'review-plan' }),
    )
    expect(onSelect).not.toHaveBeenCalled()
  })
})
