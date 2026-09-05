// RFC-359 W4-D6c 补 —— 启动期并发注册的幂等性。作者面存储改成真异步之后（4c7069b06），同一拍里构造的两份
// DigitalEmployeeAuthoringService（路由层一份、worker 一份）并发注册同一个类型包，读—插之间出现让出点，第二个
// insert 撞 (type_id, revision) 主键，daemon 在 8f89a3ee4 / d03fc3694 的 CI 上直接起不来：
// `UNIQUE constraint failed: employee_type_packages.type_id, employee_type_packages.revision`。
// 本文件把「并发 ensure 幂等、漂移仍报错、并发 ensureExecutionPolicy 只产生一个 revision、两份装配同拍就绪」
// 锁在两个引擎上，同一段断言各跑一遍。

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import {
  DEFAULT_GLOBAL_EXECUTION_POLICY,
  contentDigest,
  employeeTypePackageDescriptorSchema,
  packageDigest,
  type EmployeeTypePackageDescriptor,
} from '@/modules/digital-employee/domain/model'
import type { TypePackageRecord } from '@/modules/digital-employee/application/ports/authoringStore'
import { createDigitalEmployeeAuthoringPersistence } from '@/modules/digital-employee/infrastructure/authoringStore'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

const descriptor = employeeTypePackageDescriptorSchema.parse(
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as unknown,
)

function descriptorAt(revision: number): EmployeeTypePackageDescriptor {
  const copy = structuredClone(descriptor)
  copy.typeRef.revision = revision
  return copy
}

function packageRecord(
  pkg: EmployeeTypePackageDescriptor,
  digest = packageDigest(pkg),
): TypePackageRecord {
  return { descriptor: pkg, descriptorDigest: digest, state: 'published', registeredAt: NOW }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

const executionContracts: ExecutionContractParticipant = {
  list: () => [],
  get: () => {
    throw new Error('bootstrap idempotency test does not execute a reaction')
  },
  async validateExecutor({ contractRef }) {
    return {
      schemaVersion: 1,
      contractRef,
      status: 'valid',
      checks: [{ code: 'bootstrap-test-contract', ok: true, detail: 'test contract' }],
    }
  },
  async validateAgentCandidates() {
    return []
  },
  validateEnvelope() {
    throw new Error('bootstrap idempotency test does not settle a reaction')
  },
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('RFC-359 W4-D6c 补 —— 启动期并发注册的幂等性', (harness) => {
  test('并发 ensureTypePackage：两份存储同拍注册同一个类型包只落一行，漂移仍按同一条规则报错', async () => {
    const first = createDigitalEmployeeAuthoringPersistence(harness.db)
    const second = createDigitalEmployeeAuthoringPersistence(harness.db)
    const pkg = descriptorAt(41)
    await Promise.all([
      first.ensureTypePackage(packageRecord(pkg)),
      second.ensureTypePackage(packageRecord(pkg)),
      first.ensureTypePackage(packageRecord(pkg)),
    ])
    const registrations = (await first.listTypePackageRegistrations()).filter(
      (registration) =>
        registration.typeRef.typeId === pkg.typeRef.typeId && registration.typeRef.revision === 41,
    )
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.descriptorDigest).toBe(packageDigest(pkg))
    // 已注册后再来一次同 digest 是 no-op；不同 digest 仍是漂移。
    await second.ensureTypePackage(packageRecord(pkg))
    expect(await codeOf(() => second.ensureTypePackage(packageRecord(pkg, 'sha256:drifted')))).toBe(
      'employee-type-revision-drift',
    )
  })

  test('并发 ensureExecutionPolicy：两份装配拿到同一个 revision，全局策略只发布一次', async () => {
    const first = createDigitalEmployeeAuthoringPersistence(harness.db)
    const second = createDigitalEmployeeAuthoringPersistence(harness.db)
    const input = {
      content: DEFAULT_GLOBAL_EXECUTION_POLICY,
      contentDigest: contentDigest(DEFAULT_GLOBAL_EXECUTION_POLICY),
      publishedAt: NOW,
      publishedBy: null,
    }
    const [left, right] = await Promise.all([
      first.ensureExecutionPolicy(input),
      second.ensureExecutionPolicy(input),
    ])
    expect(right.revision).toBe(left.revision)
    expect((await first.getCurrentExecutionPolicy())?.revision).toBe(left.revision)
    expect((await second.ensureExecutionPolicy(input)).revision).toBe(left.revision)
  })

  test('两份装配同拍构造：ready() 都成立，类型包在两边都可见', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc359-d6c-bootstrap-'))
    roots.push(appHome)
    const options = {
      db: harness.db,
      appHome,
      typePackages: [developmentEmployeeTypePackage],
      executionContracts,
    }
    const routeSide = composeDigitalEmployee(options)
    const workerSide = composeDigitalEmployee(options)
    await Promise.all([routeSide.maintenance.ready(), workerSide.maintenance.ready()])
    for (const module of [routeSide, workerSide]) {
      expect((await module.queries.listTypes()).map((item) => item.typeRef.typeId)).toContain(
        descriptor.typeRef.typeId,
      )
    }
  })
})
