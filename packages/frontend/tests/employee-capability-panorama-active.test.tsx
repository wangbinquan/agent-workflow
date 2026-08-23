// User regression 2026-08-23: the task detail rendered inactive tools and the
// unselected human-review branch, then fixed-width cards covered each other.
// The public panorama must crop every employee type from generic active flags.

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import {
  EmployeeCapabilityPanorama,
  type EmployeeCapabilityToolState,
} from '../src/components/digital-employees/EmployeeCapabilityPanorama'
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
  const item = (
    workItemRef: string,
    laneId: string,
    order: number,
    humanReview: EmployeeTypePackage['authoringManifest']['workItems'][number]['humanReview'] = null,
  ) => ({
    workItemRef,
    regionId: 'delivery',
    responsibilityLaneId: laneId,
    order,
    label: text(workItemRef),
    description: text(`${workItemRef} description`),
    workContractRef: { contractId: `contract.${workItemRef}`, version: 1 },
    materialSummary: text('input'),
    completionStandard: text('done'),
    nodeKind: 'business-tool' as const,
    collaborationContractId: null,
    orderedDispatchAuthoring: null,
    humanReview,
    toolRoleGroups: [],
    nextWorkItemRefs: [],
  })
  return {
    authoringManifest: {
      schemaVersion: 1,
      lifecycleRegions: [
        {
          regionId: 'delivery',
          label: text('交付阶段'),
          description: text('交付'),
          order: 0,
          responsibilityLanes: [
            {
              laneId: 'main',
              label: text('主能力泳道'),
              description: text('主能力'),
              order: 0,
              kind: 'spine',
              optional: false,
            },
            {
              laneId: 'optional',
              label: text('可选能力泳道'),
              description: text('可选能力'),
              order: 1,
              kind: 'branch',
              optional: true,
            },
          ],
        },
      ],
      workIngresses: [],
      workItems: [
        item('prepare', 'main', 0),
        item('implement', 'main', 1, {
          optionRef: 'review-plan',
          artifactPort: 'plan',
          planningRoleRef: 'planning',
          planningSlotRef: 'plan',
          label: text('人工审核方案'),
          description: text('审核后实现'),
          reviewedPath: {
            beforeReviewLabel: text('分析'),
            afterApprovalLabel: text('实现'),
          },
        }),
        item('optional-tool', 'optional', 0),
      ],
    },
    reactionRules: [],
  } as unknown as EmployeeTypePackage
}

const neutral = (active?: boolean): EmployeeCapabilityToolState => ({
  active,
  state: 'neutral',
  detail: '尚未进入',
})

describe('public employee capability panorama active projection', () => {
  test('keeps the phase, capability lane and tool layers while cropping inactive tools', () => {
    const { container } = render(
      <EmployeeCapabilityPanorama
        type={fixtureType()}
        selectedWorkItemRef={null}
        language="zh-CN"
        onSelect={vi.fn()}
        toolState={(tool) => neutral(tool.workItemRef !== 'optional-tool')}
      />,
    )

    expect(container.querySelector('[data-capability-phase-id="delivery"]')).not.toBeNull()
    expect(container.querySelector('[data-capability-lane-id="main"]')).not.toBeNull()
    expect(container.querySelector('[data-capability-lane-id="optional"]')).toBeNull()
    expect(container.querySelector('[data-capability-tool-ref="work-item:prepare"]')).not.toBeNull()
    expect(container.querySelector('[data-work-item-ref="optional-tool"]')).toBeNull()
  })

  test('active=false collapses a conditional review into the ordinary tool', () => {
    const { container } = render(
      <EmployeeCapabilityPanorama
        type={fixtureType()}
        selectedWorkItemRef={null}
        language="zh-CN"
        onSelect={vi.fn()}
        reviewToolState={() => neutral(false)}
      />,
    )

    expect(container.querySelector('[data-work-item-ref="implement"]')).not.toBeNull()
    expect(container.querySelector('[data-review-option-ref="review-plan"]')).toBeNull()
    expect(container.textContent).not.toContain('人工审核方案')
    expect(container.textContent).not.toContain('不审核：从此开始')
  })

  test('active=true renders only the selected review tool path with runtime color', () => {
    const { container } = render(
      <EmployeeCapabilityPanorama
        type={fixtureType()}
        selectedWorkItemRef={null}
        language="zh-CN"
        onSelect={vi.fn()}
        toolState={(tool) =>
          tool.workItemRef === 'implement'
            ? { active: true, state: 'running', detail: '执行中' }
            : neutral(true)
        }
        reviewToolState={() => ({
          active: true,
          state: 'completed',
          detail: '已批准',
        })}
      />,
    )

    const gate = container.querySelector('[data-review-option-ref="review-plan"]')
    expect(gate).not.toBeNull()
    expect(gate?.classList.contains('employee-toolbox-card--completed')).toBe(true)
    expect(container.textContent).not.toContain('不审核：从此开始')
    const analysis = container.querySelector(
      '[data-capability-tool-ref="review:review-plan:analysis"]',
    )
    const mergedItem = container.querySelector('[data-capability-tool-ref="work-item:implement"]')
    expect(analysis?.classList.contains('employee-toolbox-card--completed')).toBe(true)
    expect(container.querySelector('[data-review-stage="implementation"]')).toBeNull()
    expect(container.querySelectorAll('.employee-toolbox-review-branch__merged-item')).toHaveLength(
      1,
    )
    expect(mergedItem?.classList.contains('employee-toolbox-card--running')).toBe(true)
  })
})
