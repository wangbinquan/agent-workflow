// RFC-310 T20 —— 配置 package codec 测试。
//
// 锁：①build → inspect round-trip（digest 由 build 计算、inspect 重验）；
// ②未知 formatVersion 单列拒绝（不猜字段）；③digest 篡改/重名逐条列出；
// ④strict：包级与资源级 unknown key 全拒。

import { describe, expect, test } from 'bun:test'

import {
  buildConfigPackage,
  CONFIG_PACKAGE_FORMAT_VERSION,
  inspectConfigPackage,
} from '@/modules/development-automation/domain/configPackage'
import { unknownKeySurvivors } from './helpers/rfc310UnknownKeyHarness'
import { configPackageSchema } from '@/modules/development-automation/domain/configPackage'

const EXPORTED_AT = '2026-08-18T12:00:00+00:00'

function samplePackage() {
  return buildConfigPackage({
    exportedAt: EXPORTED_AT,
    resources: [
      {
        type: 'automation-policy',
        name: 'default-policy',
        resourceId: 'pol-1',
        revision: 3,
        content: { schemaVersion: 1, sample: true },
      },
      {
        type: 'digital-employee',
        name: 'java-employee',
        resourceId: 'emp-1',
        revision: 2,
        content: { schemaVersion: 1, routes: [] },
      },
    ],
  })
}

describe('rfc310 config package codec', () => {
  test('build → inspect round-trips with zero issues', () => {
    const pkg = samplePackage()
    const result = inspectConfigPackage(JSON.parse(JSON.stringify(pkg)))
    expect(result.issues).toEqual([])
    expect(result.pkg?.resources).toHaveLength(2)
    expect(result.pkg?.formatVersion).toBe(CONFIG_PACKAGE_FORMAT_VERSION)
  })

  test('unknown format version is refused with its own code, not field-guessed', () => {
    const pkg = { ...samplePackage(), formatVersion: 99 }
    const result = inspectConfigPackage(pkg)
    expect(result.pkg).toBeNull()
    expect(result.issues).toEqual([{ code: 'unknown-format-version', observed: 99 }])
  })

  test('digest tamper and duplicate names are itemized', () => {
    const pkg = JSON.parse(JSON.stringify(samplePackage())) as {
      resources: { name: string; content: unknown; contentDigest: string; type: string }[]
    }
    pkg.resources[0]!.content = { schemaVersion: 1, sample: false }
    pkg.resources[1]!.name = 'dup'
    pkg.resources.push(JSON.parse(JSON.stringify(pkg.resources[1]!)))
    const result = inspectConfigPackage(pkg)
    expect(result.pkg).toBeNull()
    expect(result.issues).toContainEqual({
      code: 'digest-mismatch',
      resourceName: 'default-policy',
    })
    expect(result.issues).toContainEqual({ code: 'duplicate-resource', resourceName: 'dup' })
  })

  test('strict at every level: unknown keys rejected package-wide', () => {
    const pkg = samplePackage()
    // content 是 z.unknown()（各资源 codec 另行校验），把它换成叶子标量后
    // harness 覆盖包结构本身的每一层。
    const fixture = JSON.parse(JSON.stringify(pkg)) as { resources: { content: unknown }[] }
    for (const r of fixture.resources) r.content = 'opaque'
    const survivors = unknownKeySurvivors(configPackageSchema, fixture)
    // content 层刻意开放（z.unknown），root/resources/upstream 各层必须全拒。
    expect(survivors).toEqual([])
  })
})
