import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ManagedLiveRegionProvider } from '../src/components/ManagedLiveRegion'
import { RuntimeParameterPicker } from '../src/components/RuntimeParameterPicker'
import type { RuntimeParameterEntry } from '../src/components/runtime-parameters/catalog'
import type { RuntimeParameterTarget } from '../src/components/runtime-parameters/target'
import '../src/i18n'

afterEach(cleanup)

const entries: RuntimeParameterEntry[] = [
  {
    id: 'global:trigger:webhook:context:comment_text',
    token: '{{trigger.webhook.comment_text}}',
    label: '评论正文',
    description: 'Webhook 评论事件的正文。',
    path: {
      scope: 'global',
      type: 'trigger',
      source: 'webhook',
      group: 'context',
      field: 'comment_text',
    },
    pathLabels: ['全局参数', '触发参数', 'Webhook', '事件上下文'],
  },
  {
    id: 'local:node:input:artifact',
    token: '{{artifact}}',
    label: '输入端口：artifact',
    description: '来自上游节点的文本。',
    path: {
      scope: 'local',
      type: 'node',
      source: 'current-node',
      group: 'input',
      field: 'artifact',
    },
    pathLabels: ['局部参数', '当前节点', '当前节点输入', '输入端口'],
  },
]

function target(over: Partial<RuntimeParameterTarget> = {}): RuntimeParameterTarget {
  return {
    id: 'agent:prompt',
    label: 'Prompt 模板',
    mode: 'insert-at-caret',
    value: 'fix this',
    revision: 1,
    commit: vi.fn(),
    ...over,
  }
}

function view(props: { target?: RuntimeParameterTarget; entries?: RuntimeParameterEntry[] } = {}) {
  const current = props.target ?? target()
  return render(
    <ManagedLiveRegionProvider>
      <button type="button">Before</button>
      <RuntimeParameterPicker
        authority={
          current.mode === 'replace-whole-value' ? 'workflow:http-param' : 'workflow:model-prompt'
        }
        entries={props.entries ?? entries}
        target={current}
        testId="parameter-picker"
      />
      <button type="button">After</button>
    </ManagedLiveRegionProvider>,
  )
}

describe('RFC-295 RuntimeParameterPicker', () => {
  test('default surface is one target-labelled action; rows show label, token and explanation', async () => {
    view()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    const trigger = screen.getByTestId('parameter-picker')
    expect(trigger.getAttribute('aria-label')).toContain('Prompt 模板')
    fireEvent.click(trigger)

    expect(await screen.findByRole('listbox')).toBeTruthy()
    expect(screen.getByRole('option', { name: /全局参数|Global parameters/ })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'comment_text' } })
    expect(screen.getByText('评论正文')).toBeTruthy()
    expect(screen.getByText('{{trigger.webhook.comment_text}}')).toBeTruthy()
    expect(screen.getByText('Webhook 评论事件的正文。')).toBeTruthy()
    expect(screen.getByText('全局参数 / 触发参数 / Webhook / 事件上下文')).toBeTruthy()
  })

  test('captures the target selection before focus moves, inserts and announces', async () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.value = 'fix this'
    textarea.setSelectionRange(4, 8)
    const current = target({ element: textarea })
    view({ target: current })

    const trigger = screen.getByTestId('parameter-picker')
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.click(trigger)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'artifact' } })
    fireEvent.click(screen.getByRole('option', { name: /输入端口：artifact/ }))

    expect(current.commit).toHaveBeenCalledWith('fix {{artifact}}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByTestId('managed-live-region').textContent).toContain('输入端口：artifact')
    textarea.remove()
  })

  test('searches descriptions and brace-free canonical tokens', async () => {
    view()
    fireEvent.click(screen.getByTestId('parameter-picker'))
    const search = await screen.findByRole('combobox')
    fireEvent.change(search, { target: { value: '上游节点' } })
    expect(screen.getAllByRole('option', { name: /artifact/ })).toHaveLength(1)
    expect(screen.getByText('输入端口：artifact')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'trigger.webhook.comment_text' } })
    expect(screen.getAllByRole('option', { name: /comment_text/ })).toHaveLength(1)
    expect(screen.getByText('评论正文')).toBeTruthy()
  })

  test('Arrow/Home/End navigate action buttons and Enter inserts the active row', async () => {
    const current = target()
    view({ target: current })
    fireEvent.click(screen.getByTestId('parameter-picker'))
    const search = await screen.findByRole('combobox')
    fireEvent.change(search, { target: { value: 'artifact' } })
    fireEvent.keyDown(search, { key: 'End' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(current.commit).toHaveBeenCalledWith('fix this{{artifact}}')
  })

  test('IME Escape is contained; a later Escape closes and does not reach an outer dialog', async () => {
    const outer = vi.fn()
    view()
    document.addEventListener('keydown', outer)
    fireEvent.click(screen.getByTestId('parameter-picker'))
    const search = await screen.findByRole('combobox')
    fireEvent.compositionStart(search)
    fireEvent.keyDown(search, { key: 'Escape', isComposing: true })
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(outer).not.toHaveBeenCalled()
    fireEvent.compositionEnd(search)
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('parameter-picker'))
    document.removeEventListener('keydown', outer)
  })

  test('Tab closes the body portal and follows the trigger logical order', async () => {
    view()
    fireEvent.click(screen.getByTestId('parameter-picker'))
    const search = await screen.findByRole('combobox')
    fireEvent.keyDown(search, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))
  })

  test('value/revision changes after opening fail the CAS without overwriting', async () => {
    const initial = target()
    const rendered = view({ target: initial })
    fireEvent.click(screen.getByTestId('parameter-picker'))
    await screen.findByRole('listbox')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'comment_text' } })
    const changed = target({ value: 'remote edit', revision: 2 })
    rendered.rerender(
      <ManagedLiveRegionProvider>
        <button type="button">Before</button>
        <RuntimeParameterPicker
          authority="workflow:model-prompt"
          entries={entries}
          target={changed}
          testId="parameter-picker"
        />
        <button type="button">After</button>
      </ManagedLiveRegionProvider>,
    )
    fireEvent.click(screen.getByRole('option', { name: /评论正文/ }))
    expect(changed.commit).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('alert').textContent).not.toBe(''))
  })

  test('whole-value targets state replacement semantics and commit the canonical token', async () => {
    const current = target({ mode: 'replace-whole-value', value: 'success' })
    view({ target: current })
    expect(screen.getByText(/替换|replaces/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('parameter-picker'))
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'comment_text' } })
    fireEvent.click(screen.getByRole('option', { name: /评论正文/ }))
    expect(current.commit).toHaveBeenCalledWith('{{trigger.webhook.comment_text}}')
  })

  test('an empty filtered catalog still explains the empty state', async () => {
    view({ entries: [] })
    fireEvent.click(screen.getByTestId('parameter-picker'))
    expect(await screen.findByText(/不能插入|cannot be inserted/)).toBeTruthy()
  })

  test('keeps the full scope → type → source → group breadcrumb while compressing singletons', async () => {
    view()
    fireEvent.click(screen.getByTestId('parameter-picker'))
    fireEvent.click(await screen.findByRole('option', { name: /全局参数|Global parameters/ }))
    expect(
      screen.getByText(
        /全局参数.*触发参数.*Webhook.*事件上下文|Global parameters.*Trigger.*Webhook.*Event context/,
      ),
    ).toBeTruthy()
    expect(screen.getByRole('option', { name: /comment_text/ })).toBeTruthy()
  })
})
