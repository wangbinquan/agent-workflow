// RFC-201 B2/T4 — page sections are URL-backed links on wide containers and
// one grouped Select on compact containers. This suite locks model validity,
// exact aria-current ownership, one-presentation mounting, and resize focus
// handoff so 200% zoom cannot strand keyboard focus on <body>.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  PageSectionNav,
  PageSectionLink,
  assertPageSectionNavModel,
  flattenPageSectionGroups,
  type PageSectionDestinationState,
  type PageSectionGroup,
} from '../src/components/PageSectionNav'

type Key = 'runtime' | 'agents' | 'recovery' | 'gc'

const GROUPS: readonly PageSectionGroup<Key>[] = [
  {
    key: 'execution',
    label: 'Execution',
    items: [
      { key: 'runtime', label: 'Runtime', description: 'Choose the command runner' },
      { key: 'agents', label: 'System agents', badge: '1 draft' },
    ],
  },
  {
    key: 'reliability',
    label: 'Reliability',
    badge: 2,
    items: [
      { key: 'recovery', label: 'Recovery' },
      { key: 'gc', label: 'Garbage collection' },
    ],
  },
]

class TestResizeObserver {
  static instances: TestResizeObserver[] = []

  readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
  }

  resize(inlineSize: number) {
    const entries = [...this.targets].map(
      (target) =>
        ({
          target,
          contentBoxSize: [{ inlineSize, blockSize: 100 }],
          contentRect: { width: inlineSize },
        }) as unknown as ResizeObserverEntry,
    )
    this.callback(entries, this as unknown as ResizeObserver)
  }
}

