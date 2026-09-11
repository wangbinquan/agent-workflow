// RFC-359 AC-6 —— 双引擎 HTTP 应用的**作用域**：一份实现，两类调用方共用。
//
// 一类是**已经双引擎、各自抄了一份生命周期**的 18 个文件（下面详述）；另一类是**还写死 SQLite
// 的单引擎 HTTP 用例**——`rfc359-w5-t19f-test-engine-hardcoding` 账本上那几百行的大头就是它们，
// 迁移动作固定三步：那行直建 SQLite 内存库的调用换成 `scope.harness.db`、`createApp({…})` 换成
// `(await scope.open()).app`、外层 `describe` 换成本函数。迁移时唯一需要动脑的是 bun:sqlite 专有的
// 同步终结符（`.run()` / `.get()` / `.all()`）——它们在中立面上没有对应物，得改写成 await 的语句。
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
//
// **14/18 已接上；剩下 4 份是有意保留的**，因为它们的生命周期**真的不一样**，硬塞进来只会给这个
// 作用域加上只有一个调用方用的旋钮：
//   · `inventory-in-flight-fallback` —— app home 由外部给定（不建也不删临时目录、不动
//     `AGENT_WORKFLOW_HOME`）；
//   · `rfc234-config-intent-runtime` / `skills-import-zip-http` —— 经各自的 `buildWithPorts`
//     端口装配，应用不是由 `createProviderHttpApplication` 直接建的；
//   · `repos` —— 生命周期挂在自己的 `prepareFixture` 上。
// 它们要接进来，得先把上面那几件事本身也统一掉，那是另一刀。

import { afterEach, describe } from 'bun:test'

import {
  describeEachProvider,
  type DescribeEachProviderOptions,
  type ProviderHarness,
} from './eachProvider'
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
  /**
   * 直通 `describeEachProvider` 的同名选项：`'required'` 时 harness **不**把
   * `auth_login_policy` 标成已 bootstrap。测 bootstrap 流程本身（还没有管理员）的用例要它。
   */
  readonly bootstrap?: DescribeEachProviderOptions['bootstrap']
}

export interface OpenedProviderHttpApplication extends ProviderHttpApplication {
  /** 本次打开专属的 app home（已写进 `AGENT_WORKFLOW_HOME`，`afterEach` 还原并删除）。 */
  readonly appHome: string
}

export interface ProviderHttpApplicationScope {
  readonly harness: ProviderHarness
  /**
   * 装配一个真应用；同一个用例里重复调用会先关掉上一个。
   *
   * `overrides.config` 在装配前并进配置文件——用例需要非默认的守护进程配置
   * （`plantumlEndpoint` 这类）时走这里，不要另建 app home 自己写 config：应用读的是
   * 本作用域现建的那个路径，自写的那份会被整份绕开。
   */
  open(overrides?: {
    readonly config?: Readonly<Record<string, unknown>>
  }): Promise<OpenedProviderHttpApplication>
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
  const { bootstrap } = options
  describeEachProvider(
    name,
    (harness) => {
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
          async open(overrides) {
            await closeCurrent()
            const { mkdtempSync } = await import('node:fs')
            const { tmpdir } = await import('node:os')
            const { join } = await import('node:path')
            const appHome = mkdtempSync(join(tmpdir(), options.tempPrefix))
            ownedHome = appHome
            previousHome = process.env.AGENT_WORKFLOW_HOME
            process.env.AGENT_WORKFLOW_HOME = appHome
            homeAssigned = true
            const { tempPrefix: _tempPrefix, bootstrap: _bootstrap, ...applicationInput } = options
            const opened = await createProviderHttpApplication(harness, {
              ...applicationInput,
              ...(overrides?.config === undefined ? {} : { config: overrides.config }),
              configPath: join(appHome, 'config.json'),
              appHome,
            })
            application = opened
            return Object.freeze({ ...opened, appHome })
          },
        })
      })
    },
    bootstrap === undefined ? {} : { bootstrap },
  )
}
