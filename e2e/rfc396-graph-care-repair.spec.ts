// One graph-specific composition journey, not a second copy of the shared MR state matrix.
// Only model output and the external code host/CI are controlled. Tools are registered through
// public APIs; native review, Task workspaces, material hydration, Git, profiles and care run
// through the artifact daemon. No store writes or replacement verification resolver are used.
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  SystemMockClient,
  type MockCodeHostProject,
} from '@agent-workflow/system-mocks'
import { defaultSystemMockToolPath, startDaemon, type DaemonHandle } from './harness'
import { attachWindowsProfileDiagnostic } from './rfc396-windows-profile-diagnostic'
import { clarifyAnswerBasis, clarifyQuestionSetKey } from '../packages/shared/src/clarifyMindmap'
import type { ClarifyQuestion } from '../packages/shared/src/schemas/clarify'
import type {
  GraphDesignDocument,
  GraphEvidenceBinding,
  GraphImplementationBasis,
} from '../packages/shared/src/schemas/graphDesign'

async function retainProfileDiagnostic(name: string, data: { body: Buffer; contentType: string }) {
  // CI records traces only on retry. Keep first-attempt JSON in the uploaded
  // output directory even when no reporter serializes in-memory attachments.
  const path = test.info().outputPath(name)
  await writeFile(path, data.body)
  await test.info().attach(name, { path, contentType: data.contentType })
}

