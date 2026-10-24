// RFC-370 收口遗留：design/RFC-370-crewstation-hosted-deployment/status.md 的
// v0.6.26「数字员工创作接口非法请求体返回 500」；同因见 docs/audit-backlog.md RFC-319 DE-41 第 2 项。
// 两个 provider 经真实创作、发布与案例 HTTP 链，覆盖 route / service 解析和 null body。

import { expect, setDefaultTimeout, test } from 'bun:test'

import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createSession } from './helpers/auth/sessionStore'
import { createUser } from './helpers/userFixture'

setDefaultTimeout(120_000)

describeEachProviderHttpApplication(
  'RFC-370 digital employee invalid request bodies',
  {
    token: 'a'.repeat(64),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc370-employee-input-',
  },
  (scope) => {
    test('authoring and case commands return typed 422 and retain their valid HTTP journey', async () => {
      const { app } = await scope.open()
      const admin = await createUser(scope.harness.db, {
        username: 'rfc370-employee-admin',
        displayName: 'Admin',
        role: 'admin',
        password: 'longEnoughPassword',
      })
      const { token } = await createSession({ db: scope.harness.db, userId: admin.id })
      const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
        app.request(path, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      async function success<T>(
        method: string,
        path: string,
        body: unknown,
        status = 200,
      ): Promise<T> {
        const response = await request(method, path, body)
        expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(status)
        return (await response.json()) as T
      }
      async function invalid(
        method: string,
        path: string,
        bodies: readonly unknown[],
        code: string,
      ) {
        for (const body of bodies) {
          const response = await request(method, path, body)
          expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(422)
          expect(await response.json()).toMatchObject({ ok: false, code })
        }
      }

      const types = await success<{
        items: Array<{ typeRef: { typeId: string; revision: number } }>
      }>('GET', '/api/digital-employee-types', undefined)
      const typeRef = types.items.find((item) => item.typeRef.typeId === 'development')!.typeRef
      const typePath = `/api/digital-employee-types/${typeRef.typeId}@${typeRef.revision}`
      const toolsPath = `${typePath}/work-items/analyze-implement/tools`
      const agents = await success<
        Array<{
          id: string
          updatedAt: number
          frontmatterExtra: { executionContracts?: Array<{ contractId: string }> }
        }>
      >('GET', '/api/agents/builtins/digital-employee-templates', undefined)
      const agent = agents.find((candidate) =>
        candidate.frontmatterExtra.executionContracts?.some(
          (contract) => contract.contractId === 'development.implement-change',
        ),
      )
      expect(agent).toBeDefined()
      const toolBody = {
        displayName: 'Input regression tool',
        description: 'Typed request validation',
        roleRef: 'primary',
        implementation: { kind: 'agent', agentRef: { id: agent!.id, revision: agent!.updatedAt } },
      }
      const badTools = [
        {},
        [],
        null,
        { implementation: { kind: 'agent' } },
        { ...toolBody, displayName: '' },
      ]
      await invalid('POST', toolsPath, badTools, 'validation-failed')
      const tool = await success<{ id: string; content: { displayName: string } }>(
        'POST',
        toolsPath,
        toolBody,
        201,
      )
      expect(tool.content.displayName).toBe(toolBody.displayName)
      await invalid('PUT', `${toolsPath}/${tool.id}`, badTools, 'validation-failed')
      const updatedTool = await success<{ id: string; content: { displayName: string } }>(
        'PUT',
        `${toolsPath}/${tool.id}`,
        { ...toolBody, displayName: 'Updated input tool' },
      )
      expect(updatedTool).toMatchObject({
        id: tool.id,
        content: { displayName: 'Updated input tool' },
      })
      const publishedTool = await success<{ ref: { id: string; revision: number } }>(
        'POST',
        `${toolsPath}/${tool.id}/publish`,
        {},
      )

      const jobsPath = `${typePath}/job-templates`
      await invalid('POST', jobsPath, [{}, [], null, { name: '' }], 'validation-failed')
      const jobBody = {
        name: 'Input regression job',
        description: 'Typed request validation',
        defaultToolBindings: [
          {
            workItemRef: 'analyze-implement',
            slotRef: 'default',
            registrationRef: publishedTool.ref,
          },
        ],
      }
      const job = await success<{ id: string; name: string }>('POST', jobsPath, jobBody, 201)
      expect(job.name).toBe(jobBody.name)
      await invalid(
        'PUT',
        `/api/digital-employee-job-templates/${job.id}`,
        [{}, [], null, { ...jobBody, name: '' }],
        'validation-failed',
      )
      const updatedJob = await success<{ id: string; name: string }>(
        'PUT',
        `/api/digital-employee-job-templates/${job.id}`,
        { ...jobBody, name: 'Updated input job' },
      )
      expect(updatedJob).toMatchObject({ id: job.id, name: 'Updated input job' })
      const publishedJob = await success<{ ref: { id: string; revision: number } }>(
        'POST',
        `/api/digital-employee-job-templates/${job.id}/publish`,
        {},
      )

      const employeesPath = `${typePath}/employees`
      await invalid('POST', employeesPath, [{}, [], null, { name: '' }], 'validation-failed')
      const employeeBody = {
        name: 'Input regression employee',
        jobTemplateRef: publishedJob.ref,
        workScope: { kind: 'repository', repositoryId: 'rfc370-repository' },
      }
      const employee = await success<{ id: string; revision: number }>(
        'POST',
        employeesPath,
        employeeBody,
        201,
      )
      expect(employee.revision).toBe(1)
      await invalid(
        'PUT',
        `/api/digital-employees/${employee.id}`,
        [{}, [], null, { ...employeeBody, name: '' }],
        'validation-failed',
      )
      const updatedEmployee = await success<{ id: string; name: string; revision: number }>(
        'PUT',
        `/api/digital-employees/${employee.id}`,
        { ...employeeBody, name: 'Updated input employee' },
      )
      expect(updatedEmployee).toMatchObject({
        id: employee.id,
        name: 'Updated input employee',
        revision: 2,
      })

      const casesPath = `/api/digital-employees/${employee.id}/cases`
      await invalid('POST', casesPath, [{}, [], null, { kind: 'body' }], 'validation-failed')
      const launched = await success<{ case: { id: string; state: string } }>(
        'POST',
        casesPath,
        {
          name: 'Input regression case',
          kind: 'body',
          target: { repositoryId: 'rfc370-repository' },
          body: 'Validate the unchanged intake flow',
          externalId: null,
          uploads: [],
          idempotencyKey: 'rfc370-valid-intake',
        },
        201,
      )
      expect(launched.case.state).toBe('active')
      const casePath = `/api/employee-cases/${launched.case.id}`
      await invalid(
        'POST',
        `${casePath}/policy-upgrade-preview`,
        [{}, { targetPolicyRevision: 0 }, { targetPolicyRevision: 1, x: 1 }, []],
        'employee-policy-preview-invalid',
      )
      const preview = await success<{ previewToken: string }>(
        'POST',
        `${casePath}/policy-upgrade-preview`,
        { targetPolicyRevision: 1 },
      )
      expect(preview.previewToken.length).toBeGreaterThan(0)
      const applyPath = '/api/employee-cases/policy-upgrade-apply'
      await invalid(
        'POST',
        applyPath,
        [{}, [], null, { previewToken: '' }],
        'employee-policy-preview-invalid',
      )
      const wrongShapeToken = Buffer.from(
        JSON.stringify({ caseId: launched.case.id, garbage: true }),
      ).toString('base64url')
      await invalid(
        'POST',
        applyPath,
        [{ previewToken: wrongShapeToken }],
        'employee-policy-preview-invalid',
      )
      const applied = await success<{ case: { id: string; executionPolicyRevision: number } }>(
        'POST',
        applyPath,
        preview,
      )
      expect(applied.case).toMatchObject({ id: launched.case.id, executionPolicyRevision: 1 })
      await invalid(
        'POST',
        `${casePath}/terminate`,
        [
          {},
          [],
          null,
          { terminalKind: '' },
          { terminalKind: 5 },
          { terminalKind: 'canceled', x: 1 },
        ],
        'employee-terminal-kind-invalid',
      )
      const terminated = await success<{
        case: { id: string; state: string; terminalKind: string }
      }>('POST', `${casePath}/terminate`, { terminalKind: 'canceled' })
      expect(terminated.case).toMatchObject({
        id: launched.case.id,
        state: 'terminal',
        terminalKind: 'canceled',
      })
    })
  },
)
