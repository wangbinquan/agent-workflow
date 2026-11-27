// RFC-616 §11.3 — metric heat on the digital-employee duty map (process-metrics page).
//
// The metrics page reuses EmployeeCapabilityPanorama and colours work items by a
// metric through one optional field, `EmployeeCapabilityToolState.heat`. The
// authoring and runtime pages never set it and must keep rendering exactly what
// they rendered before. This file locks:
//   1. A `toolState` that returns `heat` puts `data-heat` on the work-item card
//      it describes — in all three projections of a work item (plain card, the
//      target of an ingress branch, the merged item of a review branch) — and on
//      nothing else.
//   2. Without `heat` the map is the heat markup minus that attribute, with and
//      without a `toolState` (golden-lock).
//   3. Only work-item cards read it: the review gate (`reviewToolState`) and the
//      review-stage tool slot (`toolSlotState`) stay uncoloured.
//   4. A heat card is still the selection target and keeps its selection state.
//   5. styles.css colours duty-map heat with the `--viz-heat-*` tokens only, one
//      token pair per step, declared after every state / hover / selection rule.

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import {
  EmployeeCapabilityPanorama,
  type EmployeeCapabilityPanoramaProps,
  type EmployeeCapabilityTool,
  type EmployeeCapabilityToolState,
} from '../src/components/digital-employees/EmployeeCapabilityPanorama'
import type { EmployeeTypePackage, WorkItem } from '../src/components/digital-employees/types'
import {
  HEAT_LEVELS,
  heatColourViolations,
  heatRules,
  markupWithoutHeat,
  parseRules,
  readStyles,
} from './rfc616-heat.helpers'

beforeAll(() => {
  // The map cancels running lane animations in a layout effect; the test DOM
  // has no Web Animations API.
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
})

afterEach(cleanup)

const text = (value: string) => ({ 'zh-CN': value, 'en-US': value })

/**
 * One lane whose three work items reach the map through its three different
 * projections: `prepare` is the target of an ingress branch, `implement` is the
 * merged item of a review branch, `verify` is a plain card.
 */
function fixtureType(): EmployeeTypePackage {
  const item = (
    workItemRef: string,
    order: number,
    humanReview: WorkItem['humanReview'] = null,
  ) => ({
    workItemRef,
    regionId: 'delivery',
    responsibilityLaneId: 'main',
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
          label: text('Delivery'),
          description: text('Delivery duties'),
          order: 0,
          responsibilityLanes: [
            {
              laneId: 'main',
              label: text('Main lane'),
              description: text('Main duties'),
              order: 0,
              kind: 'spine',
              optional: false,
            },
          ],
        },
      ],
      workIngresses: [
        {
          ingressRef: 'webhook',
          regionId: 'delivery',
          responsibilityLaneId: 'main',
          order: 0,
          label: text('Webhook'),
          valueLabel: text('Event'),
          description: text('Work arrives from a webhook'),
          sourceClass: 'manual',
          eventTypeRefs: [],
          configurationSurface: 'event-response-rules',
          nextWorkItemRef: 'prepare',
        },
      ],
      workItems: [
        item('prepare', 0),
        item('implement', 1, {
          optionRef: 'review-plan',
          artifactPort: 'plan',
          planningRoleRef: 'planning',
          planningSlotRef: 'plan',
          label: text('Review the plan'),
          description: text('Implement after approval'),
          reviewedPath: {
            beforeReviewLabel: text('Analyze'),
            afterApprovalLabel: text('Implement'),
          },
        }),
        item('verify', 2),
      ],
    },
    reactionRules: [],
  } as unknown as EmployeeTypePackage
}

type HeatStep = NonNullable<EmployeeCapabilityToolState['heat']>

const HEAT_BY_REF: Readonly<Record<string, HeatStep>> = { prepare: 1, implement: 3, verify: 5 }

/** A metrics-style `toolState`: neutral state, a detail text, and the step if any. */
function heatState(heatByRef: Readonly<Record<string, HeatStep>>) {
  return (tool: EmployeeCapabilityTool): EmployeeCapabilityToolState => ({
    state: 'neutral',
    detail: `${tool.workItemRef} detail`,
    heat: heatByRef[tool.workItemRef],
  })
}

function renderMap(props: Partial<EmployeeCapabilityPanoramaProps> = {}) {
  return render(
    <EmployeeCapabilityPanorama
      type={fixtureType()}
      selectedWorkItemRef={null}
      language="en-US"
      onSelect={vi.fn()}
      {...props}
    />,
  )
}

