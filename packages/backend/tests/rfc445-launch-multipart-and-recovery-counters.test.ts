// RFC-445 — 启动 multipart 信封与恢复计数归 platform，上传兼容层退役（RFC-294 W4 B / D 第十一步）。
//
// 锁四件事：
// ① 位置：`services/launchMultipart`、`services/upload` 不存在；信封在 `platform/http/multipartLaunch.ts`，其余上传助手按层在
//    task-execution（`domain/uploads`、`application/launchUploads`、`infrastructure/local/fileTaskLaunchConfiguration`）。
// ② 引用：源码里没有任何文件 import 两个旧路径（census 的 AST 提取；别名与相对路径都认，带负对照）；`routes/agents.ts`、
//    `routes/health.ts` 不 import `services/`。
// ③ 计数只有一份：恢复计数只在 `platform/health/recoveryCounters.ts` 声明；四处累加点与 `/health` 只经它取；
//    `services/recovery.ts`（RFC-452 起为 task-execution `application/recovery/recoveryEvents.ts`）只剩审计写入与查询，写入仍累加同一份计数。
// ④ 行为：信封解析与四个错误码；先核对声明再复制字节；回收失败时的错误合成。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  attachWorkspaceCleanupToMultipartError,
  bufferUploadParts,
} from '@/modules/task-execution/application/launchUploads'
import { collectUploadInputDefs } from '@/modules/task-execution/domain/uploads'
import {
  __resetRecoveryCountersForTest,
  bumpRecoveryCounter,
  recoveryCountersSnapshot,
} from '@/platform/health/recoveryCounters'
import { parseMultipartLaunch } from '@/platform/http/multipartLaunch'
import * as recovery from '@/modules/task-execution/application/recovery/recoveryEvents'
import { DomainError, ValidationError } from '@/util/errors'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const OLD_PATHS = ['services/launchMultipart', 'services/upload'] as const
const COUNTERS = 'platform/health/recoveryCounters'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 文件的全部模块说明符（静态 / 类型 / 动态 import、export-from、require），去重；与 R1 账本同一口径。 */
function specifiersOf(path: string): string[] {
  const rel = relative(REPO_ROOT, path).split('\\').join('/')
  const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
  return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
}

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function targetsOf(rel: string): string[] {
  const path = join(SRC, rel)
  return specifiersOf(path).flatMap((specifier) => targetOf(path, specifier) ?? [])
}

async function rejectionCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  throw new Error('expected a DomainError')
}

function launchRequest(form: FormData): Request {
  return new Request('http://daemon.test/api/tasks', { method: 'POST', body: form })
}

describe('RFC-445 —— 位置', () => {
  test('两个 legacy 文件不再存在，信封、上传助手与计数各在新位置', () => {
    for (const old of OLD_PATHS) expect(existsSync(join(SRC, `${old}.ts`))).toBe(false)
    for (const file of [
      'platform/http/multipartLaunch.ts',
      'platform/health/recoveryCounters.ts',
      'modules/task-execution/application/launchUploads.ts',
      'modules/task-execution/domain/uploads.ts',
      'modules/task-execution/infrastructure/local/fileTaskLaunchConfiguration.ts',
    ])
      expect(existsSync(join(SRC, file))).toBe(true)
  })
})

