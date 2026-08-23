// RFC-310 current first-use browser contract.
//
// A new administrator starts from the Digital Employees catalog, sees the
// whole deterministic responsibility card map, selects the work item in context,
// and adds a tool on the same page. The test deliberately has no legacy
// `/code` journey, stage selector, or editable line: the fixed cards are the navigation model.

import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

import { developmentEmployeeTypePackage } from '../packages/backend/src/modules/development-automation/composition/employeeTypePackage'
import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

/**
 * 内置 development 类型包的**当前**引用，从 descriptor 派生。
 *
 * 本文件原先有 8 处硬编码 `development%406`。内置包升到 7 之后，8 处一起红在
 * 「找不到类型」——与被测行为毫无关系的失败，而且每次升版都要再改一遍 8 个地方。
 * 手抄的常量必然过期；这里改为从生产 descriptor 取，升版后自动跟随。
 */
const DEVELOPMENT_TYPE_REF = (
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
    readonly typeRef: { readonly typeId: string; readonly revision: number }
  }
).typeRef
const DEVELOPMENT_TYPE_PATH = `${DEVELOPMENT_TYPE_REF.typeId}%40${DEVELOPMENT_TYPE_REF.revision}`

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

let daemon: DaemonHandle

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'development' })
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('a first-time user publishes a job template with the built-in implementation tool', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}`)
  await page.getByRole('tab', { name: 'Job templates' }).click()
  await page.getByRole('button', { name: 'New job template', exact: true }).click()

  const identityDialog = page.getByTestId('employee-job-identity-dialog')
  await identityDialog.getByLabel('Template name').fill('First development role')
  const draftResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/digital-employee-types\/[^/]+\/job-templates$/.test(new URL(response.url()).pathname),
  )
  await identityDialog
    .getByRole('button', { name: 'Create and configure duties', exact: true })
    .click()
  const createdDraft = await draftResponse
  expect(createdDraft.status()).toBe(201)
  expect(createdDraft.request().postDataJSON()).toMatchObject({
    name: 'First development role',
    defaultToolBindings: [],
    defaultCollaborationBindings: [],
    orderedDispatchConfigurations: [],
  })

  const editor = page.getByTestId('employee-job-template-editor')
  await expect(editor).toBeVisible()
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const durableDraft = page
    .locator('.employee-summary-card')
    .filter({ hasText: 'First development role' })
  await expect(durableDraft).toContainText('Draft')
  await durableDraft.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(editor).toBeVisible()
  await editor.locator('[data-work-item-ref="analyze-implement"]').click()
  const dutyDialog = page.getByTestId('employee-job-duty-dialog')
  await dutyDialog.getByRole('combobox', { name: 'Choose default tool', exact: true }).click()
  await expect(page.getByRole('option')).not.toHaveCount(0)
  await page.getByRole('option').first().click()
  await dutyDialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click()

  await expect(editor).toHaveCount(0)
  const created = page
    .locator('.employee-summary-card')
    .filter({ hasText: 'First development role' })
  await expect(created).toContainText('Published · v1')

  await page.getByRole('tab', { name: 'Employees' }).click()
  await page.getByRole('button', { name: 'Create employee', exact: true }).click()
  const employeeDialog = page.getByRole('dialog', { name: 'Create digital employee' })
  await employeeDialog.getByLabel('Employee name').fill('First development employee')
  await employeeDialog.getByRole('combobox', { name: 'Job template' }).click()
  await page.getByRole('option', { name: 'First development role', exact: true }).click()
  const employeeDraftResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/digital-employee-types\/[^/]+\/employees$/.test(new URL(response.url()).pathname),
  )
  await employeeDialog.getByRole('button', { name: 'Create', exact: true }).click()
  const employeeResponse = await employeeDraftResponse
  expect(employeeResponse.status()).toBe(201)
  expect((await employeeResponse.json()).revision).toBe(1)
  const employeeCard = page
    .locator('.employee-summary-card--employee')
    .filter({ hasText: 'First development employee' })
  await expect(employeeCard).toContainText('First development role')
  await expect(employeeCard).not.toContainText('Enabled')
  await expect(employeeCard).not.toContainText('Disabled')
})

test('an older definition never becomes a user migration task or manual API', async ({ page }) => {
  const oldJobDraft = JSON.stringify({
    schemaVersion: 1,
    typeRef: { typeId: 'development', revision: 4 },
    description: 'Older template that must be rebound',
    defaultToolBindings: [],
    defaultCollaborationBindings: [],
    orderedDispatchConfigurations: [],
  }).replaceAll("'", "''")
  const oldEmployeeDraft = JSON.stringify({
    schemaVersion: 1,
    typeRef: { typeId: 'development', revision: 4 },
    jobTemplateRef: { id: 'legacy-browser-job', revision: 1 },
    displayName: 'Legacy browser employee',
    // A pre-removal raw row proves the read boundary strips the retired field
    // without restoring it to the current product model.
    enabled: false,
    workScope: { kind: 'task' },
    toolOverrides: [],
    collaborationOverrides: [],
  }).replaceAll("'", "''")
  const oldEmployeePublished = JSON.stringify({
    schemaVersion: 1,
    typeRef: { typeId: 'development', revision: 4 },
    jobTemplateRef: { id: 'legacy-browser-job', revision: 1 },
    displayName: 'Legacy browser employee',
    enabled: false,
    workScopeRef: { id: 'legacy-browser-scope', revision: 1 },
    workScopeSummary: 'Repository selected when the task starts',
    exactToolBindings: [],
    exactCollaborationBindings: [],
    exactOrderedDispatchConfigurations: [],
    exactReactionLaneOrder: [],
    enabledWorkItemRefs: [],
    compiledClosureDigest: '0'.repeat(64),
  }).replaceAll("'", "''")
  runSqlite(
    join(daemon.home, 'db.sqlite'),
    `INSERT INTO employee_job_templates
       (id, type_id, type_revision, name, draft_json, published_revision,
        owner_user_id, created_at, updated_at, archived_at)
     VALUES
       ('legacy-browser-job', 'development', 4, 'Legacy browser role',
        '${oldJobDraft}', NULL, NULL, 100, 100, NULL);
     INSERT INTO employee_definitions
       (id, name, type_id, type_revision, draft_json, published_revision,
        owner_user_id, visibility, acl_revision, created_at, updated_at, archived_at)
     VALUES
       ('legacy-browser-employee', 'Legacy browser employee', 'development', 4,
        '${oldEmployeeDraft}', 1, NULL, 'private', 0, 100, 100, NULL);
     INSERT INTO employee_work_scope_revisions
       (scope_id, revision, type_id, type_revision, encoded_scope_json,
        display_summary, content_digest, created_at, created_by)
     VALUES
       ('legacy-browser-scope', 1, 'development', 4, '{"kind":"task"}',
        'Repository selected when the task starts', '${'1'.repeat(64)}', 100, NULL);
     INSERT INTO employee_definition_revisions
       (employee_id, revision, content_json, content_digest, published_at, published_by)
     VALUES
       ('legacy-browser-employee', 1, '${oldEmployeePublished}', '${'2'.repeat(64)}', 100, NULL);`,
  )

  await primeAuth(page)
  const staleTypeRequests: string[] = []
  page.on('request', (request) => {
    if (decodeURIComponent(request.url()).includes('/digital-employee-types/development@4')) {
      staleTypeRequests.push(request.url())
    }
  })
  await page.goto(`${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}?view=jobs`)
  await expect(page.getByTestId('legacy-job-template-upgrades')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Upgrade to current version' })).toHaveCount(0)

  await page.getByRole('tab', { name: 'Employees' }).click()
  await expect(page.getByTestId('legacy-digital-employee-upgrades')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Upgrade to current version' })).toHaveCount(0)
  expect(staleTypeRequests).toEqual([])
})

test('a first-time user configures a work-item tool directly on the fixed responsibility cards', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees`)

  await expect(page.getByTestId('digital-employee-type-list')).toBeVisible()
  await page.getByTestId('digital-employee-type-development').click()
  await expect(page.getByTestId('employee-toolbox-responsibility-map')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Toolbox' }).click()
  const responsibilityMap = page.getByTestId('employee-toolbox-responsibility-map')
  await expect(responsibilityMap).toBeVisible()
  await expect(responsibilityMap.locator('[data-work-item-ref]')).toHaveCount(20)
  await expect(page.getByText('Delivery and diagnosis', { exact: true })).toBeVisible()
  await expect(page.getByText('MR care and repair', { exact: true })).toBeVisible()

  await responsibilityMap.locator('[data-work-item-ref="analyze-implement"]').click()
  await page.waitForURL(/view=toolbox&workItem=analyze-implement/)
  const dutyDialog = page.getByRole('dialog', { name: 'Configure duty: Analyze and implement' })
  await expect(dutyDialog).toBeVisible()
  const toolbox = page.getByTestId('employee-node-toolbox')
  await expect(toolbox).toBeVisible()
  await expect(toolbox).toContainText('Understand the request or diagnose the problem')
  await expect(toolbox).toContainText('Input material')
  await expect(toolbox).toContainText('Deterministic output and completion')
  await expect(toolbox.getByRole('combobox', { name: /stage/i })).toHaveCount(0)

  await toolbox.getByRole('button', { name: 'Add tool', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add tool to Analyze and implement' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: /Tool name/ }).fill('First implementation tool')
  await dialog.getByRole('combobox', { name: 'Choose an Agent', exact: true }).click()
  await page.getByRole('option', { name: /^Built in · Code writing Compatible/ }).click()
  await dialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()

  await expect(dialog).toHaveCount(0)
  const createdTool = toolbox
    .locator('.node-tool-row')
    .filter({ hasText: 'First implementation tool' })
  await expect(createdTool).toHaveCount(1)
  await expect(createdTool.getByText('Available', { exact: true })).toBeVisible()
})

test('a failed contract check is corrected on the same tool registration id', async ({ page }) => {
  await primeAuth(page)
  const name = `Same-id correction ${Date.now()}`
  let corrupted = false
  await page.route('**/work-items/analyze-implement/tools', async (route) => {
    const request = route.request()
    if (!corrupted && request.method() === 'POST') {
      corrupted = true
      const body = request.postDataJSON() as {
        implementation: { agentRef: { id: string; revision: number } }
      }
      body.implementation.agentRef = { id: 'missing:test-agent', revision: 1 }
      await route.continue({ postData: JSON.stringify(body) })
      return
    }
    await route.continue()
  })

  await page.goto(
    `${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}?view=toolbox&workItem=analyze-implement`,
  )
  const toolbox = page.getByTestId('employee-node-toolbox')
  await toolbox.getByRole('button', { name: 'Add tool', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add tool to Analyze and implement' })
  await dialog.getByRole('textbox', { name: /Tool name/ }).fill(name)
  await dialog.getByRole('combobox', { name: 'Choose an Agent', exact: true }).click()
  await page.getByRole('option', { name: /^Built in · Code writing Compatible/ }).click()
  await dialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()

  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('This tool is not publishable yet')).toBeVisible()
  const listUrl = `${daemon.baseUrl}/api/digital-employee-types/${DEVELOPMENT_TYPE_PATH}/work-items/analyze-implement/tools`
  const failedResponse = await page.request.get(listUrl, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expect(failedResponse.ok()).toBe(true)
  const failed = (await failedResponse.json()) as {
    items: Array<{ id: string; content: { displayName: string }; publishedRevision: number | null }>
  }
  const failedRows = failed.items.filter((tool) => tool.content.displayName === name)
  expect(failedRows).toHaveLength(1)
  expect(failedRows[0]?.publishedRevision).toBeNull()

  await dialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const correctedResponse = await page.request.get(listUrl, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  const corrected = (await correctedResponse.json()) as {
    items: Array<{ id: string; content: { displayName: string }; publishedRevision: number | null }>
  }
  const correctedRows = corrected.items.filter((tool) => tool.content.displayName === name)
  expect(correctedRows).toEqual([
    expect.objectContaining({ id: failedRows[0]?.id, publishedRevision: 1 }),
  ])
  await expect(toolbox.locator('.node-tool-row').filter({ hasText: name })).toHaveCount(1)
})

test('an existing invalid tool opens in the editor and publishes its correction', async ({
  page,
}) => {
  await primeAuth(page)
  const name = `Editable invalid tool ${Date.now()}`
  const listUrl = `${daemon.baseUrl}/api/digital-employee-types/${DEVELOPMENT_TYPE_PATH}/work-items/analyze-implement/tools`
  const seededResponse = await page.request.post(listUrl, {
    headers: { Authorization: `Bearer ${daemon.token}` },
    data: {
      displayName: name,
      description: 'Seeded invalid registration',
      roleRef: 'primary',
      implementation: {
        kind: 'agent',
        agentRef: { id: 'missing:editable-agent', revision: 1 },
      },
      connectionRef: null,
    },
  })
  expect(seededResponse.status()).toBe(201)
  const seeded = (await seededResponse.json()) as {
    id: string
    validationReceipt: { status: string }
  }
  expect(seeded.validationReceipt.status).toBe('invalid')

  await page.goto(
    `${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}?view=toolbox&workItem=analyze-implement`,
  )
  const toolbox = page.getByTestId('employee-node-toolbox')
  const row = toolbox.locator('.node-tool-row').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  await expect(row.getByText('Invalid', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Edit', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: `Edit tool: ${name}` })
  await expect(dialog.getByRole('textbox', { name: /Tool name/ })).toHaveValue(name)
  await dialog.getByRole('combobox', { name: 'Choose an Agent', exact: true }).click()
  await page.getByRole('option', { name: /^Built in · Code writing Compatible/ }).click()
  await dialog
    .getByRole('button', { name: 'Check contract and publish new version', exact: true })
    .click()

  await expect(dialog).toHaveCount(0)
  await expect(row.getByText('Available', { exact: true })).toBeVisible()
  const finalResponse = await page.request.get(listUrl, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  const final = (await finalResponse.json()) as {
    items: Array<{ id: string; content: { displayName: string }; publishedRevision: number | null }>
  }
  expect(final.items.filter((tool) => tool.content.displayName === name)).toEqual([
    expect.objectContaining({ id: seeded.id, publishedRevision: 1 }),
  ])
})

test('pipeline failure types expand into equal-width required nodes and only show compatible tools', async ({
  page,
}) => {
  await primeAuth(page)
  const classifierToolName = `Two-type classifier ${Date.now()}`
  const toolName = `Compile-only pipeline repair ${Date.now()}`

  // User regressions 2026-08-22..23: the problem list belongs to the classifier
  // tool revision and defines its output vocabulary, while pipeline evidence is
  // the runtime input. Selecting the tool materializes the same N fan-out nodes.
  await page.goto(
    `${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}?view=toolbox&workItem=classify-pipeline`,
  )
  let toolbox = page.getByTestId('employee-node-toolbox')
  await expect(toolbox.getByRole('link', { name: 'Configure failure types' })).toHaveCount(0)
  await toolbox.getByRole('button', { name: 'Add tool', exact: true }).click()
  let toolDialog = page.getByRole('dialog', { name: 'Add tool to Classify pipeline failures' })
  const classifierPrimaryInput = toolDialog.getByTestId('execution-contract-primary-input-fields')
  await expect(classifierPrimaryInput).toContainText('Pipeline failure evidence')
  await expect(classifierPrimaryInput).toContainText('Pipeline material directory')
  await expect(classifierPrimaryInput).not.toContainText('Failure type definitions')
  const classifierPrimaryOutput = toolDialog.getByTestId('execution-contract-primary-output-fields')
  await expect(classifierPrimaryOutput).toContainText('Problem categories and records')
  await expect(classifierPrimaryOutput).toContainText('contextPatches')
  await expect(toolDialog).toContainText('Problem categories emitted by this tool')
  await toolDialog.getByLabel('Tool name').fill(classifierToolName)
  await toolDialog.getByLabel('Problem key P1').fill('compile-error')
  await toolDialog.getByLabel('Problem name P1').fill('Compile error')
  await toolDialog.getByLabel('Matching description P1').fill('Compilation or type checking fails')
  await toolDialog.getByRole('button', { name: 'Add problem type', exact: true }).click()
  await toolDialog.getByLabel('Problem key P2').fill('test-failure')
  await toolDialog.getByLabel('Problem name P2').fill('Test failure')
  await toolDialog.getByLabel('Matching description P2').fill('One or more tests fail')
  await toolDialog
    .locator('label.form-field')
    .filter({ hasText: 'Choose from Agent library' })
    .getByRole('combobox')
    .click()
  await page.getByRole('option', { name: /^Built in · Problem diagnosis Compatible/ }).click()
  await toolDialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()
  await expect(toolDialog).toHaveCount(0)

  await page.goto(
    `${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}?view=toolbox&workItem=repair-pipeline`,
  )

  toolbox = page.getByTestId('employee-node-toolbox')
  const stackedRepairCard = page
    .getByTestId('employee-toolbox-responsibility-map')
    .locator('[data-work-item-ref="repair-pipeline"]')
  const stackVisual = await stackedRepairCard.evaluate((card) => {
    const style = getComputedStyle(card)
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      legacyLayerCount: card.querySelectorAll('.employee-toolbox-card__stack-layer').length,
    }
  })
  expect(stackVisual.legacyLayerCount).toBe(0)
  expect(stackVisual.boxShadow).toContain(stackVisual.backgroundColor)
  expect(stackVisual.boxShadow).toContain(stackVisual.borderColor)
  expect(stackVisual.boxShadow).toContain('4px 4px')
  expect(stackVisual.boxShadow).toContain('8px 8px')
  expect(stackVisual.boxShadow.indexOf('4px 4px')).toBeLessThan(
    stackVisual.boxShadow.indexOf('8px 8px'),
  )

  await toolbox.getByRole('button', { name: 'Add tool', exact: true }).click()
  toolDialog = page.getByRole('dialog', { name: 'Add tool to Repair pipeline failures' })
  const repairPrimaryInput = toolDialog.getByTestId('execution-contract-primary-input-fields')
  await expect(repairPrimaryInput).toContainText('Classified pipeline problems')
  await expect(repairPrimaryInput).toContainText('Assigned failure type')
  await expect(repairPrimaryInput).toContainText('Pipeline failure evidence')
  await expect(repairPrimaryInput).toContainText('Pipeline material directory')
  await expect(toolDialog.getByTestId('execution-contract-primary-output-fields')).toContainText(
    'Commit message',
  )
  await toolDialog.getByLabel('Tool name').fill(toolName)
  await toolDialog.getByRole('combobox', { name: 'Problems solved by this tool' }).click()
  await page.getByRole('option', { name: /compile-error/ }).click()
  await page.keyboard.press('Escape')
  await toolDialog
    .locator('label.form-field')
    .filter({ hasText: 'Choose from Agent library' })
    .getByRole('combobox')
    .click()
  await page.getByRole('option', { name: /^Built in · General pipeline repair Compatible/ }).click()
  await toolDialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()
  await expect(toolDialog).toHaveCount(0)

  const toolRow = toolbox.locator('.node-tool-row').filter({ hasText: toolName })
  await expect(toolRow).toContainText('compile-error')
  await expect(toolbox.getByRole('link', { name: 'Assign failure types' })).toHaveCount(0)

  await page.goto(
    `${daemon.baseUrl}/digital-employees/${DEVELOPMENT_TYPE_PATH}?view=jobs&workItem=classify-pipeline`,
  )
  await expect(
    page.getByRole('heading', { name: 'Configure “Classify pipeline failures”' }),
  ).toBeVisible()

  await page
    .getByRole('button', { name: 'New job template and configure this duty', exact: true })
    .click()
  const identityDialog = page.getByTestId('employee-job-identity-dialog')
  await identityDialog.getByLabel('Template name').fill('Typed pipeline repair role')
  await identityDialog
    .getByRole('button', { name: 'Create and configure duties', exact: true })
    .click()

  const classifierDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(classifierDialog).toBeVisible()
  const jobMap = page.getByTestId('employee-toolbox-responsibility-map')
  await expect(jobMap.locator('[data-work-item-ref="repair-feedback"]')).not.toHaveClass(
    /employee-toolbox-card--fan-out/,
  )
  await expect(jobMap.locator('[data-work-item-ref="repair-pipeline"]')).toHaveClass(
    /employee-toolbox-card--fan-out/,
  )
  await classifierDialog
    .locator('label.form-field')
    .filter({ hasText: 'Default tool' })
    .getByRole('combobox')
    .click()
  await page.getByRole('option', { name: classifierToolName, exact: true }).click()

  const derivedProblemList = classifierDialog.getByTestId('job-dispatch-classify-pipeline')
  await expect(derivedProblemList.locator('.job-dispatch-route')).toHaveCount(2)
  await expect(derivedProblemList).toContainText('Compile error')
  await expect(derivedProblemList).toContainText('Test failure')
  await expect(derivedProblemList.getByRole('button', { name: 'Add failure type' })).toHaveCount(0)
  await classifierDialog.getByRole('button', { name: 'Done', exact: true }).click()

  const dispatchNodes = jobMap.locator('[data-dispatch-route-key]')
  await expect(dispatchNodes).toHaveCount(2)
  await expect(jobMap.locator('[data-work-item-ref="repair-pipeline"]')).toHaveCount(0)
  await expect(dispatchNodes.nth(0)).toContainText('P1 · Tool')
  await expect(dispatchNodes.nth(0)).toContainText('Compile error')
  await expect(dispatchNodes.nth(1)).toContainText('P2 · Tool')
  await expect(dispatchNodes.nth(1)).toContainText('Test failure')
  const widths = await jobMap
    .locator('.employee-toolbox-lane__cards > .employee-toolbox-card')
    .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width))
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.5)

  const reviewLane = jobMap.locator('[data-lane-id="care-review"]')
  const pipelineLane = jobMap.locator('[data-lane-id="care-pipeline"]')
  await expect(reviewLane.locator('.employee-toolbox-lane__priority')).toHaveText('P1')
  await expect(pipelineLane.locator('.employee-toolbox-lane__priority')).toHaveText('P4')

  const dragHandle = pipelineLane.getByRole('button', {
    name: /Drag “Pipeline gates” to change event priority/,
  })
  const dragHandleBox = await dragHandle.boundingBox()
  const firstSlotBox = await reviewLane.boundingBox()
  expect(dragHandleBox).not.toBeNull()
  expect(firstSlotBox).not.toBeNull()
  const pointerX = (dragHandleBox?.x ?? 0) + (dragHandleBox?.width ?? 0) / 2
  const pointerStartY = (dragHandleBox?.y ?? 0) + (dragHandleBox?.height ?? 0) / 2
  const pointerFirstSlotY = (firstSlotBox?.y ?? 0) + (firstSlotBox?.height ?? 0) / 2
  await page.mouse.move(pointerX, pointerStartY)
  await page.mouse.down()
  await page.mouse.move(pointerX, pointerFirstSlotY, { steps: 2 })
  await expect
    .poll(() =>
      jobMap
        .locator('.employee-toolbox-lane')
        .evaluateAll((lanes) => lanes.some((lane) => lane.getAnimations().length > 0)),
    )
    .toBe(true)
  await expect(pipelineLane).toHaveClass(/employee-toolbox-lane--dragging/)
  await expect(pipelineLane).toHaveClass(/employee-toolbox-lane--drop-target/)
  // The source follows the captured pointer and occupies exact slot zero before release.
  const movedHandleBox = await dragHandle.boundingBox()
  expect(movedHandleBox).not.toBeNull()
  expect(
    Math.abs((movedHandleBox?.y ?? 0) + (movedHandleBox?.height ?? 0) / 2 - pointerFirstSlotY),
  ).toBeLessThanOrEqual(1)
  await expect(pipelineLane.locator('.employee-toolbox-lane__priority')).toHaveText('P1')
  await expect(reviewLane.locator('.employee-toolbox-lane__priority')).toHaveText('P2')
  await page.mouse.up()
  await expect(pipelineLane.locator('.employee-toolbox-lane__priority')).toHaveText('P1')

  // A single captured move followed immediately by release must still commit
  // the exact final slot. This locks the old intermittent stale-state race.
  const sortableLanes = jobMap
    .locator('.employee-toolbox-lane')
    .filter({ has: page.locator('.employee-toolbox-lane__priority') })
  let currentHandleBox = await dragHandle.boundingBox()
  const thirdSlotBox = await sortableLanes.nth(2).boundingBox()
  expect(currentHandleBox).not.toBeNull()
  expect(thirdSlotBox).not.toBeNull()
  await page.mouse.move(
    (currentHandleBox?.x ?? 0) + (currentHandleBox?.width ?? 0) / 2,
    (currentHandleBox?.y ?? 0) + (currentHandleBox?.height ?? 0) / 2,
  )
  await page.mouse.down()
  await expect(pipelineLane).toHaveClass(/employee-toolbox-lane--dragging/)
  await page.mouse.move(
    (currentHandleBox?.x ?? 0) + (currentHandleBox?.width ?? 0) / 2,
    (thirdSlotBox?.y ?? 0) + (thirdSlotBox?.height ?? 0) / 2,
    { steps: 1 },
  )
  await expect(pipelineLane.locator('.employee-toolbox-lane__priority')).toHaveText('P3')
  await page.mouse.up()
  await expect(pipelineLane.locator('.employee-toolbox-lane__priority')).toHaveText('P3')

  currentHandleBox = await dragHandle.boundingBox()
  const exactFirstSlotBox = await sortableLanes.nth(0).boundingBox()
  expect(currentHandleBox).not.toBeNull()
  expect(exactFirstSlotBox).not.toBeNull()
  await page.mouse.move(
    (currentHandleBox?.x ?? 0) + (currentHandleBox?.width ?? 0) / 2,
    (currentHandleBox?.y ?? 0) + (currentHandleBox?.height ?? 0) / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    (currentHandleBox?.x ?? 0) + (currentHandleBox?.width ?? 0) / 2,
    (exactFirstSlotBox?.y ?? 0) + (exactFirstSlotBox?.height ?? 0) / 2,
    { steps: 1 },
  )
  await page.mouse.up()
  await expect(pipelineLane.locator('.employee-toolbox-lane__priority')).toHaveText('P1')

  await dispatchNodes.filter({ hasText: 'Compile error' }).click()
  let repairDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(repairDialog).toContainText('Repair priority P1')
  await repairDialog
    .locator('label.form-field')
    .filter({ hasText: 'Tool for this failure type' })
    .getByRole('combobox')
    .click()
  await expect(page.getByRole('option', { name: new RegExp(toolName) })).toBeVisible()
  await page.getByRole('option', { name: new RegExp(toolName) }).click()
  await repairDialog.getByRole('button', { name: 'Done', exact: true }).click()

  await dispatchNodes.filter({ hasText: 'Test failure' }).click()
  repairDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(repairDialog).toContainText('Repair priority P2')
  await repairDialog
    .locator('label.form-field')
    .filter({ hasText: 'Tool for this failure type' })
    .getByRole('combobox')
    .click()
  await expect(page.getByRole('option', { name: new RegExp(toolName) })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await repairDialog.getByRole('button', { name: 'Done', exact: true }).click()

  await expect(dispatchNodes.nth(0)).toHaveClass(/employee-toolbox-card--configured/)
  await expect(dispatchNodes.nth(1)).toHaveClass(/employee-toolbox-card--configured/)
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click()
})