describe('duty map with heat', () => {
  test('toolState heat lands on the work-item card in all three projections', () => {
    const { container } = renderMap({ toolState: heatState(HEAT_BY_REF) })

    for (const [ref, step] of Object.entries(HEAT_BY_REF)) {
      const card = container.querySelector(`[data-work-item-ref="${ref}"]`)
      expect(card, ref).not.toBeNull()
      expect(card?.classList.contains('employee-toolbox-card')).toBe(true)
      expect(card?.getAttribute('data-heat')).toBe(String(step))
    }

    // The three cards really came through three different projections.
    expect(
      container.querySelector(
        '[data-ingress-branch-work-item-ref="prepare"] [data-work-item-ref="prepare"]',
      ),
    ).not.toBeNull()
    expect(
      container.querySelector(
        '[data-review-branch-work-item-ref="implement"] [data-work-item-ref="implement"]',
      ),
    ).not.toBeNull()
    const plainCard = container.querySelector('[data-work-item-ref="verify"]')
    expect(plainCard?.closest('[data-ingress-branch-work-item-ref]')).toBeNull()
    expect(plainCard?.closest('[data-review-branch-work-item-ref]')).toBeNull()
  })

  test('nothing but the work-item cards carries heat', () => {
    const { container } = renderMap({ toolState: heatState(HEAT_BY_REF) })

    const heated = Array.from(container.querySelectorAll('[data-heat]'))
    expect(heated).toHaveLength(3)
    for (const element of heated) expect(element.hasAttribute('data-work-item-ref')).toBe(true)

    // The ingress source card and both review-stage cards are on the map and
    // stay uncoloured.
    for (const selector of [
      '[data-work-ingress-ref="webhook"]',
      '[data-review-stage="analysis"]',
      '[data-review-option-ref="review-plan"]',
    ]) {
      const card = container.querySelector(selector)
      expect(card, selector).not.toBeNull()
      expect(card?.hasAttribute('data-heat')).toBe(false)
    }
  })

  test('a work item without a step stays uncoloured next to coloured ones', () => {
    const { container } = renderMap({ toolState: heatState({ verify: 5 }) })
    const heated = Array.from(container.querySelectorAll('[data-heat]'))
    expect(heated).toHaveLength(1)
    expect(heated[0]?.getAttribute('data-work-item-ref')).toBe('verify')
    expect(
      container.querySelector('[data-work-item-ref="prepare"]')?.hasAttribute('data-heat'),
    ).toBe(false)
  })

  test('each step is printed as its own attribute value', () => {
    for (const step of HEAT_LEVELS) {
      const view = renderMap({ toolState: heatState({ verify: step }) })
      expect(
        view.container.querySelector('[data-work-item-ref="verify"]')?.getAttribute('data-heat'),
      ).toBe(String(step))
      view.unmount()
    }
  })
})

describe('duty map without heat (golden-lock)', () => {
  test('a toolState without heat renders the heat markup minus the attribute', () => {
    const plain = renderMap({ toolState: heatState({}) })
    expect(plain.container.querySelectorAll('[data-work-item-ref]')).toHaveLength(3)
    expect(plain.container.querySelector('[data-heat]')).toBeNull()
    // Nothing to take out of the plain render, so this is its markup as is.
    const plainMarkup = markupWithoutHeat(plain.container)
    plain.unmount()

    const heated = renderMap({ toolState: heatState(HEAT_BY_REF) })
    expect(heated.container.querySelectorAll('[data-heat]')).toHaveLength(3)
    expect(markupWithoutHeat(heated.container)).toBe(plainMarkup)
  })

  test('no toolState at all (authoring pages) ⇒ no data-heat anywhere', () => {
    const { container } = renderMap()
    expect(container.querySelectorAll('[data-work-item-ref]')).toHaveLength(3)
    expect(container.querySelector('[data-heat]')).toBeNull()
  })

  test('only work-item cards read heat: the review gate and the tool slot ignore it', () => {
    const { container } = renderMap({
      reviewToolState: () => ({ state: 'neutral', detail: 'gate detail', heat: 4 }),
      toolSlotState: () => ({ state: 'neutral', detail: 'slot detail', heat: 4 }),
    })
    expect(container.querySelector('[data-review-option-ref="review-plan"]')).not.toBeNull()
    expect(container.querySelector('[data-review-stage="analysis"]')).not.toBeNull()
    expect(container.querySelector('[data-heat]')).toBeNull()
  })
})