describe('RFC-445 —— 引用', () => {
  test('源码里没有文件 import 两个旧路径', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(500)
    const offenders: string[] = []
    let envelopeConsumers = 0
    for (const path of files) {
      for (const specifier of specifiersOf(path)) {
        const target = targetOf(path, specifier)
        if (target !== null && (OLD_PATHS as readonly string[]).includes(target))
          offenders.push(`${relative(SRC, path)} -> ${specifier}`)
        if (target === 'platform/http/multipartLaunch') envelopeConsumers += 1
      }
    }
    expect(offenders).toEqual([])
    // 非空对照：单 agent 启动路由、task-execution 的 multipart 启动编排与 legacy 执行类型都取新信封。
    expect(envelopeConsumers).toBeGreaterThan(0)
  }, 60_000)

  test('负对照：同一判据认得出别名与相对路径两种写法', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(targetOf(probe, '@/services/upload')).toBe('services/upload')
    expect(targetOf(probe, '../services/launchMultipart.ts')).toBe('services/launchMultipart')
    expect(targetOf(probe, '@agent-workflow/shared')).toBeNull()
  })

  test('agents 与 health 路由不 import services/', () => {
    // 非空对照：每个路由都解析出了本地目标（含本 RFC 改到的新位置），判据不是空集上的恒真。
    const expectedNewTarget = {
      'routes/agents.ts': 'platform/http/multipartLaunch',
      'routes/health.ts': COUNTERS,
    } as const
    for (const [route, newTarget] of Object.entries(expectedNewTarget)) {
      const targets = targetsOf(route)
      expect(targets, route).toContain(newTarget)
      expect(
        targets.filter((target) => target.startsWith('services/')),
        route,
      ).toEqual([])
    }
  })
})