beforeEach(() => {
  TestResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function latestObserver(): TestResizeObserver {
  const observer = TestResizeObserver.instances.at(-1)
  if (observer === undefined) throw new Error('expected PageSectionNav to observe its container')
  return observer
}

function makeDestinationRenderer() {
  return vi.fn((key: Key, state: PageSectionDestinationState) => (
    <a href={`/?section=${key}`} className={state.className} aria-current={state.ariaCurrent}>
      {state.children}
    </a>
  ))
}

function renderNav({
  active = 'runtime',
  presentation = 'rail',
  inlineLayout = 'stacked',
  groups = GROUPS,
  renderDestination = makeDestinationRenderer(),
  onSelectCompact = vi.fn(),
}: {
  active?: Key
  presentation?: 'rail' | 'inline'
  inlineLayout?: 'stacked' | 'single-row'
  groups?: readonly PageSectionGroup<Key>[]
  renderDestination?: ReturnType<typeof makeDestinationRenderer>
  onSelectCompact?: ReturnType<typeof vi.fn<(key: Key) => void>>
} = {}) {
  return {
    ...render(
      <PageSectionNav
        groups={groups}
        active={active}
        renderDestination={renderDestination}
        onSelectCompact={onSelectCompact}
        presentation={presentation}
        inlineLayout={inlineLayout}
        ariaLabel="Page sections"
        idPrefix="settings-sections"
      />,
    ),
    renderDestination,
    onSelectCompact,
  }
}

function resize(inlineSize: number) {
  act(() => latestObserver().resize(inlineSize))
}

describe('PageSectionNav model', () => {
  test('flattens only the capability-filtered leaves supplied by the owner', () => {
    const filtered: readonly PageSectionGroup<Key>[] = [
      { ...GROUPS[0]!, items: [GROUPS[0]!.items[0]!] },
      { ...GROUPS[1]!, items: [] },
    ]
    expect(flattenPageSectionGroups(filtered).map(({ leaf }) => leaf.key)).toEqual(['runtime'])
  })

  test('rejects duplicate group keys, duplicate leaf keys, and a non-visible active leaf', () => {
    expect(() =>
      assertPageSectionNavModel([GROUPS[0]!, { ...GROUPS[1]!, key: GROUPS[0]!.key }], 'runtime'),
    ).toThrow('duplicate group key "execution"')

    expect(() =>
      assertPageSectionNavModel(
        [GROUPS[0]!, { ...GROUPS[1]!, items: [{ key: 'runtime', label: 'Duplicate' }] }],
        'runtime',
      ),
    ).toThrow('duplicate leaf key "runtime"')

    expect(() => assertPageSectionNavModel(GROUPS, 'missing' as Key)).toThrow(
      'active leaf "missing" is not visible',
    )
  })
})

describe('PageSectionNav compact presentation', () => {
  test('starts compact, exposes a visible label and grouped accessible options, and selects once', () => {
    const { renderDestination, onSelectCompact } = renderNav({ active: 'agents' })
    const navigation = screen.getByRole('navigation', { name: 'Page sections' })

    expect(navigation.getAttribute('data-mode')).toBe('compact')
    expect(navigation.querySelector('.page-section-nav__compact')).not.toBeNull()
    expect(navigation.querySelector('.page-section-nav__rail')).toBeNull()
    expect(navigation.querySelector('.page-section-nav__inline')).toBeNull()
    expect(within(navigation).getByText('Page sections')).toBeTruthy()
    const combobox = screen.getByRole('combobox', { name: 'Page sections' })
    expect(combobox.textContent).toContain('1 draft')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(renderDestination).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('combobox', { name: 'Page sections' }))
    const listbox = screen.getByRole('listbox', { name: 'Page sections' })
    expect(listbox.querySelectorAll('.select__group')).toHaveLength(2)
    expect(within(listbox).getAllByRole('option')).toHaveLength(4)
    expect(within(listbox).getByRole('option', { name: /Runtime.*Execution/ })).toBeTruthy()
    expect(
      within(listbox).getByRole('option', { name: /System agents.*1 draft.*Execution/ }),
    ).toBeTruthy()
    expect(listbox.querySelector('.select__group .select__badge')?.textContent).toBe('2')

    fireEvent.mouseDown(within(listbox).getByRole('option', { name: /Recovery.*Reliability/ }))
    expect(onSelectCompact).toHaveBeenCalledTimes(1)
    expect(onSelectCompact).toHaveBeenCalledWith('recovery')
  })

  test('uses the exact 56rem threshold and never keeps a hidden duplicate mounted', () => {
    renderNav()
    const navigation = screen.getByRole('navigation')
    // The stable nav+panel parent is observed. Observing the eventual 220px
    // rail itself would oscillate between desktop rail and compact Select.
    expect(latestObserver().targets.has(navigation.parentElement as HTMLElement)).toBe(true)
    // happy-dom reports the unmeasured parent as 0px: compact is the required
    // fail-safe until ResizeObserver supplies a real inline size.
    expect(navigation.getAttribute('data-mode')).toBe('compact')
    resize(895)
    expect(screen.getByRole('navigation').getAttribute('data-mode')).toBe('compact')
    expect(screen.getByRole('combobox')).toBeTruthy()

    resize(896)
    expect(navigation.getAttribute('data-mode')).toBe('desktop')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(navigation.querySelector('.page-section-nav__compact')).toBeNull()
    expect(navigation.querySelector('.page-section-nav__rail')).not.toBeNull()
  })
})

describe('PageSectionNav desktop presentations', () => {
  test('rail renders real destinations and only the exact active leaf is current', () => {
    const { onSelectCompact } = renderNav({ active: 'agents' })
    resize(896)

    const navigation = screen.getByRole('navigation', { name: 'Page sections' })
    expect(navigation.getAttribute('data-presentation')).toBe('rail')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(4)
    expect(screen.getByRole('heading', { name: 'Execution' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Reliability.*2/ })).toBeTruthy()

    const current = navigation.querySelectorAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toBe(screen.getByRole('link', { name: /System agents.*1 draft/ }))
    expect(current[0]?.getAttribute('href')).toBe('/?section=agents')
    expect(onSelectCompact).not.toHaveBeenCalled()
  })

  test('inline renders group-default links plus active-group leaves without a second current', () => {
    const renderDestination = makeDestinationRenderer()
    renderNav({
      active: 'agents',
      presentation: 'inline',
      inlineLayout: 'single-row',
      renderDestination,
    })
    resize(896)

    const navigation = screen.getByRole('navigation')
    expect(navigation.querySelector('.page-section-nav__inline')).not.toBeNull()
    expect(navigation.querySelector('.page-section-nav__rail')).toBeNull()
    expect(navigation.getAttribute('data-inline-layout')).toBe('single-row')
    expect(navigation.classList.contains('page-section-nav--inline-single-row')).toBe(true)
    expect(screen.getByRole('link', { name: 'Execution' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('link', { name: /Reliability.*2/ }).getAttribute('href')).toBe(
      '/?section=recovery',
    )

    const current = navigation.querySelectorAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toBe(screen.getByRole('link', { name: /System agents.*1 draft/ }))
    expect(renderDestination.mock.calls.map(([key]) => key)).toEqual([
      'runtime',
      'recovery',
      'runtime',
      'agents',
    ])
  })

  test('owner-driven active changes update aria-current without mounting compact navigation', () => {
    const renderDestination = makeDestinationRenderer()
    const onSelectCompact = vi.fn<(key: Key) => void>()
    const view = renderNav({ renderDestination, onSelectCompact })
    resize(896)

    view.rerender(
      <PageSectionNav
        groups={GROUPS}
        active="gc"
        renderDestination={renderDestination}
        onSelectCompact={onSelectCompact}
        presentation="rail"
        ariaLabel="Page sections"
        idPrefix="settings-sections"
      />,
    )

    expect(
      screen.getByRole('link', { name: 'Garbage collection' }).getAttribute('aria-current'),
    ).toBe('page')
    expect(screen.getByRole('link', { name: /Runtime/ }).getAttribute('aria-current')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(onSelectCompact).not.toHaveBeenCalled()
  })

  test('TanStack-backed group and leaf links keep exactly one current-page owner', async () => {
    type InlineKey = 'runtime' | 'limits'
    const inlineGroups: readonly PageSectionGroup<InlineKey>[] = [
      {
        key: 'execution',
        label: 'Execution',
        items: [
          { key: 'runtime', label: 'Runtime' },
          { key: 'limits', label: 'Limits' },
        ],
      },
    ]
    const rootRoute = createRootRoute()
    const settingsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/settings',
      component: () => (
        <PageSectionNav<InlineKey>
          groups={inlineGroups}
          active="runtime"
          presentation="inline"
          ariaLabel="Settings sections"
          idPrefix="inline-settings"
          onSelectCompact={() => {}}
          renderDestination={(key, destination) => (
            <PageSectionLink
              to="/settings"
              search={(previous) => ({ ...previous, tab: key })}
              className={destination.className}
              pageSectionCurrent={destination.ariaCurrent}
            >
              {destination.children}
            </PageSectionLink>
          )}
        />
      ),
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([settingsRoute]),
      history: createMemoryHistory({ initialEntries: ['/settings?tab=runtime'] }),
    })

    render(
      // The focused test router intentionally differs from the generated app tree.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <RouterProvider router={router as any} />,
    )
    await router.load()
    resize(896)

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' })
    const current = navigation.querySelectorAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toBe(screen.getByRole('link', { name: 'Runtime' }))
    const groupLink = screen.getByRole('link', { name: 'Execution' })
    expect(groupLink.hasAttribute('aria-current')).toBe(false)
    expect(groupLink.hasAttribute('data-status')).toBe(false)
    expect(groupLink.classList.contains('active')).toBe(false)
  })
})

describe('PageSectionNav resize focus handoff', () => {
  test('moves focus between the compact selector and the exact current destination', () => {
    renderNav({ active: 'agents' })
    const compactSelect = screen.getByRole('combobox', { name: 'Page sections' })
    compactSelect.focus()

    resize(896)
    const currentLink = screen.getByRole('link', { name: /System agents.*1 draft/ })
    expect(document.activeElement).toBe(currentLink)

    resize(895)
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Page sections' }))
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  test('does not steal focus when resize replaces navigation that was not focused', () => {
    render(
      <>
        <button type="button">Outside</button>
        <PageSectionNav
          groups={GROUPS}
          active="runtime"
          renderDestination={makeDestinationRenderer()}
          onSelectCompact={() => {}}
          presentation="rail"
          ariaLabel="Page sections"
          idPrefix="settings-sections"
        />
      </>,
    )
    const outside = screen.getByRole('button', { name: 'Outside' })
    outside.focus()
    resize(896)
    expect(document.activeElement).toBe(outside)
  })

  test('Back/Forward-style active changes recover focus only when the old panel unmounts it', () => {
    const renderDestination = makeDestinationRenderer()
    const nav = (active: Key) => (
      <div>
        <PageSectionNav
          groups={GROUPS}
          active={active}
          renderDestination={renderDestination}
          onSelectCompact={() => {}}
          presentation="rail"
          ariaLabel="Page sections"
          idPrefix="settings-sections"
        />
        <section key={active}>
          <input aria-label={`${active} field`} />
        </section>
      </div>
    )
    const view = render(nav('runtime'))
    resize(896)
    const formerField = screen.getByRole('textbox', { name: 'runtime field' })
    formerField.focus()

    view.rerender(nav('gc'))

    expect(formerField.isConnected).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Garbage collection' }))
  })

  test('Back/Forward-style active changes recover focus when a kept panel becomes hidden', () => {
    const renderDestination = makeDestinationRenderer()
    const nav = (active: Key) => (
      <div>
        <PageSectionNav
          groups={GROUPS}
          active={active}
          renderDestination={renderDestination}
          onSelectCompact={() => {}}
          presentation="rail"
          ariaLabel="Page sections"
          idPrefix="settings-sections"
        />
        <section hidden={active !== 'runtime'}>
          <input aria-label="runtime field" />
        </section>
        <section hidden={active !== 'gc'}>
          <input aria-label="gc field" />
        </section>
      </div>
    )
    const view = render(nav('runtime'))
    resize(896)
    const formerField = screen.getByRole('textbox', { name: 'runtime field' })
    formerField.focus()

    view.rerender(nav('gc'))

    expect(formerField.isConnected).toBe(true)
    expect(formerField.closest('section')?.hidden).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Garbage collection' }))
  })
})
