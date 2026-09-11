// RFC-359 AC-6 —— 双引擎 HTTP 应用的**作用域**：一份实现，18 个用例文件共用。
//
// 为什么存在：`createProviderHttpApplication` 只负责「按 harness 选中的 provider 装一个真应用」，
// 而每个用例文件还要各自再写一遍**生命周期**——建一个专属的 app home、存/还 `AGENT_WORKFLOW_HOME`、
// 在 `afterEach` 里先 dispose 应用再删目录。RFC-359 W49～W51 一路迁过来，这段 40 余行被**逐字抄了
// 18 份**（`grep -rln "function registerProviderApplication" tests`），差别只在临时目录前缀、
// `opencodeVersion` 与各自的 seed 夹具。抄 18 份的代价不是行数，是「dispose 顺序 / 环境变量还原」
// 这类只会在某一份里被改对的东西——这正是本 RFC 在生产代码上反复消灭的形态。
//
// 两种调用形态都支持，因为既有的 18 份里两种都有：
//   · 按需建（用例体内 `await scope.open()`）；
//   · `beforeEach` 里建（把 `open()` 放进自己的 `beforeEach`）。
// 无论哪种，清理都由本作用域的 `afterEach` 统一负责。

import { afterEach, describe } from 'bun:test'

import { describeEachProvider, type ProviderHarness } from './eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
  type ProviderHttpApplicationInput,
} from './providerHttpApplication'

export type ProviderHttpApplicationOptions = Omit<
  ProviderHttpApplicationInput,
  'appHome' | 'configPath'
> & {
  /** `mkdtemp` 前缀；出现在临时目录名里，便于把泄漏的目录归到具体用例文件。 */
  readonly tempPrefix: string
}

export interface OpenedProviderHttpApplication extends ProviderHttpApplication {
  /** 本次打开专属的 app home（已写进 `AGENT_WORKFLOW_HOME`，`afterEach` 还原并删除）。 */
  readonly appHome: string
}

export interface ProviderHttpApplicationScope {
  readonly harness: ProviderHarness
  /** 装配一个真应用；同一个用例里重复调用会先关掉上一个。 */
  open(): Promise<OpenedProviderHttpApplication>
}

/**
 * 在两个引擎上各注册一遍：内部是 `describeEachProvider` + 一个 `application lifetime` 子 describe，
 * 与被它取代的 18 份本地拷贝结构逐字相同（包括 `afterEach` 的先 dispose 后还原环境再删目录的顺序）。
 */
export function describeEachProviderHttpApplication(
  name: string,
  options: ProviderHttpApplicationOptions,
  register: (scope: ProviderHttpApplicationScope) => void,
): void {
  describeEachProvider(name, (harness) => {
    describe('application lifetime', () => {
      let application: ProviderHttpApplication | undefined
      let ownedHome: string | undefined
      let previousHome: string | undefined
      let homeAssigned = false

      async function closeCurrent(): Promise<void> {
        try {
          await application?.dispose()
        } finally {
          application = undefined
          if (homeAssigned) {
            if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
            else process.env.AGENT_WORKFLOW_HOME = previousHome
          }
          homeAssigned = false
          if (ownedHome !== undefined) {
            const { rmSync } = await import('node:fs')
            rmSync(ownedHome, { recursive: true, force: true })
          }
          ownedHome = undefined
        }
      }

      afterEach(closeCurrent)

      register({
        harness,
        async open() {
          await closeCurrent()
          const { mkdtempSync } = await import('node:fs')
          const { tmpdir } = await import('node:os')
          const { join } = await import('node:path')
          const appHome = mkdtempSync(join(tmpdir(), options.tempPrefix))
          ownedHome = appHome
          previousHome = process.env.AGENT_WORKFLOW_HOME
          process.env.AGENT_WORKFLOW_HOME = appHome
          homeAssigned = true
          const { tempPrefix: _tempPrefix, ...applicationInput } = options
          const opened = await createProviderHttpApplication(harness, {
            ...applicationInput,
            configPath: join(appHome, 'config.json'),
            appHome,
          })
          application = opened
          return Object.freeze({ ...opened, appHome })
        },
      })
    })
  })
}