describe('RFC-445 —— 恢复计数只有一份', () => {
  beforeEach(() => __resetRecoveryCountersForTest())
  afterEach(() => __resetRecoveryCountersForTest())

  test('四处累加点、/health 与恢复审计都只经 platform/health/recoveryCounters', () => {
    for (const site of [
      'routes/health.ts',
      'platform/persistence/sqlite/systemProviderRestore.ts',
      'modules/system-operations/infrastructure/resourceLimitAudit.ts',
      'modules/task-execution/infrastructure/taskIdleTimeoutPersistence.ts',
      'modules/task-execution/application/recovery/recoveryEvents.ts',
    ]) {
      expect(targetsOf(site), site).toContain(COUNTERS)
    }
    // 计数函数只在新文件里声明一次。
    const declaring = walk(SRC)
      .filter((path) =>
        /export\s+function\s+(?:bumpRecoveryCounter|recoveryCountersSnapshot|__resetRecoveryCountersForTest)\b/.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map((path) => relative(SRC, path).split('\\').join('/'))
    expect(declaring).toEqual([`${COUNTERS}.ts`])
  })

  test('恢复审计（RFC-452 起在 task-execution application/recovery）只剩审计写入与查询；写入仍累加同一份计数', async () => {
    expect(Object.keys(recovery).sort()).toEqual([
      'listRecoveryEventsForTask',
      'recordRecoveryEvent',
    ])
    const recorded: string[] = []
    await recovery.recordRecoveryEvent(
      { recordEvent: async (input) => void recorded.push(input.kind) },
      { kind: 'auto-resume', taskId: 'task-1' },
    )
    bumpRecoveryCounter('restore')
    bumpRecoveryCounter('restore', 2)
    expect(recorded).toEqual(['auto-resume'])
    expect(recoveryCountersSnapshot()).toEqual({ 'auto-resume': 1, restore: 3 })
    __resetRecoveryCountersForTest()
    expect(recoveryCountersSnapshot()).toEqual({})
  })
})

describe('RFC-445 —— 信封解析（platform/http/multipartLaunch）', () => {
  test('payload 与 files[<key>][] 部件原样解析；未命名文件记为 upload.bin；不复制字节', async () => {
    const form = new FormData()
    form.set('payload', JSON.stringify({ workflowId: 'wf-1', inputs: { topic: 'orders' } }))
    form.append('files[docs][]', new Blob(['alpha'], { type: 'application/pdf' }), 'a.pdf')
    // 输入键原样保留（不收窄为 ASCII）；第三个参数为空串即序列化为 filename=""。
    form.append('files[参考资料][]', new Blob(['beta'], { type: 'image/png' }), '')
    const parsed = await parseMultipartLaunch(launchRequest(form))
    expect(parsed.payloadJson).toEqual({ workflowId: 'wf-1', inputs: { topic: 'orders' } })
    expect(parsed.parts.map(({ inputKey, filename }) => ({ inputKey, filename }))).toEqual([
      { inputKey: 'docs', filename: 'a.pdf' },
      { inputKey: '参考资料', filename: 'upload.bin' },
    ])
    // 声明的 MIME 取部件自带的类型、不改写。未命名部件的类型由 bun 的 multipart 传输决定（`filename=""` 的部件解析后
    // 类型为空），所以只断言与部件一致，不钉具体值。
    expect(parsed.parts[0]!.declaredMime).toBe('application/pdf')
    for (const part of parsed.parts) expect(part.declaredMime).toBe(part.blob.type)
    expect(await parsed.parts[1]!.blob.text()).toBe('beta')
  })

  test('缺 payload、payload 非 JSON、未知字段、字段是字符串，分别抛原错误码', async () => {
    const missing = new FormData()
    missing.append('files[docs][]', new Blob(['x']), 'x.txt')
    expect(await rejectionCode(() => parseMultipartLaunch(launchRequest(missing)))).toBe(
      'task-multipart-payload-missing',
    )

    const invalid = new FormData()
    invalid.set('payload', '{not json')
    expect(await rejectionCode(() => parseMultipartLaunch(launchRequest(invalid)))).toBe(
      'task-multipart-payload-invalid',
    )

    const unknown = new FormData()
    unknown.set('payload', '{}')
    unknown.append('strayField', new Blob(['x']), 'x.txt')
    expect(await rejectionCode(() => parseMultipartLaunch(launchRequest(unknown)))).toBe(
      'task-multipart-unknown-field',
    )

    const text = new FormData()
    text.set('payload', '{}')
    text.append('files[docs][]', 'not a file')
    expect(await rejectionCode(() => parseMultipartLaunch(launchRequest(text)))).toBe(
      'task-multipart-string-not-file',
    )
  })
})

describe('RFC-445 —— 上传助手（task-execution）', () => {
  class CountingBlob extends Blob {
    static reads = 0
    override async arrayBuffer(): Promise<ArrayBuffer> {
      CountingBlob.reads += 1
      return await super.arrayBuffer()
    }
  }

  const defs = collectUploadInputDefs([
    { kind: 'upload', key: 'docs', label: 'Docs', targetDir: 'inputs/docs' },
  ])

  test('未声明的输入键在复制任何字节前被拒；声明内的部件按序缓冲', async () => {
    CountingBlob.reads = 0
    const part = (inputKey: string, body: string) => ({
      inputKey,
      filename: `${inputKey}.txt`,
      declaredMime: 'text/plain',
      blob: new CountingBlob([body]),
    })
    expect(
      await rejectionCode(() => bufferUploadParts([part('docs', 'a'), part('ghost', 'b')], defs)),
    ).toBe('task-multipart-unknown-input')
    expect(CountingBlob.reads).toBe(0)

    const files = await bufferUploadParts([part('docs', 'a'), part('docs', 'bc')], defs)
    expect(CountingBlob.reads).toBe(2)
    expect(files.map((file) => [file.inputKey, new TextDecoder().decode(file.bytes)])).toEqual([
      ['docs', 'a'],
      ['docs', 'bc'],
    ])
  })

  test('回收完整时原样返回上传错误；不完整时报告并入 details；非领域错误归为 task-upload-failed', () => {
    const primary = new ValidationError('upload-max-count', 'too many files', { inputKey: 'docs' })
    expect(attachWorkspaceCleanupToMultipartError(primary, { complete: true })).toBe(primary)

    const report = { complete: false, failures: ['worktree-remove'] }
    const decorated = attachWorkspaceCleanupToMultipartError(primary, report)
    expect([decorated.code, decorated.status, decorated.message]).toEqual([
      primary.code,
      primary.status,
      primary.message,
    ])
    expect(decorated.details).toEqual({ inputKey: 'docs', workspaceCleanup: report })

    const generic = attachWorkspaceCleanupToMultipartError(new Error('disk full'), {
      complete: true,
    })
    expect(generic.code).toBe('task-upload-failed')
    expect(generic.message).toContain('disk full')
  })
})
