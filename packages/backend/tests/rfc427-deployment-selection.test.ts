// RFC-427: the deployment is selected once (the only read of AW_DEPLOYMENT_MODE); `migrate` and the two hosted
// verification commands are operations of the selected deployment, and an operation a deployment does not offer fails
// with one error type whose text is unchanged from before RFC-427 (scripts and runbooks match on it).
import { expect, test } from 'bun:test'
import {
  DeploymentModeError,
  DeploymentOperationUnavailableError,
  selectDeployment,
} from '@/bootstrap/deployment'

test('each mode selects its deployment; an invalid mode is refused at selection', () => {
  expect(selectDeployment({}).kind).toBe('standalone')
  expect(selectDeployment({ AW_DEPLOYMENT_MODE: 'standalone' }).kind).toBe('standalone')
  expect(selectDeployment({ AW_DEPLOYMENT_MODE: 'crewstation' }).kind).toBe('crewstation')
  // Platform variables alone never switch the deployment.
  expect(selectDeployment({ CS_PROJECT: 'project', CS_SERVICE: 'service' }).kind).toBe('standalone')
  expect(() => selectDeployment({ AW_DEPLOYMENT_MODE: 'cloud' })).toThrow(DeploymentModeError)
})

test('standalone refuses the hosted verification commands with one error type and the unchanged text', async () => {
  const deployment = selectDeployment({})
  for (const [operation, text] of [
    [
      () => deployment.verifyDatabaseRestore(),
      'database restore verification requires CrewStation deployment',
    ],
    [
      () => deployment.verifyDatabaseMigration(),
      'database migration verification requires CrewStation deployment',
    ],
  ] as const) {
    let refused: unknown
    try {
      await operation()
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(DeploymentOperationUnavailableError)
    expect((refused as Error).message).toBe(text)
  }
})

test('a hosted deployment keeps the environment it was selected with', async () => {
  const env: Record<string, string | undefined> = { AW_DEPLOYMENT_MODE: 'crewstation' }
  const deployment = selectDeployment(env)
  env.AW_DEPLOYMENT_MODE = 'standalone'
  expect(deployment.kind).toBe('crewstation')
  // Its operations run the hosted path on the selected environment: missing platform inputs are reported, never a
  // standalone refusal.
  let verification: unknown
  try {
    await deployment.verifyDatabaseRestore()
  } catch (error) {
    verification = error
  }
  expect(verification).not.toBeInstanceOf(DeploymentOperationUnavailableError)
  expect(String(verification)).toContain('CS_PROJECT')
  await expect(deployment.profile()).rejects.toThrow('CS_PROJECT')
})