describe('duty map heat and selection', () => {
  test('a heat card is still the selection target, in every projection', () => {
    const onSelect = vi.fn()
    const { container } = renderMap({ toolState: heatState(HEAT_BY_REF), onSelect })
    for (const ref of Object.keys(HEAT_BY_REF)) {
      const card = container.querySelector<HTMLElement>(`[data-work-item-ref="${ref}"]`)
      expect(card, ref).not.toBeNull()
      fireEvent.click(card!)
    }
    expect(onSelect.mock.calls).toEqual([['prepare'], ['implement'], ['verify']])
  })

  test('a selected heat card keeps both its selection state and its heat', () => {
    const { container } = renderMap({
      toolState: heatState(HEAT_BY_REF),
      selectedWorkItemRef: 'verify',
    })
    const card = container.querySelector('[data-work-item-ref="verify"]')
    expect(card?.classList.contains('employee-toolbox-card--active')).toBe(true)
    expect(card?.getAttribute('aria-pressed')).toBe('true')
    expect(card?.getAttribute('data-heat')).toBe('5')
  })

  test('workItemsReadOnly keeps the heat but disables the card, so it cannot select', () => {
    const onSelect = vi.fn()
    const { container } = renderMap({
      toolState: heatState(HEAT_BY_REF),
      onSelect,
      workItemsReadOnly: true,
    })
    const card = container.querySelector<HTMLButtonElement>('[data-work-item-ref="verify"]')
    expect(card?.getAttribute('data-heat')).toBe('5')
    expect(card?.disabled).toBe(true)
    fireEvent.click(card!)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('duty-map heat styles', () => {
  const css = readStyles()
  const rules = heatRules(css, '.employee-toolbox-card')

  test('corpus is not empty: the duty-map heat rules were actually read', () => {
    // 5 fills + the ink rule + the kind-pill rule.
    expect(rules.length).toBeGreaterThanOrEqual(7)
  })

  test('each step maps to its own token pair through the card fill variable', () => {
    for (const step of HEAT_LEVELS) {
      const selector = `.employee-toolbox-map .employee-toolbox-card[data-heat='${step}']`
      const rule = rules.find((candidate) => candidate.selector === selector)
      expect(rule, selector).toBeDefined()
      expect(rule?.declarations).toEqual([
        { property: '--employee-card-background', value: `var(--viz-heat-${step})` },
        { property: 'color', value: `var(--viz-heat-${step}-ink)` },
      ])
    }
    // …and that variable is what the card paints with.
    const base = parseRules(css).find((rule) => rule.selector === '.employee-toolbox-card')
    expect(base?.declarations).toContainEqual({
      property: 'background',
      value: 'var(--employee-card-background)',
    })
  })

  test('heat styles reference the --viz-heat-* tokens only: no other token, no literal', () => {
    expect(heatColourViolations(rules)).toEqual([])
  })

  test('the kind pill and the detail text follow the heat ink', () => {
    const ink = rules.find(
      (rule) =>
        rule.selector ===
        '.employee-toolbox-map .employee-toolbox-card[data-heat] :is(.employee-toolbox-card__kind, small)',
    )
    expect(ink?.declarations).toEqual([{ property: 'color', value: 'inherit' }])
  })

  test('the fill is declared after every state, hover and selection rule', () => {
    const fill = css.indexOf(".employee-toolbox-map .employee-toolbox-card[data-heat='1'] {")
    expect(fill).toBeGreaterThanOrEqual(0)
    for (const earlier of [
      '.employee-toolbox-card {',
      '.employee-toolbox-card:hover {',
      '.employee-toolbox-card--configured {',
      '.employee-toolbox-card--completed {',
      '.employee-toolbox-card--running {',
      '.employee-toolbox-card--failed {',
      '.employee-toolbox-card--neutral {',
      '.employee-toolbox-card--missing {',
      '.employee-toolbox-card--active:not(',
      '.employee-toolbox-card--active:is(',
    ]) {
      const index = css.lastIndexOf(earlier)
      expect(index, earlier).toBeGreaterThanOrEqual(0)
      // Later in the file AND scoped one class deeper than any of them: the heat
      // fill wins over the state, hover and selection backgrounds.
      expect(fill, earlier).toBeGreaterThan(index)
    }
  })
})