// Windows CI ran the care journey for 5.4 min (first attempt) and 4.2 min (retry) in run 40461800472,
// against a 300 s limit; the external-observation waits below also need room there.
test.setTimeout(600_000)
const typeRef = 'graph-development@2'
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const projectPath = `rfc396/graph-care-${tag}`
const testRef = 'graph-result.test.cjs#graph-result-test'
const clarification = 'Preserve the implemented result while repairing CI; no behavior change.'
const sourceBefore = "exports.result = () => 'implemented'\nexports.pipelineRevision = 'initial'\n"
const sourceAfter = "exports.result = () => 'implemented'\nexports.pipelineRevision = 'repaired'\n"
const profileSource = `const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
process.chdir(__dirname)
require('./graph-result.test.cjs')
const business = require('./graph-result.cjs')
const care = fs.existsSync('care-proof.json') ? JSON.parse(fs.readFileSync('care-proof.json', 'utf8')) : null
assert.ok(['initial', 'repaired'].includes(business.pipelineRevision))
if (business.pipelineRevision === 'repaired') {
  assert.ok(care && care.reviewReceiptId && care.basisDigest && care.priorExecutionIds.length)
  assert.ok(care.logText.includes('rfc396-care-failure'))
}
console.log('RFC396_PROFILE_PROOF ' + JSON.stringify({
  pipelineRevision: business.pipelineRevision,
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'graph-result.cjs'))).digest('hex'),
  testRef: ${JSON.stringify(testRef)}, care,
}))
`
const generatedFiles = {
  'graph-result.cjs': sourceBefore,
  'graph-result.test.cjs': `// graph-result-test\nconst assert = require('node:assert/strict')\nassert.equal(require('./graph-result.cjs').result(), 'implemented')\n`,
  'verify.cjs': profileSource,
  verify: "#!/usr/bin/env node\nrequire('./verify.cjs')\n",
  // The production resolver invokes the repository file itself. Bun.spawn on Windows
  // supports .cmd through CreateProcessW; keep the actual verifier shared with POSIX.
  'verify.cmd': '@echo off\r\nnode "%~dp0verify.cjs"\r\nexit /b %ERRORLEVEL%\r\n',
}
const programInput = `import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const input = JSON.parse(process.env.AW_PORT_CONTRACT_INPUT ?? fs.readFileSync(process.env.AW_PORT_FILE_CONTRACT_INPUT, 'utf8'))
`
const implementationProgram = `${programInput}
for (const [name, content] of Object.entries(${JSON.stringify(generatedFiles)})) fs.writeFileSync(name, content)
fs.chmodSync('verify', 0o755)
if (input.materials.basis) {
  assert.ok(input.materials.basis.includedElementIds.includes('requirement'))
  assert.equal(input.materials.basis.document.obligations.find(item => item.id === 'acceptance').verification.kind, 'execution')
}
process.stdout.write(JSON.stringify({
  summary: 'Implement the approved result and its executable verification',
  result: {
    traceProposals: [{elementId:'requirement', obligationId:'acceptance', path:'graph-result.cjs', symbol:'result', testRef:${JSON.stringify(testRef)}, reason:'Business result and its exact assertion'}],
    testRefs: [${JSON.stringify(testRef)}], limitations: [],
    deliveryContent: {commitMessage:'Implement graph result', title:'Graph care repair journey', description:'Preserve the approved business result through CI repair'},
  },
}))
`
const classifyProgram = `${programInput}
process.stdout.write(JSON.stringify({outcome:'completed', groups:[{type:input.fallbackType, checkRefs:input.failedChecks.map(check => check.checkRef)}]}))
`
const repairProgram = `${programInput}
if (input.failureType !== 'rfc396-regression') {
  // Authoring executes the standard contract example, which has no graph Case material.
  process.stdout.write(JSON.stringify({outcome:'blocked', explanation:'This tool repairs the configured graph care regression category'}))
} else {
  const instructions = process.env.DIGITAL_EMPLOYEE_MATERIAL_INSTRUCTIONS ?? ''
  const materialPath = instructions.match(/(\\.agent-workflow\\/[^\\s]+\\/care\\.json)/)?.[1]
  assert.ok(materialPath, 'real Task must receive graph care material instructions')
  const care = JSON.parse(fs.readFileSync(materialPath, 'utf8'))
  const implementation = fs.readFileSync(path.join(path.dirname(materialPath), 'implementation.md'), 'utf8')
  assert.equal(care.staleIds.length, 0)
  assert.ok(care.reviewReceiptId)
  assert.ok(care.basis.includedElementIds.includes('requirement'))
  assert.ok(care.basis.document.sources.some(source => source.originalAnswer === ${JSON.stringify(clarification)}))
  assert.ok(implementation.includes('requirement'))
  assert.ok(care.traces.some(trace => trace.path === 'graph-result.cjs' && trace.testRef === ${JSON.stringify(testRef)}))
  const priorExecution = care.evidence.filter(row => row.kind === 'execution' && row.result === 'passed')
  assert.ok(priorExecution.length, 'old verification must be hydrated as historical material')
  const logPaths = input.problems.flatMap(problem => problem.evidenceFiles ?? [])
  assert.ok(logPaths.length, 'real CI adapter must supply retained logs')
  const logText = logPaths.map(file => fs.readFileSync(file, 'utf8')).join('\\n')
  assert.ok(logText.includes('rfc396-care-failure'))
  assert.equal(fs.readFileSync('graph-result.cjs', 'utf8'), ${JSON.stringify(sourceBefore)})
  fs.writeFileSync('graph-result.cjs', ${JSON.stringify(sourceAfter)})
  fs.writeFileSync('care-proof.json', JSON.stringify({
    caseId: care.basis.document.caseId, basisId: care.basis.id, basisDigest: care.basis.digest,
    reviewReceiptId: care.reviewReceiptId, materialPath,
    priorExecutionIds: priorExecution.map(row => row.id),
    priorTrees: [...new Set(priorExecution.map(row => row.candidateTreeOid))],
    logText, testRef: ${JSON.stringify(testRef)},
  }))
  process.stdout.write(JSON.stringify({outcome:'completed', commitMessage:'Repair pipeline while preserving the approved graph behavior'}))
}
`

type ExactRef = { id: string; revision: number }
interface Workspace {
  document: GraphDesignDocument
  host: { executionRef: string | null; editableClarify: { taskId: string } | null }
  executionLinks: { kind: string; receipt?: { id: string; decision: string; taskId: string } }[]
}
interface CaseProjection {
  case: {
    id: string
    typeRef: { typeId: string; revision: number }
    state: string
    terminalKind: string | null
  }
  rounds: { id: string; workItemRef: string; executionRef: string | null; state: string }[]
  detail: {
    delivery: null | {
      status: string
      ref: string
      sourceBranch: string | null
      targetBranch: string | null
      headSha: string
      readyToMerge: boolean
    }
  }
}
interface EvidenceProjection {
  evidence: { evidence: GraphEvidenceBinding; freshness: string; reasons: string[] }[]
  candidate: { basisDigest: string; candidateTreeOid: string } | null
  obligations: { obligationId: string; state: string }[]
}
interface CareProof {
  caseId: string
  basisId: string
  basisDigest: string
  reviewReceiptId: string
  materialPath: string
  priorExecutionIds: string[]
  priorTrees: string[]
  logText: string
  testRef: string
}
let daemon: DaemonHandle | undefined
let mocks: SystemMockClient
let repositoryId: string
let employeeId: string
let project: MockCodeHostProject
let profile: ExactRef

