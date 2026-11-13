// Completed daily AW tasks 01M4SZ1T6KTD54544KPDVVT7NX and
// 01M4TB2FRHBMGTXJZVMSPF9NMK are the real-model sources.
// This reproduces accepted model responses; it never mocks application APIs.
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import directionsRecording from '../packages/system-mocks/src/runtime/fixtures/rfc372-real-directions.json' with { type: 'json' }
import hierarchyRecording from '../packages/system-mocks/src/runtime/fixtures/rfc372-real-hierarchy.json' with { type: 'json' }
import { startDaemon, type DaemonHandle } from './harness'

for (const recording of [directionsRecording, hierarchyRecording]) {
  const hierarchy = 'initialQuestionCount' in recording
  const initialCount = hierarchy ? recording.initialQuestionCount : 2
  const logName = hierarchy ? 'recorded-hierarchy.ndjson' : 'recorded-directions.ndjson'
  const expectedRows = hierarchy ? 16 : 9
  test.describe(
    hierarchy ? 'nested preset categories with built-in guidance' : 'original category guidance',
    () => {
      test.setTimeout(180_000)
      let daemon: DaemonHandle
      let state: string
      async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
        const response = await fetch(`${daemon.baseUrl}${path}`, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const text = await response.text()
        expect(response.ok, `${path}: ${response.status} ${text}`).toBe(true)
        return text ? (JSON.parse(text) as T) : (null as T)
      }
      interface Round {
        intermediaryNodeRunId: string
        status: string
        questions: Array<{
          id: string
          title: string
          mindmap: { categoryPath: string[]; parentQuestionId?: string }
        }>
      }
      // RFC-490 (C1): a selected node is read in a panel of the workspace, beside the
      // canvas at this width. It is put away, not dismissed, and it is never a modal.
      const panel = (page: Page) =>
        page.getByRole('region', { name: 'Answer and confirm', exact: true })
      const dialog = (page: Page) => page.getByRole('dialog')
      const search = (page: Page) =>
        page.getByRole('textbox', { name: 'Search categories, questions, options or answers' })
      async function close(page: Page) {
        const back = panel(page).getByRole('button', { name: /Back to mindmap/ })
        if (await back.isVisible()) await back.click()
        await expect(panel(page)).toHaveCount(0)
      }
      /** Another node can be picked while the panel is open: it simply switches. */
      async function select(page: Page, title: string) {
        await search(page).fill(title)
        await page.getByRole('option').filter({ hasText: title }).click()
        await expect(panel(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
        await expect(dialog(page)).toHaveCount(0)
        await expect(page.locator('.mindmap-workspace__panes')).toHaveAttribute(
          'data-split',
          'side',
        )
      }
      async function answer(page: Page, id: string) {
        const question = recording.questions.find((q) => q.id === id)!
        const value = recording.answers.find((a) => a.questionId === id)!
        await select(page, question.title)
        for (const index of value.selectedOptionIndices)
          await panel(page).locator(`input[data-option-idx="${index}"]`).check()
        if (value.customText) {
          await page.getByTestId('clarify-custom-radio').check()
          await page.getByTestId('clarify-custom-textarea').fill(value.customText)
        }
        await panel(page).getByRole('button', { name: 'Confirm this answer', exact: true }).click()
        await expect(
          panel(page).getByRole('button', { name: 'Confirmed', exact: true }),
        ).toBeDisabled()
      }
      test.beforeAll(async () => {
        state = mkdtempSync(join(tmpdir(), 'aw-rfc372-directions-'))
        daemon = await startDaemon({
          stubMode: 'clarify',
          extraEnv: {
            CLARIFY_STUB_STATE: state,
            CLARIFY_STUB_MINDMAP_SCENARIO: hierarchy
              ? 'recorded-live-hierarchy'
              : 'recorded-live-directions',
          },
        })
        await api('/api/config', { memoryDistillerEnabled: false }, 'PUT')
      })
      test.afterAll(async () => {
        await daemon?.stop()
        if (state) rmSync(state, { recursive: true, force: true })
      })
      // WebKit nightly 40991904663 (Ubuntu): a follow-up was accepted (202) but its question did not
      // land within 30 s, then the retry passed. Open in docs/audit-backlog.md (2026-10-30).
      test('real recorded directions: category peers, question child, root category, panel recovery and final document', async ({
        page,
      }, testInfo) => {
        const agent = await api<{ id: string }>('/api/agents', {
          name: 'recorded-database-design',
          description: '',
          outputs: ['design'],
          outputKinds: { design: 'markdown' },
          readonly: true,
          bodyMd: '',
        })
        const definition = structuredClone(recording.workflow)
        for (const node of definition.nodes) if (node.agentId) node.agentId = agent.id
        const workflow = await api<{ id: string }>('/api/workflows', {
          name: 'Recorded database directions',
          definition,
        })
        const task = await api<{ id: string }>('/api/tasks', {
          name: 'Recorded category guidance',
          workflowId: workflow.id,
          scratch: true,
          inputs: { topic: recording.topic },
        })
        await page.addInitScript(
          ({ baseUrl, token }) => {
            localStorage.setItem('agent-workflow.baseUrl', baseUrl)
            localStorage.setItem('agent-workflow.token', token)
            localStorage.setItem('aw-language', 'en-US')
          },
          { baseUrl: daemon.baseUrl, token: daemon.token },
        )
        let round: Round | undefined
        await expect
          .poll(
            async () => {
              round = (
                await api<Round[]>(`/api/clarify?taskId=${task.id}&status=awaiting_human`)
              )[0]
              return !!round
            },
            { timeout: 60_000 },
          )
          .toBe(true)
        const roundId = round!.intermediaryNodeRunId
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.goto(`${daemon.baseUrl}/clarify/${roundId}`)
        for (const question of recording.questions.slice(0, initialCount))
          await answer(page, question.id)
        for (const stage of recording.stages) {
          await close(page)
          await search(page).fill('')
          if (stage.kind === 'deep') {
            await select(
              page,
              recording.questions.find((q) => q.id === stage.contextQuestionIds.at(-1))!.title,
            )
            // RFC-490: one "Follow up:" row under the question; "Write my own…" opens the
            // empty form, and the request is sent under the one name follow-ups have.
            await expect(panel(page).getByRole('button', { name: /Deepen/ })).toHaveCount(0)
            await panel(page).getByRole('button', { name: 'Write my own…', exact: true }).click()
            await panel(page)
              .getByLabel('What needs more detail? (optional)')
              .fill(stage.instruction)
          } else {
            if (stage.kind === 'root')
              await page.getByRole('button', { name: 'Question outline', exact: true }).click()
            else
              await page
                .getByRole('treeitem')
                .filter({ has: page.getByText(stage.categoryPath!.at(-1)!, { exact: true }) })
                .click()
            await expect(dialog(page)).toHaveCount(0)
            await panel(page)
              .getByLabel('What else should AI consider? (optional)')
              .fill(stage.instruction)
          }
          const response = page.waitForResponse(
            (res) => res.request().method() === 'POST' && res.url().endsWith('/followup'),
          )
          await panel(page)
            .getByRole('button', {
              name: stage.kind === 'deep' ? 'Generate follow-ups' : 'Generate questions',
              exact: true,
            })
            .click()
          // The panel can be put away while the model works; the workspace still leads
          // back to the generating branch, where the request can be canceled.
          await close(page)
          await page.getByRole('button', { name: 'View generating branch' }).click()
          await expect(panel(page).getByRole('button', { name: 'Cancel follow-up' })).toBeVisible()
          await expect(dialog(page)).toHaveCount(0)
          const result = await response
          // RFC-372 O8: accepted at once; the questions land when generation settles.
          expect(result.status()).toBe(202)
          const request = result.request().postDataJSON()
          if (stage.kind === 'deep') expect(request.parentQuestionId).toBeTruthy()
          else {
            expect(request.categoryPath).toEqual(stage.categoryPath)
            expect(request.parentQuestionId).toBeUndefined()
          }
          await expect
            .poll(
              async () =>
                (await api<Round>(`/api/clarify/${roundId}`)).questions.filter((q) =>
                  q.id.startsWith(`fq-${request.requestId}-`),
                ).length,
              { timeout: 30_000 },
            )
            .toBe(stage.questionIds.length)
          const current = await api<Round>(`/api/clarify/${roundId}`)
          for (const id of stage.questionIds) {
            const recorded = recording.questions.find((q) => q.id === id)!
            const actual = current.questions.find((q) => q.title === recorded.title)!
            expect(actual.mindmap.categoryPath).toEqual(recorded.mindmap.categoryPath)
            if (stage.kind === 'deep')
              expect(actual.mindmap.parentQuestionId).toBe(request.parentQuestionId)
            else expect(actual.mindmap.parentQuestionId).toBeUndefined()
            await answer(page, id)
          }
        }
        await close(page)
        await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
          'data-draft-status',
          'saved',
        )
        await page.reload()
        await expect(
          page.getByText('This round’s answers are confirmed. Review decisions before submitting.'),
        ).toBeVisible()
        // The daily-AW UX regression was 72px category / 76px question rows: six
        // questions needed scrolling. Keep the real recorded tree dense and readable.
        const tree = page.getByRole('tree', { name: 'Question outline' })
        await expect(tree.getByRole('treeitem')).toHaveCount(expectedRows)
        // RFC-490 AC08: at this width, with the outline open and nothing folded, the whole
        // recorded map fits the canvas at the readable scale (0.85) — no row needs a
        // horizontal pan to be read.
        const map = page.locator('.mindmap-canvas')
        await expect(map).toHaveAttribute('data-world-width', /^\d+$/)
        const columns = Number(await map.getAttribute('data-columns'))
        expect(columns).toBeGreaterThanOrEqual(2)
        const canvas = (await page
          .getByRole('img', { name: 'Clarification mindmap' })
          .boundingBox())!
        expect(Number(await map.getAttribute('data-world-width')) * 0.85).toBeLessThanOrEqual(
          canvas.width,
        )
        const density = await tree.getByRole('treeitem').evaluateAll((rows) =>
          rows.map((row) => ({
            group: row.classList.contains('mindmap-outline__row--group'),
            height: row.getBoundingClientRect().height,
            width: row.querySelector('.mindmap-outline__title')!.getBoundingClientRect().width,
            top: row.getBoundingClientRect().top,
            bottom: row.getBoundingClientRect().bottom,
          })),
        )
        for (const row of density) {
          expect(row.height).toBeLessThanOrEqual(row.group ? 36 : 48)
          if (!row.group) expect(row.width).toBeGreaterThan(120)
        }
        const treeBox = (await tree.boundingBox())!
        expect(density[0]!.top).toBeGreaterThanOrEqual(treeBox.y)
        expect(density.at(-1)!.bottom).toBeLessThanOrEqual(treeBox.y + treeBox.height)
        const category = tree
          .getByRole('treeitem')
          .filter({ has: page.getByText('性能', { exact: true }) })
        const disclosure = category.getByRole('button', {
          name: 'Collapse children 性能',
          exact: true,
        })
        await expect(disclosure.locator('svg')).toBeVisible()
        await disclosure.click()
        await expect(category).toBeFocused()
        await expect(category).toHaveAttribute('tabindex', '0')
        await expect(category).toHaveAttribute('aria-expanded', 'false')
        // Folding and unfolding a branch never opens the panel.
        await expect(panel(page)).toHaveCount(0)
        await category.press('ArrowRight')
        await expect(tree.getByRole('treeitem')).toHaveCount(expectedRows)
        await expect(panel(page)).toHaveCount(0)
        await page.getByRole('button', { name: 'Fit all', exact: true }).click()
        await page.screenshot({
          path: testInfo.outputPath('recorded-directions-reviewed.png'),
          fullPage: true,
        })
        // ... and a phone-wide stage lays the same map out in a single column.
        await page.setViewportSize({ width: 390, height: 844 })
        await expect(map).toHaveAttribute('data-columns', '1')
        await page.setViewportSize({ width: 1440, height: 1000 })
        await expect(map).toHaveAttribute('data-columns', String(columns))
        await page.getByTestId('mindmap-review-open').click()
        // RFC-490 AC07: the review counts every question, and however long the list is the
        // next-step choice stays in view above the submit button.
        await expect(page.getByTestId('mindmap-review-summary')).toContainText(
          `${recording.questions.length} questions`,
        )
        await expect(
          page.getByRole('radiogroup', { name: 'After this submission', exact: true }),
        ).toBeInViewport()
        await page.getByTestId('mindmap-review-submit').click()
        await expect
          .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
            timeout: 60_000,
          })
          .toBe('done')
        const result = await api<{
          runs: Array<{ id: string; nodeId: string; status: string }>
          outputs: Array<{ nodeRunId: string; port: string; value: string }>
        }>(`/api/tasks/${task.id}/node-runs`)
        const output = result.runs.findLast(
          (run) => run.nodeId === 'output' && run.status === 'done',
        )!
        expect(
          result.outputs
            .find((value) => value.nodeRunId === output.id && value.port === 'design')!
            .value.trim(),
        ).toBe(recording.finalDocument.trim())
        expect(
          readFileSync(join(state, logName), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line).kind),
        ).toEqual(['initial', 'category', 'deep', 'root', 'final'])
        await testInfo.attach('real-source', {
          body: JSON.stringify(recording.source),
          contentType: 'application/json',
        })
      })
    },
  )
}