async function api<T>(pathname: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon!.baseUrl}${pathname}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${daemon!.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  expect(response.ok, `${pathname}: ${response.status} ${text}`).toBe(true)
  return (text ? JSON.parse(text) : null) as T
}

async function registerProgram(
  workItemRef: string,
  roleRef: string,
  source: string,
  dispatch: Record<string, unknown> = {},
): Promise<ExactRef> {
  const base = `/api/digital-employee-types/${typeRef}/work-items/${workItemRef}/tools`
  const draft = await api<{ id: string; validationReceipt: { status: string; checks: unknown[] } }>(
    base,
    {
      displayName: `Graph care ${workItemRef} ${tag}`,
      description: 'Bounded graph material and verification composition fixture',
      roleRef,
      implementation: {
        kind: 'program',
        runtimeKind: 'node',
        source,
        parameterValues: {},
        runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
      },
      ...dispatch,
    },
  )
  expect(draft.validationReceipt.status, JSON.stringify(draft.validationReceipt.checks)).toBe(
    'valid',
  )
  return (await api<{ ref: ExactRef }>(`${base}/${encodeURIComponent(draft.id)}/publish`, {})).ref
}

test.beforeAll(async () => {
  const pipelineMockUrl = process.env.AW_PIPELINE_MOCK_URL
  if (!pipelineMockUrl) throw new Error('system-mock suite must provide AW_PIPELINE_MOCK_URL')
  daemon = await startDaemon({
    stubMode: 'graph-development',
    home: process.env.RFC396_CARE_E2E_HOME,
    // The existing native pipeline purpose binding projects this exact URL
    // from daemon startup into adapter extraEnv, independently of secretProjection.
    extraEnv: { AW_PIPELINE_MOCK_URL: pipelineMockUrl },
  })
  mocks = new SystemMockClient(
    process.env.AW_SYSTEM_MOCK_CONTROL_URL!,
    process.env.AW_SYSTEM_MOCK_CONTROL_TOKEN!,
  )
  await api(
    '/api/code-hosts/gitlab',
    {
      baseUrl: process.env.AW_SYSTEM_MOCK_GITLAB_API_BASE_URL!,
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
    'PUT',
  )
  project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath,
    defaultBranch: 'main',
    baseFiles: { 'README.md': '# Graph care repair\n' },
  })
  const batch = await api<{ batchId: string }>('/api/cached-repos/batch-import', {
    urls: [project.repoHttpUrl],
  })
  await expect
    .poll(
      async () =>
        (await api<{ state: string }>(`/api/cached-repos/imports/${batch.batchId}`)).state,
      { timeout: 60_000 },
    )
    .toBe('completed')
  repositoryId = (
    await api<{ items: { id: string; urlRedacted: string }[] }>('/api/cached-repos')
  ).items.find((row) => row.urlRedacted === project.repoHttpUrl)!.id

  const adapter = await api<{ id: string }>('/api/integrations/development-adapters', {
    name: `Graph care pipeline ${tag}`,
    purpose: 'pipeline-gate',
    draft: {
      schemaVersion: 1,
      purpose: 'pipeline-gate',
      operations: ['collect', 'trigger', 'rerun'],
      contractVersion: 1,
      executableRef: defaultSystemMockToolPath(),
      parameterSchemaRef: null,
      connectionRef: null,
      secretProjection: [],
      outputBudget: { maxFiles: 16, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 },
      timeoutMs: 30_000,
    },
  })
  const adapterRevision = await api<{ revision: number }>(
    `/api/integrations/development-adapters/${encodeURIComponent(adapter.id)}/publish`,
    {},
  )
  const typePackage = await api<{
    authoringManifest: {
      workItems: { workItemRef: string; toolRoleGroups: { roleRef: string }[] }[]
    }
  }>(`/api/digital-employee-types/${typeRef}`)
  const role = (item: string) => {
    const groups = typePackage.authoringManifest.workItems.find(
      (work) => work.workItemRef === item,
    )?.toolRoleGroups
    expect(groups, item).toHaveLength(1)
    return groups![0]!.roleRef
  }
  const implement = await registerProgram(
    'implement-change',
    role('implement-change'),
    implementationProgram,
  )
  // The job chooses the handler, but all route metadata belongs to the exact
  // published classifier revision and must remain identical in both requests.
  const failureRoute = {
    routeRef: 'rfc396-regression',
    displayName: 'Graph CI regression',
    description: 'Repair without changing the approved graph behavior',
    fallback: true,
  }
  const classify = await registerProgram(
    'classify-pipeline',
    role('classify-pipeline'),
    classifyProgram,
    {
      dispatchRouteDefinitions: [failureRoute],
    },
  )
  const repair = await registerProgram('repair-pipeline', role('repair-pipeline'), repairProgram, {
    acceptedDispatchRoutes: [
      { classifierWorkItemRef: 'classify-pipeline', routeRefs: [failureRoute.routeRef] },
    ],
  })
  const jobs = await api<{
    items: {
      id: string
      draft: {
        defaultToolBindings: { workItemRef: string; slotRef: string; registrationRef: ExactRef }[]
      }
    }[]
  }>(`/api/digital-employee-types/${typeRef}/job-templates`)
  const baseJob = jobs.items.find((job) => job.id === 'platform:graph-development:job:mr-v1')
  expect(baseJob).toBeTruthy()
  const job = await api<{ id: string }>(`/api/digital-employee-types/${typeRef}/job-templates`, {
    name: `Graph care configured before launch ${tag}`,
    description: 'Native graph review, automatic profile and CI repair',
    defaultToolBindings: [
      ...baseJob!.draft.defaultToolBindings.map((binding) =>
        binding.workItemRef === 'implement-change'
          ? { ...binding, registrationRef: implement }
          : binding,
      ),
      { workItemRef: 'classify-pipeline', slotRef: 'default', registrationRef: classify },
    ],
    defaultAdapterBindings: [
      {
        laneId: 'care-pipeline',
        slotRef: 'primary',
        adapterRef: { id: adapter.id, revision: adapterRevision.revision },
      },
    ],
    defaultCollaborationBindings: [],
    orderedDispatchConfigurations: [
      {
        classifierWorkItemRef: 'classify-pipeline',
        routes: [
          {
            ...failureRoute,
            destinationWorkItemRef: 'repair-pipeline',
            registrationRef: repair,
          },
        ],
      },
    ],
  })
  const publishedJob = await api<{ ref: ExactRef }>(
    `/api/digital-employee-job-templates/${encodeURIComponent(job.id)}/publish`,
    {},
  )
  employeeId = (
    await api<{ id: string }>(`/api/digital-employee-types/${typeRef}/employees`, {
      name: `Graph care employee ${tag}`,
      jobTemplateRef: publishedJob.ref,
      workScope: { kind: 'task' },
      toolOverrides: [],
      adapterOverrides: [],
      collaborationOverrides: [],
    })
  ).id
  const draftProfile = await api<{ id: string }>('/api/code/verification-profiles', {
    name: `Graph behavior profile ${tag}`,
    draft: {
      schemaVersion: 1,
      steps: [
        {
          stepId: 'graph-behavior',
          programRef: process.platform === 'win32' ? 'repo:verify.cmd' : 'repo:verify',
          argsRef: null,
          timeoutMs: 30_000,
          networkProfileRef: 'none@1',
          successExitCodes: [0],
          evidenceSelectors: [{ kind: 'stdout-tail', value: 16_384 }],
        },
      ],
      stopPolicy: 'first-failure',
      maxParallel: 1,
    },
  })
  profile = {
    id: draftProfile.id,
    ...(await api<{ revision: number }>(
      `/api/code/verification-profiles/${encodeURIComponent(draftProfile.id)}/publish`,
      {},
    )),
  }
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('RFC-396 graph care hydrates approved material, repairs a real Task and re-verifies the same MR', async ({
  page,
}) => {
  // seedCodeHost always creates its own MR. Preserve that whole baseline and
  // require exactly one additional MR across publication, repair and closure.
  const seededMergeRequests = structuredClone(project.mergeRequests)
  const caseId = (
    await api<{ case: { id: string } }>(`/api/digital-employees/${employeeId}/cases`, {
      name: 'Graph result with pipeline care',
      kind: 'body',
      body: 'Preserve the implemented result and its exact test through CI repair.',
      externalId: null,
      target: { repositoryId },
      uploads: [],
      executionOptions: {},
      advanced: { typeOptions: {} },
      idempotencyKey: `${tag}:care`,
    })
  ).case.id
  let designId = ''
  await expect
    .poll(
      async () => {
        designId =
          (await api<{ id: string } | null>(`/api/employee-cases/${caseId}/design`))?.id ?? ''
        return designId
      },
      { timeout: 60_000 },
    )
    .toBeTruthy()
  const base = `/api/development-designs/${encodeURIComponent(designId)}`
  const workspace = () => api<Workspace>(base)
  const caseProjection = () => api<CaseProjection>(`/api/employee-cases/${caseId}`)
  const evidence = () => api<EvidenceProjection>(`${base}/evidence`)
  const singleCaseMr = (current: MockCodeHostProject) => {
    expect(current.mergeRequests).toHaveLength(seededMergeRequests.length + 1)
    for (const seeded of seededMergeRequests) {
      expect(current.mergeRequests.find((mr) => mr.id === seeded.id)).toEqual(seeded)
    }
    const added = current.mergeRequests.filter(
      (mr) => !seededMergeRequests.some((seeded) => seeded.id === mr.id),
    )
    expect(added).toHaveLength(1)
    expect(added[0]!.description).toContain(`Agent-Workflow-Case: ${caseId}`)
    expect(added[0]!.sourceProjectPath).toBe(projectPath)
    return added[0]!
  }
  await expect
    .poll(async () => (await workspace()).host.editableClarify, { timeout: 90_000 })
    .toBeTruthy()
  const taskId = (await workspace()).host.editableClarify!.taskId
  const pending = await api<{ intermediaryNodeRunId: string }[]>(
    `/api/clarify?status=awaiting_human&taskId=${taskId}`,
  )
  const roundId = pending[0]!.intermediaryNodeRunId
  const round = await api<{ iteration: number; questions: ClarifyQuestion[] }>(
    `/api/clarify/${roundId}`,
  )
  const answer = {
    questionId: 'exception',
    selectedOptionIndices: [],
    selectedOptionLabels: [],
    customText: clarification,
    decision: {
      status: 'provisional' as const,
      uncertainty: 'Only the controlled CI diagnosis is covered',
    },
  }
  await api(`/api/clarify/${roundId}/answers`, {
    ifMatchIteration: round.iteration,
    questionSetKey: clarifyQuestionSetKey(round.questions),
    answers: [
      {
        ...answer,
        confirmedBasis: clarifyAnswerBasis(
          round.questions.find((question) => question.id === answer.questionId)!,
          answer,
        ),
      },
    ],
  })
  await expect
    .poll(async () => (await workspace()).host.executionRef, { timeout: 90_000 })
    .toBeNull()

  // Bind an actual published profile before freezing and reviewing the basis. The design
  // fixture's manual obligation must never act as a green receipt for the repaired tree.
  const document = structuredClone((await workspace()).document)
  const profileRef = (
    await api<(ExactRef & { digest: string })[]>(`${base}/verification-profiles`)
  ).find((item) => item.id === profile.id && item.revision === profile.revision)!
  expect(profileRef.digest).toMatch(/^[a-f0-9]{64}$/)
  const obligation = document.obligations.find((item) => item.id === 'acceptance')!
  obligation.verification = {
    kind: 'execution',
    profileRef: { id: profileRef.id, revision: profileRef.revision, digest: profileRef.digest },
    testRefs: [testRef],
  }
  await api(`${base}/changes`, {
    requestId: `${tag}:automatic-profile`,
    expectedRevision: document.revision,
    document,
  })
  const frozen = await api<{ basis: GraphImplementationBasis }>(`${base}/baseline-previews`, {
    requestId: `${tag}:basis`,
    expectedRevision: (await workspace()).document.revision,
    includedElementIds: ['requirement'],
  })
  await api(`${base}/review-requests`, { requestId: `${tag}:review`, basisId: frozen.basis.id })
  let reviewId = ''
  await expect
    .poll(
      async () => {
        const current = await workspace()
        const reviews = await api<{ nodeRunId: string; taskId: string }[]>(
          '/api/reviews?status=pending',
        )
        reviewId =
          reviews.find((item) => item.taskId === current.host.executionRef)?.nodeRunId ?? ''
        return reviewId
      },
      { timeout: 90_000 },
    )
    .toBeTruthy()
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon!.baseUrl, token: daemon!.token },
  )
  await page.goto(`${daemon!.baseUrl}/reviews/${reviewId}`)
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await workspace()).executionLinks.some((link) => link.receipt?.decision === 'approved'),
      { timeout: 60_000 },
    )
    .toBe(true)
  // The browser is idle until the design tab check below. Leaving the task page stops its
  // polling and rendering while the daemon runs the long care loop: on Ubuntu WebKit that
  // load made the loop miss the wait below (runs 40700896223 and 40888202808).
  await page.goto('about:blank')
  const reviewReceipt = (await workspace()).executionLinks.find(
    (link) => link.receipt?.decision === 'approved',
  )!.receipt!
  await api(`${base}/implementation-requests`, {
    requestId: `${tag}:implement`,
    basisId: frozen.basis.id,
    reviewReceiptId: reviewReceipt.id,
  })
  await expect
    .poll(async () => (await caseProjection()).detail.delivery?.status, {
      timeout: 90_000,
      intervals: [1_000, 2_500, 5_000],
    })
    .toBe('active')
  const initial = (await caseProjection()).detail.delivery!
  expect(initial.headSha).toMatch(/^[a-f0-9]{40}$/)
  const initialRemote = (await mocks.snapshot()).codeHosts.find(
    (item) => item.projectPath === projectPath,
  )!
  const initialMr = singleCaseMr(initialRemote)
  expect(initialMr).toMatchObject({
    headSha: initial.headSha,
    sourceBranch: initial.sourceBranch,
    targetBranch: initial.targetBranch,
  })
  const firstEvidence = await evidence()
  const oldExecutions = firstEvidence.evidence.filter(
    (row) => row.evidence.kind === 'execution' && row.evidence.result === 'passed',
  )
  expect(oldExecutions.length).toBeGreaterThan(0)
  const oldTree = oldExecutions[0]!.evidence.candidateTreeOid!
  expect(oldExecutions.every((row) => row.evidence.candidateTreeOid === oldTree)).toBe(true)

  async function profileProof(binding: GraphEvidenceBinding, baselineSha: string) {
    const artifact = await api<{ files: { path: string; content: string }[] }>(
      `${base}/evidence/${encodeURIComponent(binding.id)}/artifacts`,
    )
    // Node fetch is not captured in the browser trace. Retain the exact receipt
    // and output files before assertions so platform failures remain diagnosable.
    await retainProfileDiagnostic(
      `graph-profile-${createHash('sha256').update(binding.id).digest('hex').slice(0, 12)}.json`,
      {
        body: Buffer.from(JSON.stringify({ binding, baselineSha, artifact }, null, 2)),
        contentType: 'application/json',
      },
    )
    const retained = JSON.parse(
      artifact.files.find((file) => file.path === 'execution.json')!.content,
    ) as {
      basisDigest: string
      candidate: { treeOid: string; repositoryBaseline: { kind: string; commitSha: string } }
      receipt: { ok: boolean }
      profile: { id: string; revision: number; digest: string }
      testReferencesChecked: string[]
    }
    expect(retained).toMatchObject({
      basisDigest: frozen.basis.digest,
      candidate: {
        treeOid: binding.candidateTreeOid,
        repositoryBaseline: { kind: 'commit', commitSha: baselineSha },
      },
      receipt: { ok: true },
      profile: { id: profile.id, revision: profile.revision, digest: profileRef.digest },
    })
    const output = artifact.files
      .filter((file) => file.path.startsWith('logs/'))
      .map((file) => file.content)
      .join('\n')
    const line = output.split(/\r?\n/).find((value) => value.startsWith('RFC396_PROFILE_PROOF '))
    if (!line && process.platform === 'win32' && test.info().retry === 0) {
      // Keep the failed attempt's evidence; do not repeat this probe on retry.
      // This extra time is only for diagnosis: the original assertion still fails.
      test.setTimeout(test.info().timeout + 75_000)
      await attachWindowsProfileDiagnostic(generatedFiles, retainProfileDiagnostic)
    }
    expect(
      line,
      `Retained artifact paths: ${artifact.files.map((file) => file.path).join(', ')}\n${output}`,
    ).toBeTruthy()
    return JSON.parse(line!.slice('RFC396_PROFILE_PROOF '.length)) as {
      pipelineRevision: string
      sourceSha256: string
      testRef: string
      care: CareProof | null
    }
  }
  expect(await profileProof(oldExecutions[0]!.evidence, project.baseSha)).toMatchObject({
    pipelineRevision: 'initial',
    sourceSha256: createHash('sha256').update(sourceBefore).digest('hex'),
    testRef,
    care: null,
  })

  // Only external CI facts change here. The production observer opens the care round,
  // the registered classifier dispatches repair, and its real Task reads hydrated files.
  await mocks.seedDevelopmentPipeline({
    headSha: initial.headSha,
    targetSha: project.baseSha,
    gates: [
      {
        gateKey: 'graph-behavior-ci',
        required: true,
        status: 'fail',
        runRef: `rfc396-red-${tag}`,
        attempt: 1,
        retryability: 'unsafe',
        failureCategories: ['rfc396-regression'],
        logs: [{ logId: 'rfc396-care-failure', bytes: 1024 }],
      },
    ],
  })
  await expect
    .poll(
      async () => {
        const delivery = (await caseProjection()).detail.delivery
        return delivery?.status === 'active' && delivery.headSha !== initial.headSha
          ? delivery.headSha
          : ''
      },
      // The 30 s code-host poll, collection, classification, the repair Task, profile re-verification
      // and the push all sit inside this wait. Windows CI: both attempts of run 40521324441 missed a
      // 90 s window here (the first attempt of run 40514130589 passed). The whole test took 1.4 min on
      // Chromium (run 40888196835) and 2.7 min on macOS WebKit, while Ubuntu WebKit missed 180 s in
      // both attempts of runs 40700896223 and 40888202808; 240 s keeps the test inside its 10 min.
      { timeout: 240_000, intervals: [1_000, 2_500, 5_000] },
    )
    .toMatch(/^[a-f0-9]{40}$/)
  const repaired = await caseProjection()
  expect(repaired.case).toMatchObject({
    id: caseId,
    typeRef: { typeId: 'graph-development', revision: 2 },
    terminalKind: null,
  })
  expect(repaired.detail.delivery).toMatchObject({
    ref: initial.ref,
    sourceBranch: initial.sourceBranch,
    targetBranch: initial.targetBranch,
    status: 'active',
  })
  const repairRounds = repaired.rounds.filter((item) => item.workItemRef === 'repair-pipeline')
  expect(repairRounds).toHaveLength(1)
  expect(repairRounds[0]!.state).toBe('completed')
  expect(repairRounds[0]!.executionRef).toBeTruthy()
  expect(
    repaired.rounds.some((item) => item.workItemRef === 'classify-pipeline' && item.executionRef),
  ).toBe(true)
  const repairTask = await api<{ id: string }>(`/api/tasks/${repairRounds[0]!.executionRef}`)
  expect(repairTask.id).toBe(repairRounds[0]!.executionRef)

  const secondEvidence = await evidence()
  const newExecution = secondEvidence.evidence.find(
    (row) =>
      row.evidence.kind === 'execution' &&
      row.evidence.result === 'passed' &&
      row.evidence.candidateTreeOid !== oldTree,
  )
  expect(newExecution).toBeTruthy()
  expect(newExecution!.freshness).toBe('current')
  expect(newExecution!.evidence.id).toMatch(/^execution:mr:/)
  expect(oldExecutions.map((row) => row.evidence.executionRef)).not.toContain(
    newExecution!.evidence.executionRef,
  )
  for (const old of oldExecutions) {
    const historical = secondEvidence.evidence.find((row) => row.evidence.id === old.evidence.id)!
    expect(historical.freshness).toBe('stale')
    expect(historical.reasons).toContain('different-candidate-content')
  }
  expect(secondEvidence.obligations.find((item) => item.obligationId === 'acceptance')?.state).toBe(
    'passed',
  )
  const proof = await profileProof(newExecution!.evidence, initial.headSha)
  expect(proof).toMatchObject({
    pipelineRevision: 'repaired',
    sourceSha256: createHash('sha256').update(sourceAfter).digest('hex'),
    testRef,
    care: {
      caseId,
      basisId: frozen.basis.id,
      basisDigest: frozen.basis.digest,
      reviewReceiptId: reviewReceipt.id,
      testRef,
    },
  })
  expect(proof.care!.priorExecutionIds).toEqual(
    expect.arrayContaining(oldExecutions.map((row) => row.evidence.id)),
  )
  expect(proof.care!.priorTrees).toContain(oldTree)
  expect(proof.care!.logText).toContain('rfc396-care-failure')

  const remote = (await mocks.snapshot()).codeHosts.find(
    (item) => item.projectPath === projectPath,
  )!
  const mr = singleCaseMr(remote)
  expect(mr).toMatchObject({
    id: initialMr.id,
    number: initialMr.number,
    headSha: repaired.detail.delivery!.headSha,
    sourceBranch: initial.sourceBranch,
    targetBranch: initial.targetBranch,
  })
  const raw = async (filename: string, headSha: string) => {
    const response = await fetch(
      `${process.env.AW_SYSTEM_MOCK_GITLAB_API_BASE_URL}/projects/${encodeURIComponent(projectPath)}/repository/files/${encodeURIComponent(filename)}/raw?ref=${headSha}`,
      { headers: { 'PRIVATE-TOKEN': SYSTEM_MOCK_CODE_HOST_TOKEN } },
    )
    expect(response.ok).toBe(true)
    return await response.text()
  }
  expect(await raw('graph-result.cjs', initial.headSha)).toBe(sourceBefore)
  expect(await raw('graph-result.cjs', mr.headSha)).toBe(sourceAfter)
  expect(JSON.parse(await raw('care-proof.json', mr.headSha))).toEqual(proof.care)
  // The new head also requires a new external check; the red old-head fact is not reused.
  await mocks.seedDevelopmentPipeline({
    headSha: mr.headSha,
    targetSha: project.baseSha,
    gates: [
      {
        gateKey: 'graph-behavior-ci',
        required: true,
        status: 'pass',
        runRef: `rfc396-green-${tag}`,
        attempt: 1,
        retryability: 'safe',
        failureCategories: [],
        logs: [],
      },
    ],
  })
  await expect
    // The daemon pulls the seeded pipeline on its own observation cadence; on Windows CI the first
    // attempt of run 40461800472 missed a 60 s window and the retry passed.
    .poll(async () => (await caseProjection()).detail.delivery?.readyToMerge, {
      timeout: 180_000,
      intervals: [1_000, 2_500, 5_000],
    })
    .toBe(true)
  await mocks.mutateCodeHost({
    kind: 'set-mr-state',
    provider: 'gitlab',
    projectPath,
    number: mr.number,
    state: 'closed',
  })
  await expect
    .poll(
      async () => ({
        state: (await caseProjection()).case.state,
        status: (await caseProjection()).detail.delivery?.status,
      }),
      // Same external-observation cadence as readyToMerge above.
      { timeout: 180_000, intervals: [1_000, 2_500, 5_000] },
    )
    .toEqual({ state: 'terminal', status: 'closed' })
  const closedProject = (await mocks.snapshot()).codeHosts.find(
    (item) => item.projectPath === projectPath,
  )!
  expect(singleCaseMr(closedProject)).toMatchObject({
    id: initialMr.id,
    number: initialMr.number,
    sourceBranch: initialMr.sourceBranch,
    targetBranch: initialMr.targetBranch,
    headSha: mr.headSha,
    state: 'closed',
  })
  await page.goto(`${daemon!.baseUrl}/tasks/employee-cases/${caseId}?tab=design`)
  await expect(page.getByTestId('graph-design-workspace')).toBeVisible()
  await test.info().attach('graph-care-material-and-profile-evidence', {
    body: Buffer.from(
      JSON.stringify(
        {
          caseId,
          designId,
          basisDigest: frozen.basis.digest,
          reviewReceiptId: reviewReceipt.id,
          repairRound: repairRounds[0],
          seededMergeRequests,
          mr: {
            number: mr.number,
            sourceBranch: mr.sourceBranch,
            targetBranch: mr.targetBranch,
            originalHead: initial.headSha,
            repairedHead: mr.headSha,
          },
          originalExecutionIds: oldExecutions.map((row) => row.evidence.id),
          repairExecution: newExecution,
          profileProof: proof,
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  })
})
