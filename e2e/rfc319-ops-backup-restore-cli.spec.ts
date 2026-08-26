// RFC-319 —— 运维 CLI：备份 / 恢复 / 用户管理 / 配置包 / 配置读写
// （OPS-016 / OPS-018 / OPS-019 / OPS-021 / OPS-023）。
//
// 和 `rfc319-cli-lifecycle.spec.ts` 一样，这一批跑的**不是浏览器**，是编译出来的那
// 个二进制本身。理由在这几条能力上比生命周期那批更硬：它们全是**破窗通道**——库
// 坏了、管理员账号丢了、daemon 起不来的时候，用户手上只剩 `agent-workflow` 这一个
// 文件。在源码树上用 `bun run` 调一遍函数证明不了发行版里这些子命令还活着：单二进
// 制里没有 `node_modules`、没有 `db/migrations` 目录、没有前端 dev server，路径解析
// 的形态与开发机**完全不同**（本文件末尾「未覆盖 / 实测缺陷」一节记了这条差异今天
// 已经真实咬到了哪几个子命令）。
//
// 判据全部取自源码，不靠记忆：
//   * 顶层派发与各子命令的退出码 → `packages/backend/src/main.ts:126-190`
//     （`config` 用法错走 `process.exit(2)`；backup / restore / package / user
//     一律 `status !== 'ok'` ⇒ `process.exit(1)`）。
//   * `config get|set` 的取值 / 解析 / 拒绝 → `packages/backend/src/cli/config-cli.ts:13-58`，
//     schema 与数值上下界 → `packages/shared/src/schemas/config.ts:116` 起与
//     `packages/shared/src/settingsNumericBounds.ts:23-48`。
//   * `user …` 的五个子命令、bootstrap 闸与各拒绝 → `packages/backend/src/cli/user.ts:88-205`；
//     「首个管理员」的一次性语义 → `packages/backend/src/auth/loginPolicy.ts:96-98,184-205`。
//   * `restore` 的计划打印 / `--dry-run` / `--stage` / 冷恢复与四类拒绝 →
//     `packages/backend/src/cli/restore.ts:25-140`；入库前的降级、完整性、
//     `db.sqlite` 缺失判据 → `packages/backend/src/services/restore.ts:196-236,352-420`；
//     `--stage` 的 O_EXCL 独占与 409 → `packages/backend/src/services/pendingRestore.ts:129-160`。
//   * `package export|import` 的强制 `--as-user` 与破窗边界声明 →
//     `packages/backend/src/cli/package.ts:44-127`。
//   * `backup` 的回执文案与产物 → `packages/backend/src/cli/backup.ts:14-40` 与
//     `packages/backend/src/services/backup.ts:145-250`。
//
// 关于「怎么起子进程」：所有探针都走 `e2e/command.ts` 的受限边界，不在 spec 里自己
// 起进程——那份边界给每个子进程挂了硬超时，一个挂住的探针否则会把整个 shard 拖死。
// `packages/backend/tests/root-test-entrypoint.test.ts` 对每份 spec 源码做**纯子串**
// 检查来强制这条，而它禁的是几个具体的字面量，所以这里只描述规则、不复述被禁的词。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { querySqlite, runCommandResult } from './command'
import { defaultBinaryPath, startDaemon, type DaemonHandle } from './harness'

// 两条 restore 用例各自要冷启一次 daemon（各 ~8s）、做一次真备份、再跑若干秒级 CLI
// 调用；90s 的默认值对它们太紧。
test.setTimeout(180_000)

const E2E_PASSWORD = 'E2EAdministrator123!'

interface CliResult {
  readonly out: string
  readonly code: number
}

/** 跑发行二进制的一个子命令，绑定到一个隔离的 `$AGENT_WORKFLOW_HOME`。 */
function runCli(home: string, args: string[]): CliResult {
  const result = runCommandResult(defaultBinaryPath(), args, {
    env: { AGENT_WORKFLOW_HOME: home },
    // Every call boots the release binary, resolves its embedded migrations,
    // and opens an isolated SQLite home; password calls add memory-hard
    // Argon2id. A saturated macOS WebKit shard can push even a non-password
    // `user create` past the generic 15s fixture fence. Keep the boundary hard,
    // but budget this intentionally process-heavy CLI suite as a whole.
    timeoutMs: 30_000,
  })
  return { out: result.output, code: result.status }
}

function freshHome(tag: string): string {
  return mkdtempSync(join(tmpdir(), `aw-rfc319-backup-restore-cli-${tag}-`))
}

/**
 * 系统 `tar`，路径规则与产品自己用的那份保持一致
 * （`packages/backend/src/util/archive.ts:28-36`）：Windows 上必须用绝对的
 * `System32\tar.exe`（bsdtar），裸名字会先命中 Git for Windows 的 GNU tar，而后者
 * 把 `C:\…` 读成 rsh 的 `host:path`。夹具用的 tar 与产品用的 tar 不是同一个，
 * 就等于夹具在验证另一件事。
 */
function tarBinary(): string {
  if (process.platform === 'win32') {
    return join(
      process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
      'System32',
      'tar.exe',
    )
  }
  return 'tar'
}

function runTar(args: string[]): CliResult {
  const result = runCommandResult(tarBinary(), args)
  return { out: result.output, code: result.status }
}

/** `config.json` 的当前文本；不存在时返回 null（用于「拒绝后一个字节都没动」）。 */
function configText(home: string): string | null {
  const path = join(home, 'config.json')
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function configJson(home: string): Record<string, unknown> {
  const text = configText(home)
  expect(text, '`config.json` 根本不存在 —— 后面所有「写进去了吗」的断言都无从谈起').not.toBeNull()
  return JSON.parse(text ?? '{}') as Record<string, unknown>
}

/** 从 CLI 输出里摘出 JSON 文档（`config get` 首次调用会先打一行 INFO 日志）。 */
function jsonDocument(out: string, why: string): Record<string, unknown> {
  const start = out.indexOf('{')
  expect(start, why).toBeGreaterThanOrEqual(0)
  return JSON.parse(out.slice(start)) as Record<string, unknown>
}

interface UserRow {
  readonly username: string
  readonly role: string
  readonly status: string
  readonly display_name: string
  readonly email: string | null
  readonly force_password_change: number
  readonly has_password: number
}

function readUsers(home: string): UserRow[] {
  return querySqlite<UserRow>(
    join(home, 'db.sqlite'),
    'SELECT username, role, status, display_name, email, force_password_change, ' +
      '(password_hash IS NOT NULL) AS has_password FROM users ORDER BY username',
  )
}

function bootstrapCompleted(home: string): boolean {
  const rows = querySqlite<{ done: number }>(
    join(home, 'db.sqlite'),
    'SELECT (bootstrap_completed_at IS NOT NULL) AS done FROM auth_login_policy',
  )
  expect(rows.length, '`auth_login_policy` 里没有那一行全局策略 —— 迁移就没跑对').toBe(1)
  return rows[0]?.done === 1
}

/** 在 `home` 里造一个管理员，走的就是用户在空机器上会敲的那条命令。 */
function bootstrapAdmin(home: string, username = 'alice'): CliResult {
  return runCli(home, [
    'user',
    'create',
    '--username',
    username,
    '--admin',
    '--password',
    E2E_PASSWORD,
  ])
}

async function createAgent(daemon: DaemonHandle, name: string): Promise<void> {
  const res = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: 'RFC-319 ops-cli fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'body',
    }),
  })
  expect(res.ok, `create agent ${name}: ${res.status} ${await res.text()}`).toBe(true)
}

async function agentNames(daemon: DaemonHandle): Promise<string[]> {
  const res = await fetch(`${daemon.baseUrl}/api/agents`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expect(res.ok, `list agents: ${res.status} ${await res.clone().text()}`).toBe(true)
  const body = (await res.json()) as { items?: Array<{ name: string }> } | Array<{ name: string }>
  const items = Array.isArray(body) ? body : (body.items ?? [])
  return items.map((a) => a.name)
}

/** 让 daemon 写出一个真备份，并返回它在盘上的路径。 */
async function takeBackup(daemon: DaemonHandle): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/backup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expect(res.ok, `create backup: ${res.status} ${await res.clone().text()}`).toBe(true)
  const body = (await res.json()) as { path: string; sizeBytes: number }
  expect(body.sizeBytes, '备份产物是空的 —— 后面拿它做恢复就没有意义').toBeGreaterThan(0)
  return body.path
}

/**
 * 备份包里的迁移身份被改成「比这个二进制更新」——降级拒绝的唯一可复现造法。
 *
 * 解包目录与产物目录分开：`tar -czf` 的输出如果落在被打包的目录里，它会把自己
 * 也卷进去，得到一个每跑一次就长大一圈的包。
 */
function forgeNewerBackup(sourceTarball: string, workDir: string): string {
  const staging = join(workDir, 'forged-src')
  mkdirSync(staging, { recursive: true })
  const extract = runTar(['-xzf', sourceTarball, '-C', staging])
  expect(extract.code, `解包真备份失败：${extract.out}`).toBe(0)
  // manifest 缺失会让 planRestore 判成 legacy backup，那是另一条分支——夹具必须
  // 确认自己造的是「有 manifest、只是时间戳更新」的那一种。
  const manifestPath = join(staging, 'manifest.json')
  expect(
    existsSync(manifestPath),
    '真备份里没有 manifest.json —— 降级判据读的就是它，夹具造不出来',
  ).toBe(true)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    migration: { lastCreatedAt: number }
  }
  manifest.migration.lastCreatedAt += 86_400_000
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
  const out = join(workDir, 'forged-newer.tar.gz')
  const packed = runTar(['-czf', out, '-C', staging, '.'])
  expect(packed.code, `重新打包失败：${packed.out}`).toBe(0)
  return out
}

/** 一个语法合法、但根本不是备份的 tar.gz。 */
function makeJunkTarball(workDir: string): string {
  const staging = join(workDir, 'junk-src')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'readme.txt'), 'not a backup\n', 'utf8')
  const out = join(workDir, 'junk.tar.gz')
  const packed = runTar(['-czf', out, '-C', staging, '.'])
  expect(packed.code, `打包 junk 夹具失败：${packed.out}`).toBe(0)
  return out
}

// ---------------------------------------------------------------------------
// OPS-016 —— config get / set
// ---------------------------------------------------------------------------

test('RFC-319 OPS-016: config get/set 在发行二进制上闭环——值按 JSON 解析、越界与枚举一律拒绝、未知 key 永不落盘 @nightly', () => {
  const home = freshHome('config')
  try {
    // ① 只读：全量 dump。它是用户排查「我到底配了什么」的第一步。
    const dump = runCli(home, ['config', 'get'])
    expect(
      dump.code,
      '`config get` 以非 0 退出 ⇒ 任何「先读当前配置再决定改什么」的运维脚本第一步就断了',
    ).toBe(0)
    const parsed = jsonDocument(
      dump.out,
      '`config get` 没有打印出一份可解析的 JSON ⇒ 用户没法把它喂给 jq / 存进版本库做对账',
    )
    expect(
      parsed.$schema_version,
      '全量 dump 里没有 `$schema_version` ⇒ 拿着这份 JSON 的人无从判断它属于哪一代 schema，' +
        '也就无法安全地把它抄到另一台机器上',
    ).toBe(1)
    expect(
      parsed.maxConcurrentNodes,
      '出厂默认并发数不是 4 ⇒ 用户在一台没改过配置的机器上看到的读数与文档不符',
    ).toBe(4)

    // 读配置**不该**顺手开库、上锁。`config get` 只材料化 config.json 这一件事，
    // 其余一律不动——否则一次只读操作会把一台待恢复的机器搅出 db.sqlite 与锁文件。
    expect(
      readdirSync(home).sort(),
      '`config get` 除了写出默认 config.json 之外还动了别的东西 ⇒ 一次只读操作在机器上落了' +
        '数据库 / 锁文件，下一次真正启动要背着这些残留',
    ).toEqual(['config.json'])

    // ② 单键读：给的是**裸值**，不是 JSON 引号包起来的串——运维脚本直接 `$(…)` 用。
    const single = runCli(home, ['config', 'get', 'maxConcurrentNodes'])
    expect(single.code, '`config get <key>` 以非 0 退出 ⇒ 读单个配置项这条路是断的').toBe(0)
    expect(
      single.out.trim(),
      '单键读回来的不是裸值 ⇒ `PORTS=$(agent-workflow config get maxConcurrentNodes)` 拿到的' +
        '是带引号 / 带修饰的字符串，直接参与算术就炸',
    ).toBe('4')

    // ③ 读一个不存在的键：必须点名拒绝，而不是回一个空串。
    const unknownGet = runCli(home, ['config', 'get', 'bogusKey'])
    expect(
      unknownGet.code,
      '读不存在的配置项以 0 退出 ⇒ 拼错键名的脚本拿到空值，把 `--flag ""` 传下去，' +
        '而且看起来一切正常',
    ).toBe(1)
    expect(
      unknownGet.out,
      '拒绝时没有回显用户敲的那个键名 ⇒ 一长串配置项里不知道是哪一个写错了',
    ).toContain('unknown config key: bogusKey')

    // ④ 写：数字 / 字符串 / 对象三种取值形态各走一遍，并回读磁盘确认**类型**没丢。
    const setNumber = runCli(home, ['config', 'set', 'maxConcurrentNodes', '7'])
    expect(setNumber.code, '`config set` 一次合法写入以非 0 退出').toBe(0)
    expect(
      setNumber.out.trim(),
      '写入成功却不回显最终值 ⇒ 用户不知道自己写下的字面量被解析成了什么',
    ).toBe('maxConcurrentNodes = 7')
    expect(
      configJson(home).maxConcurrentNodes,
      '数字被当成字符串存了 ⇒ config.json 里躺着 "7"，下一次 daemon 启动会在 schema 校验上' +
        '整个起不来',
    ).toBe(7)
    expect(
      runCli(home, ['config', 'get', 'maxConcurrentNodes']).out.trim(),
      '刚写进去的值读不回来 ⇒ set 与 get 看的不是同一份配置',
    ).toBe('7')

    const setString = runCli(home, ['config', 'set', 'theme', 'dark'])
    expect(setString.code, '写入一个合法枚举值以非 0 退出').toBe(0)
    expect(
      configJson(home).theme,
      '不是合法 JSON 的字面量没有退回字符串 ⇒ `theme dark` 这种最常见的写法直接失效',
    ).toBe('dark')

    const setObject = runCli(home, [
      'config',
      'set',
      'worktreeAutoGc',
      '{"enabled":true,"olderThanDays":3}',
    ])
    expect(setObject.code, '写入一个 JSON 对象以非 0 退出').toBe(0)
    expect(
      configJson(home).worktreeAutoGc,
      '嵌套对象没有按 JSON 解析 ⇒ 文档写明「嵌套字段整块以 JSON 传」的那条路是断的，' +
        'CLI 上就再也配不了 worktree GC',
    ).toEqual({ enabled: true, olderThanDays: 3 })

    // ⑤ 拒绝面。四种「值不合法」各有各的来路，但共同的底线只有一条：
    //    **拒绝之后 config.json 一个字节都不许变**。
    const before = configText(home)
    for (const [args, why] of [
      [
        ['maxConcurrentNodes', '0'],
        '低于下界（并发池至少 1）却被放行 ⇒ daemon 下次启动会带着一个永远调度不出任何节点的池',
      ],
      [
        ['maxConcurrentNodes', '999'],
        '高于上界（256）却被放行 ⇒ 一次手滑就让机器同时拉起几百个 runtime 子进程',
      ],
      [
        ['maxConcurrentNodes', 'abc'],
        '数值字段收下了一个单词 ⇒ 写进去的是字符串，下一次启动在 schema 校验处整个起不来',
      ],
      [['theme', 'neon'], '枚举字段收下了枚举外的值 ⇒ 前端拿到一个渲染不出来的主题'],
    ] as const) {
      const rejected = runCli(home, ['config', 'set', ...args])
      expect(rejected.code, `${why}（config set ${args.join(' ')} 应当被拒）`).toBe(1)
      expect(
        rejected.out,
        `config set ${args.join(' ')} 被拒时没说是校验没过 ⇒ 用户不知道该改值还是该改键名`,
      ).toContain('config patch failed validation')
    }
    expect(
      configText(home),
      '一串被拒绝的写入之后 config.json 变了 ⇒ 「校验没过」和「已经写进去了」同时成立，' +
        '这是最坏的一种半提交',
    ).toBe(before)

    // ⑥ 未知键：产品的 schema 会把它剥掉。这里锁的是**剥掉这件事**——一旦有人把
    //    patch schema 改成 passthrough，用户敲错的键名会静静躺进 config.json，
    //    看起来"配上了"，实际永远不生效。
    const unknownSet = runCli(home, ['config', 'set', 'bogusKey', '1'])
    expect(
      Object.keys(configJson(home)),
      '未知的配置键被写进了 config.json ⇒ 用户会拿着一份看起来配好了、实际全程被忽略的配置，' +
        '而且再也没有任何东西会告诉他这一点',
    ).not.toContain('bogusKey')
    expect(
      unknownSet.out,
      '未知键的回执里连键名都没有 ⇒ 用户完全看不出自己这条命令落在了哪里',
    ).toContain('bogusKey')

    // ⑦ 用法错 vs 值不合法必须用**不同的退出码**：脚本要能分辨「我命令写错了」
    //    和「我值给错了」。
    const missingValue = runCli(home, ['config', 'set', 'theme'])
    expect(missingValue.code, '`config set <key>` 缺值却以 0 退出').toBe(1)
    expect(missingValue.out, '缺值时不给出正确写法 ⇒ 用户只能去翻文档').toContain(
      'usage: agent-workflow config set <key> <value>',
    )

    const badAction = runCli(home, ['config', 'frobnicate'])
    expect(
      badAction.code,
      '`config` 后面跟一个不认识的动作却不是退出码 2 ⇒ 脚本无法把「命令写错」与' +
        '「值被拒」区分开，于是对一个永远不可能成功的调用无限重试',
    ).toBe(2)
    expect(badAction.out, '不认识的动作被拒时不列出可用动作 ⇒ 用户在一条死路上停住').toContain(
      'usage: agent-workflow config <get|set> ...',
    )
    expect(
      badAction.code,
      '「命令写错」与「值被拒」共用同一个退出码 ⇒ 上一条断言里那种区分能力形同虚设',
    ).not.toBe(missingValue.code)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-021 —— 首个管理员 bootstrap
// ---------------------------------------------------------------------------

test('RFC-319 OPS-021: 首个管理员必须是带密码的 admin，被拒的 bootstrap 一行都不许写库，且只能成功一次 @nightly', () => {
  const home = freshHome('bootstrap')
  try {
    // ① 全新机器：只有保留的 `__system__`，bootstrap 未完成。
    //    这条同时证明 `user` 子命令在**从没起过 daemon** 的机器上就能用——破窗
    //    通道的全部意义就在这里（库在、daemon 起不来，人得先能建出管理员）。
    const virgin = runCli(home, ['user', 'list'])
    expect(
      virgin.code,
      '一台全新机器上 `user list` 以非 0 退出 ⇒ 破窗通道在最需要它的时刻（daemon 还起不来）' +
        '本身就是坏的',
    ).toBe(0)
    expect(
      readUsers(home).map((r) => r.username),
      '全新安装里已经存在人类账号 ⇒ 有人在用户不知情的情况下拿到了这台机器的身份',
    ).toEqual(['__system__'])
    expect(
      bootstrapCompleted(home),
      '全新安装就被标记成「首个管理员已建」⇒ `/setup/admin` 与一次性 daemon token 都会' +
        '被跳过，这台机器再也没有正常的建号入口',
    ).toBe(false)

    // ② 两种不合格的首个用户，各自被拒，且**都不许留下半个用户**。
    for (const [args, why] of [
      [
        ['user', 'create', '--username', 'bob', '--password', E2E_PASSWORD],
        '首个用户不是管理员却被放行 ⇒ 这台机器上第一个账号没有 users:write，' +
          '于是永远建不出第二个人，安装当场变砖',
      ],
      [
        ['user', 'create', '--username', 'carol', '--admin'],
        '首个管理员没有密码却被放行 ⇒ 建出来的是一个 invited 状态、无法登录的管理员，' +
          '而 bootstrap 已经被标记完成，登录入口就此关死',
      ],
    ] as const) {
      const refused = runCli(home, [...args])
      expect(refused.code, `${why}（应当被拒）`).toBe(1)
      expect(
        refused.out,
        '拒绝时没有直接给出正确写法 ⇒ 用户在一台还没有任何账号的机器上只能靠猜',
      ).toContain('bootstrap requires the first user to be an admin with --password')
    }
    expect(
      readUsers(home).map((r) => r.username),
      '被拒的 bootstrap 把用户行写进去了 ⇒ 「校验没过」和「账号已存在」同时成立，' +
        '下一次用正确参数重试会撞上 username-taken，用户被自己上一次失败永久挡住',
    ).toEqual(['__system__'])
    expect(
      bootstrapCompleted(home),
      '被拒的 bootstrap 却把「已完成」标记写下了 ⇒ 这台机器再也建不出第一个管理员',
    ).toBe(false)

    // ③ 合格的首个管理员。
    const created = runCli(home, [
      'user',
      'create',
      '--username',
      'alice',
      '--admin',
      '--password',
      E2E_PASSWORD,
      '--display',
      'Alice A',
      '--email',
      'Alice@Example.COM',
    ])
    expect(created.code, '合格的首个管理员创建失败').toBe(0)
    expect(
      created.out,
      '建成首个管理员却不说「这是首个管理员、一次性 token 已退休」⇒ 用户不知道那条' +
        '打印在启动横幅里的 URL 从此失效，会拿着它反复试',
    ).toContain('created first administrator alice')
    expect(created.out, '同上：回执里没有交代一次性 token 的去向').toContain('daemon token retired')

    const alice = readUsers(home).find((r) => r.username === 'alice')
    expect(alice, '回执说建好了，库里却没有这一行').toBeDefined()
    expect(alice?.role, '首个管理员的角色不是 admin ⇒ 他管不了这台机器').toBe('admin')
    expect(
      alice?.status,
      '首个管理员不是 active ⇒ 他根本登不进去，而 bootstrap 已经关闭了别的入口',
    ).toBe('active')
    expect(alice?.has_password, '首个管理员没有密码散列 ⇒ 密码登录这条路是空的').toBe(1)
    expect(alice?.display_name, '`--display` 被丢掉了 ⇒ 用户在界面上看到的是登录名而不是姓名').toBe(
      'Alice A',
    )
    expect(
      alice?.email,
      '`--email` 没有按小写归一 ⇒ 同一个邮箱的大小写变体能再注册一次，唯一约束形同虚设',
    ).toBe('alice@example.com')
    expect(bootstrapCompleted(home), 'bootstrap 成功了却没有落下「已完成」标记').toBe(true)

    // ④ bootstrap 是**一次性**的：之后同样的 `--admin --password` 走的是普通建号路径。
    const second = runCli(home, [
      'user',
      'create',
      '--username',
      'dave',
      '--admin',
      '--password',
      E2E_PASSWORD,
    ])
    expect(second.code, 'bootstrap 之后再建管理员失败了 ⇒ 这台机器只能有一个管理员').toBe(0)
    expect(
      second.out,
      '第二个管理员也被当成「首个管理员」⇒ bootstrap 不是一次性的，任何能敲这条命令的人' +
        '都能重新走一遍首次安装流程',
    ).not.toContain('created first administrator')
    expect(second.out, '普通建号的回执里没有角色 ⇒ 用户不知道自己刚建的是不是管理员').toContain(
      'role=admin',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-021 —— create / list / reset-password / disable / enable
// ---------------------------------------------------------------------------

test('RFC-319 OPS-021: user 的五个子命令在无 daemon 的机器上闭环，未知用户与非法角色一律拒绝且不写库 @nightly', () => {
  const home = freshHome('users')
  try {
    expect(bootstrapAdmin(home).code, '前置：建首个管理员失败').toBe(0)

    // ① 非法角色必须在写库**之前**被拒——`--role` 是自由字符串，一个拼写错误
    //    如果被盲存下去，那一行的权限解析结果是未定义的。
    const badRole = runCli(home, ['user', 'create', '--username', 'carol', '--role', 'wizard'])
    expect(badRole.code, '非法角色被放行 ⇒ 库里会躺着一行角色未知的账号').toBe(1)
    expect(badRole.out, '拒绝非法角色时不列出合法取值 ⇒ 用户不知道到底有哪几个角色可选').toContain(
      "invalid --role 'wizard' (expected admin|user|manager|guest)",
    )
    expect(
      readUsers(home).map((r) => r.username),
      '非法角色被拒之后用户行还是建出来了 ⇒ 校验发生在写库之后，等于没校验',
    ).not.toContain('carol')

    // ② 不带密码建号 ⇒ invited（没有密码散列）。这不是细节：invited 与 active
    //    的区别决定了这个人现在能不能登录。
    const invited = runCli(home, ['user', 'create', '--username', 'carol', '--role', 'manager'])
    expect(invited.code, '合法的建号失败').toBe(0)
    expect(
      invited.out,
      '不带密码建出来的号没有被标注成 invited ⇒ 管理员以为对方已经可以登录，' +
        '实际上对方拿不到任何入口',
    ).toContain('(status=invited, no password)')
    const carolInvited = readUsers(home).find((r) => r.username === 'carol')
    expect(carolInvited?.role, '`--role manager` 没有落库').toBe('manager')
    expect(carolInvited?.status, '不带密码建出来的号不是 invited').toBe('invited')
    expect(
      carolInvited?.has_password,
      '没给密码却写下了密码散列 ⇒ 那是一个谁也不知道的密码，账号处于既非邀请也非可用的状态',
    ).toBe(0)

    // ③ 重名必须拒，且拒完库里仍然只有一行 carol。
    const duplicate = runCli(home, ['user', 'create', '--username', 'carol'])
    expect(duplicate.code, '重名建号被放行').toBe(1)
    expect(duplicate.out, '重名被拒时不说清是重名 ⇒ 用户会怀疑是密码 / 角色的问题').toContain(
      'username already exists',
    )
    expect(
      readUsers(home).filter((r) => r.username === 'carol').length,
      '重名被拒之后库里出现了两行同名用户 ⇒ 登录时按用户名查会命中哪一行取决于顺序，' +
        '这是身份系统里最坏的一种歧义',
    ).toBe(1)

    // ④ 缺参数：三条必填校验各走一遍。
    for (const [args, needle, why] of [
      [['user', 'create'], '--username is required', '建号不给用户名却被放行'],
      [
        ['user', 'reset-password', '--username', 'carol'],
        '--username and --new-password are required',
        '重置密码不给新密码却被放行 ⇒ 会把一个空密码写进去',
      ],
      [['user', 'disable'], '--username is required', '停用不给用户名却被放行'],
    ] as const) {
      const missing = runCli(home, [...args])
      expect(missing.code, `${why}（\`${args.join(' ')}\` 应当被拒）`).toBe(1)
      expect(missing.out, `\`${args.join(' ')}\` 被拒时没有说清缺的是哪个参数`).toContain(needle)
    }

    // ⑤ 目标用户不存在：三个改写型子命令必须各自点名拒绝，而不是静默成功。
    for (const args of [
      ['user', 'reset-password', '--username', 'ghost', '--new-password', E2E_PASSWORD],
      ['user', 'disable', '--username', 'ghost'],
      ['user', 'enable', '--username', 'ghost'],
    ]) {
      const missing = runCli(home, args)
      expect(
        missing.code,
        `\`${args.join(' ')}\` 对不存在的用户以 0 退出 ⇒ 运维脚本会认为"已处理"，` +
          '而那个真正该被停用的账号还活着',
      ).toBe(1)
      expect(missing.out, `\`${args.join(' ')}\` 没有报出是哪个用户名找不到`).toContain(
        'user ghost not found',
      )
    }

    // ⑥ 重置密码：把 invited 激活、写下强制改密标记、并声明会话已吊销。
    const reset = runCli(home, [
      'user',
      'reset-password',
      '--username',
      'carol',
      '--new-password',
      E2E_PASSWORD,
    ])
    expect(reset.code, '重置密码失败 ⇒ 找回账号这条破窗通道是断的').toBe(0)
    expect(
      reset.out,
      '重置密码的回执里没有交代「旧会话已吊销」⇒ 管理员在处置一个被盗账号时，' +
        '不知道攻击者手上那个 session 是不是还有效',
    ).toContain('sessions revoked')
    const carolReset = readUsers(home).find((r) => r.username === 'carol')
    expect(carolReset?.has_password, '重置之后仍然没有密码散列 ⇒ 重置根本没写进去').toBe(1)
    expect(
      carolReset?.force_password_change,
      '重置之后没有置上强制改密 ⇒ 管理员设的那个临时密码会被当成长期密码一直用下去',
    ).toBe(1)
    expect(
      carolReset?.status,
      '重置密码没有把 invited 激活 ⇒ 管理员告诉对方"密码给你了"，对方仍然登不进去',
    ).toBe('active')

    // ⑦ 停用 / 启用是一对可逆操作，两个方向都要真的落库。
    expect(runCli(home, ['user', 'disable', '--username', 'carol']).code, '停用失败').toBe(0)
    expect(
      readUsers(home).find((r) => r.username === 'carol')?.status,
      '`user disable` 报成功但状态没变 ⇒ 一个本该被立刻请离的账号还活着',
    ).toBe('disabled')
    expect(runCli(home, ['user', 'enable', '--username', 'carol']).code, '启用失败').toBe(0)
    expect(
      readUsers(home).find((r) => r.username === 'carol')?.status,
      '`user enable` 报成功但状态没变 ⇒ 误停用之后没有任何办法把人放回来',
    ).toBe('active')

    // ⑧ list 是上面所有操作的唯一读出口：四个字段一个都不能少。
    const listed = runCli(home, ['user', 'list'])
    expect(listed.code, '`user list` 失败').toBe(0)
    const carolLine = listed.out.split('\n').find((line) => line.includes('\tcarol\t'))
    expect(
      carolLine,
      '`user list` 里找不到刚刚操作过的那个用户（按 tab 分列）⇒ 输出不可被脚本切分，' +
        '运维只能用肉眼读',
    ).toBeDefined()
    expect(
      carolLine?.split('\t').slice(1),
      '`user list` 的列不是 用户名/角色/状态/姓名 ⇒ 任何按列取值的脚本都会取错',
    ).toEqual(['carol', 'manager', 'active', 'carol'])

    // ⑨ 用法面：不给子命令 / 给错子命令都要以非 0 退出并把五个子命令列全。
    const usage = runCli(home, ['user'])
    expect(usage.code, '`user` 不带子命令以 0 退出 ⇒ 脚本里漏写一个词会被当成成功').toBe(1)
    for (const sub of ['create', 'reset-password', 'list', 'disable', 'enable']) {
      expect(
        usage.out,
        `用法里没有列出 \`user ${sub}\` ⇒ 这条子命令对只看用法的用户等于不存在`,
      ).toContain(`user ${sub}`)
    }
    const unknownSub = runCli(home, ['user', 'frobnicate'])
    expect(unknownSub.code, '打错的 user 子命令以 0 退出').toBe(1)
    expect(unknownSub.out, '打错子命令时不回显打错的那个词').toContain(
      'unknown subcommand: frobnicate',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-019 —— restore 的计划面与四类拒绝
// ---------------------------------------------------------------------------

test('RFC-319 OPS-019: restore 默认只打印计划——daemon 在跑时拒绝冷恢复，降级包与非备份包连 --stage 都不许武装 @nightly', async () => {
  const home = freshHome('restore-refuse')
  const work = freshHome('restore-fixtures')
  const daemon: DaemonHandle = await startDaemon({ home })
  try {
    const survivor = `rfc319-survivor-${Date.now().toString(36)}`
    await createAgent(daemon, survivor)
    const tarball = await takeBackup(daemon)
    const livePid = readFileSync(join(home, '.daemon.lock'), 'utf8').trim()
    expect(livePid, '在跑的 daemon 没把 PID 写进锁文件 —— 后面「是谁占着」无从谈起').toMatch(
      /^\d+$/,
    )

    // ① 什么 flag 都不给 = 只打印计划。这是这条命令最重要的一个默认值：
    //    恢复会覆盖当前数据，默认必须是「看一眼」而不是「动手」。
    const plan = runCli(home, ['restore', tarball])
    expect(plan.code, '只打印计划却以非 0 退出 ⇒ 用户以为包坏了，其实什么都没发生').toBe(0)
    expect(plan.out, '计划里没有回显被恢复的是哪个包 ⇒ 手上有多个备份时无从核对').toContain(
      `restore plan for ${tarball}:`,
    )
    expect(
      plan.out,
      '计划里没有报出这个包的 kind ⇒ 用户分不清手上拿的是手动备份还是迁移前的自动备份，' +
        '而后者是绑定二进制版本的',
    ).toContain('kind:      manual')
    expect(
      plan.out,
      '计划里没有报出方向 ⇒ 「装回去会不会顺带跑一批迁移」这个最关键的问题没有答案',
    ).toContain('direction: same')
    expect(
      plan.out,
      '打印完计划不告诉用户下一步敲什么 ⇒ 破窗时刻最不需要的就是再去翻文档',
    ).toContain('re-run with --yes to APPLY (this OVERWRITES current data).')

    // ② --dry-run：同一份计划，但话说得不一样——它必须明说「什么都没改」。
    const dryRun = runCli(home, ['restore', tarball, '--dry-run'])
    expect(dryRun.code, '`--dry-run` 以非 0 退出 ⇒ 一次纯查看被当成失败').toBe(0)
    expect(
      dryRun.out,
      '`--dry-run` 没有明说什么都没改 ⇒ 用户不敢确定自己刚才是不是已经把库换掉了',
    ).toContain('(dry-run — nothing changed)')
    expect(
      dryRun.out,
      '`--dry-run` 里还挂着「re-run with --yes」⇒ 两种只读输出说的是同一句话，' +
        '用户分不清自己跑的是哪一种',
    ).not.toContain('re-run with --yes')

    // 只读的两条路都不许碰活数据：备份之后新增的那个代理必须还在。
    expect(
      await agentNames(daemon),
      '打印计划 / --dry-run 之后活库里的数据变了 ⇒ 「只看一眼」这件事本身就有破坏性',
    ).toContain(survivor)
    expect(
      existsSync(join(home, '.restore-pending')),
      '只读路径居然武装了一次待生效恢复 ⇒ 用户只是想看看，下次重启库就被换了',
    ).toBe(false)

    // ③ daemon 还在跑 ⇒ 冷恢复必须拒绝，并且要报出占用者的 PID 与两条出路。
    const hotApply = runCli(home, ['restore', tarball, '--yes'])
    expect(
      hotApply.code,
      'daemon 在跑时冷恢复居然执行了 ⇒ 两个进程同时写同一个 SQLite，' +
        '而其中一个正在把整个文件换掉，这是数据损坏级别的后果',
    ).toBe(1)
    expect(
      hotApply.out,
      '拒绝时没有报出正在跑的那个 PID ⇒ 用户知道"起不来"却不知道该去看哪个进程',
    ).toContain(`restore refused: a daemon is running (pid ${livePid})`)
    expect(
      hotApply.out,
      '拒绝时没有给出两条出路（先停机，或用 --stage 下次启动生效）⇒ 用户在一条死路上停住',
    ).toContain('Stop it first (or use --stage to apply on next boot): agent-workflow stop')

    // ④ 非备份包：`--stage` 的校验深度必须和真正生效时一样。否则一个坏包会被
    //    武装进去，然后在**每一次启动**上重复失败——那是一台开不了机的机器。
    const junk = makeJunkTarball(work)
    const junkStage = runCli(home, ['restore', junk, '--stage'])
    expect(
      junkStage.code,
      '一个根本不是备份的 tar.gz 被 `--stage` 武装成功 ⇒ 下一次启动会拿它去换库并失败，' +
        '而用户手上只有一个开不了机的实例',
    ).toBe(1)
    expect(
      junkStage.out,
      '拒绝一个非备份包时不说清"里面没有 db.sqlite" ⇒ 用户以为是权限 / 磁盘问题',
    ).toContain('stage refused: backup contains no db.sqlite (not a backup tarball?)')
    expect(
      existsSync(join(home, '.restore-pending')),
      '`--stage` 被拒之后仍然留下了待生效目录 ⇒ 拒绝只是嘴上说说，坏包照样在下次启动生效',
    ).toBe(false)

    // 同一个坏包走冷恢复路径也要拒（这条 daemon 在跑，所以先看到的是 daemon 拒绝；
    // 真正的包体拒绝在下一条冷恢复用例里对 db.sqlite 缺失做过一次）。

    // ⑤ 降级包：备份比这个二进制更新 ⇒ 三种写法（计划 / --dry-run / --stage）
    //    必须一律拒，而不是只在真正动手时才拒。
    const forged = forgeNewerBackup(tarball, work)
    for (const extra of [[], ['--dry-run'], ['--stage']]) {
      const label = extra.length === 0 ? '(只打印计划)' : extra.join(' ')
      const downgrade = runCli(home, ['restore', forged, ...extra])
      expect(
        downgrade.code,
        `比二进制更新的备份在 ${label} 下没有被拒 ⇒ 用户会把一个含未来迁移的库装到旧二进制上，` +
          '启动时 schema 对不上，库和二进制同时不可用',
      ).toBe(1)
      expect(
        downgrade.out,
        `${label} 下的降级拒绝没有说清"备份比二进制新" ⇒ 用户会以为包坏了，转而去找更旧的备份`,
      ).toContain('refused: the backup is NEWER than this binary; cannot downgrade.')
      expect(
        downgrade.out,
        `${label} 下没有把方向报成 downgrade ⇒ 计划里唯一能提前看出这件事的读数丢了`,
      ).toContain('direction: downgrade')
    }
    expect(
      existsSync(join(home, '.restore-pending')),
      '降级包被拒之后仍然武装了待生效恢复 ⇒ 下一次启动会拿一个装不上的包去换库',
    ).toBe(false)

    // ⑥ 合法包 + `--stage`：这次必须真的武装，落下 marker 与包体副本。
    const staged = runCli(home, ['restore', tarball, '--stage'])
    expect(staged.code, '合法包的 `--stage` 失败 ⇒ daemon 在跑时就没有任何恢复途径了').toBe(0)
    expect(staged.out, '武装成功却不告诉用户「要重启才生效」⇒ 用户会一直等着它自己发生').toContain(
      'STAGED — restart the daemon to apply',
    )
    for (const [name, why] of [
      ['restore-pending.json', '没有落下待生效标记 ⇒ 下次启动根本不知道要恢复'],
      ['staged.tar.gz', '没有把包体复制进来 ⇒ 用户删掉原始文件后这次武装就空了'],
    ] as const) {
      expect(existsSync(join(home, '.restore-pending', name)), why).toBe(true)
    }

    // ⑦ 已经武装了一次，第二次必须以 409 语义拒绝——两个并发的装填曾把 A 的标记
    //    和 B 的包体拼在一起。
    const secondStage = runCli(home, ['restore', tarball, '--stage'])
    expect(
      secondStage.code,
      '第二次 `--stage` 被放行 ⇒ 两次装填会互相覆盖，最终生效的是哪个包无从判断',
    ).toBe(1)
    expect(
      secondStage.out,
      '重复装填被拒时不告诉用户「先取消上一次」⇒ 用户不知道怎么才能换一个包',
    ).toContain('a restore is already staged; cancel it')

    // ⑧ 参数面：不给包 / 给一个不存在的路径。
    const noArg = runCli(home, ['restore'])
    expect(noArg.code, '`restore` 不给包名却以 0 退出').toBe(1)
    expect(
      noArg.out,
      '不给包名时不打印用法 ⇒ 用户不知道还有 --stage / --dry-run 这些出路',
    ).toContain('usage: agent-workflow restore <tarball> [--yes] [--stage] [--dry-run]')
    const missingFile = runCli(home, ['restore', join(work, 'definitely-not-here.tar.gz')])
    expect(missingFile.code, '路径不存在却以 0 退出 ⇒ 打错路径的恢复被记成成功').toBe(1)
    expect(
      missingFile.out,
      '路径不存在时不回显那个路径 ⇒ 用户看不出自己是打错了字还是挂载点没挂上',
    ).toContain('restore failed: no such file:')
  } finally {
    // 待生效标记必须先拆掉：否则 harness 停机 / 后续任何一次启动都会真的把库换掉。
    rmSync(join(home, '.restore-pending'), { recursive: true, force: true })
    await daemon.stop()
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-019 —— 冷恢复真的把库换回备份时点
// ---------------------------------------------------------------------------

test('RFC-319 OPS-019: restore --yes 冷恢复把库换回备份时点，并按 --no-safety-backup 决定留不留反悔的余地 @nightly', async () => {
  const home = freshHome('restore-apply')
  const work = freshHome('restore-apply-fixtures')
  const daemon: DaemonHandle = await startDaemon({ home })
  let stopped = false
  try {
    const before = `rfc319-before-${Date.now().toString(36)}`
    const after = `${before}-after`
    await createAgent(daemon, before)
    const tarball = await takeBackup(daemon)
    await createAgent(daemon, after)
    expect(
      await agentNames(daemon),
      '前置不成立：备份之后新建的代理没进库，后面就没有可判定的观察点',
    ).toContain(after)

    await daemon.stop()
    stopped = true

    const dbPath = join(home, 'db.sqlite')
    const namesInDb = (): string[] =>
      querySqlite<{ name: string }>(
        dbPath,
        "SELECT name FROM agents WHERE name LIKE 'rfc319-before-%' ORDER BY name",
      ).map((r) => r.name)
    expect(namesInDb(), '前置不成立：停机后库里应当同时有备份前后两条代理').toEqual(
      [before, after].sort(),
    )

    const applied = runCli(home, ['restore', tarball, '--yes'])
    expect(applied.code, `冷恢复失败：${applied.out}`).toBe(0)
    expect(applied.out, '恢复完成却不给回执 ⇒ 用户不知道到底换没换').toContain('restore complete:')
    expect(
      applied.out,
      '回执里没有报出恢复了哪几类状态 ⇒ config / skills 是不是也被换了无从判断，' +
        '而技能的事实源就是文件系统',
    ).toContain('restored:      db=true config=true skills=true')

    // 两个方向都断言：备份时点那条必须回来，备份之后那条必须消失。
    // 只断一头会同时放过「恢复什么都没做」和「恢复把库清空了」。
    expect(
      namesInDb(),
      '冷恢复之后备份之后新增的数据还在 ⇒ 恢复根本没生效，而用户以为已经回滚了',
    ).toEqual([before])

    // 安全备份：默认必须留一份，否则「误恢复也能再翻回来」这句承诺是空的。
    const safetyLine = /^ {2}safety backup: (.+)$/m.exec(applied.out)?.[1]?.trim()
    expect(
      safetyLine,
      '恢复回执里没有安全备份这一行 ⇒ 用户不知道自己刚被覆盖掉的那份数据去哪了',
    ).toBeDefined()
    expect(
      safetyLine === undefined ? false : existsSync(safetyLine),
      '回执里报了一个安全备份路径，盘上却没有这个文件 ⇒ 用户以为留了退路，实际没有',
    ).toBe(true)
    const fsSafety = readdirSync(join(home, 'backups')).filter((n) =>
      n.startsWith('pre-restore-fs-'),
    )
    expect(
      fsSafety.length,
      '只备份了库、没备份 config.json 与 skills/ ⇒ 恢复会删掉当前技能目录，' +
        '而它的事实源就是文件系统，删了就没了',
    ).toBeGreaterThan(0)

    // `--no-safety-backup` 是一个真闸门，不是装饰：它必须真的少写一份。
    const safetyBefore = readdirSync(join(home, 'backups')).filter((n) =>
      n.startsWith('pre-restore-'),
    ).length
    const noSafety = runCli(home, ['restore', tarball, '--yes', '--no-safety-backup'])
    expect(noSafety.code, `带 --no-safety-backup 的冷恢复失败：${noSafety.out}`).toBe(0)
    expect(
      noSafety.out,
      '`--no-safety-backup` 之下回执还是报了一个安全备份路径 ⇒ 用户读回执会以为有退路',
    ).toContain('safety backup: skipped')
    expect(
      readdirSync(join(home, 'backups')).filter((n) => n.startsWith('pre-restore-')).length,
      '`--no-safety-backup` 之下仍然写了安全备份 ⇒ 这个 flag 是装饰，' +
        '在磁盘吃紧时用它来腾空间的用户会再次撞上写满',
    ).toBe(safetyBefore)
  } finally {
    if (!stopped) await daemon.stop()
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-023 —— package export / import 的破窗边界
// ---------------------------------------------------------------------------

test('RFC-319 OPS-023: package export/import 一律以 --as-user 的身份发生，缺了它在碰盘之前就拒绝 @nightly', () => {
  const home = freshHome('package')
  try {
    // ① 用法面：不给子命令 / 给错子命令都要打印同一份说明，并把两条命令的
    //    完整形态与破窗边界写清楚。
    const usage = runCli(home, ['package'])
    const unknown = runCli(home, ['package', 'frobnicate'])
    for (const [label, result] of [
      ['package', usage],
      ['package frobnicate', unknown],
    ] as const) {
      expect(
        result.code,
        `\`agent-workflow ${label}\` 以 0 退出 ⇒ 脚本里少写一个词会被当成"导入成功"`,
      ).toBe(1)
      expect(result.out, `\`${label}\` 没有打印用法 ⇒ 用户在终端里拿不到任何指引`).toContain(
        'usage: agent-workflow package <export|import> --as-user <username> [options]',
      )
      expect(
        result.out,
        `\`${label}\` 的用法里没有列全可导出的资源类型 ⇒ 用户只能靠试错找出 --type 收什么`,
      ).toContain('--type <agent|skill|mcp|plugin|workflow|workgroup>')
      expect(
        result.out,
        `\`${label}\` 的用法里没有说明 --plan/--apply/--on-conflict 三选一 ⇒ 用户会以为` +
          '不带任何决策来源就是"照默认导入"，而导入会创建并覆盖资源',
      ).toContain('All three are mutually exclusive, and omitting all three is an')
      expect(
        result.out,
        `\`${label}\` 的用法里没有声明破窗边界 ⇒ 用户会把 CLI 当成绕过可见性 / 归属规则的后门`,
      ).toContain('Break-glass boundary:')
    }
    expect(
      usage.out,
      '两种用法错给出的说明书不一致 ⇒ 用户按其中一份记住的写法在另一条路上不成立',
    ).toBe(unknown.out)

    // ② `--as-user` 是强制的，两条子命令都不许例外。它不是形式：导出的可见性
    //    判定、导入的归属与"只能覆盖自己的"全部从这个身份出。
    const wouldBeZip = join(home, 'should-not-exist.zip')
    for (const args of [
      ['package', 'export', '--type', 'agent', '--name', 'anything', '--out', wouldBeZip],
      ['package', 'import', '--file', join(home, 'anything.zip'), '--on-conflict', 'new'],
    ]) {
      const refused = runCli(home, args)
      expect(
        refused.code,
        `\`${args.slice(0, 2).join(' ')}\` 不带 --as-user 却以 0 退出 ⇒ 导出 / 导入会以某个` +
          '隐含身份发生，"这包是谁导的、导进来的东西归谁"从此不可追溯',
      ).toBe(1)
      expect(
        refused.out,
        `\`${args.slice(0, 2).join(' ')}\` 缺 --as-user 时没有说清"每次操作都发生在某个人名下"`,
      ).toContain('--as-user is required: every package operation happens AS someone.')
    }

    // ③ 拒绝必须发生在**碰盘之前**：既不许写出半个 zip，也不许顺手把数据库建出来。
    //    这条把"参数校验在前、副作用在后"钉死——顺序反过来时，一次拼错参数的
    //    调用会在一台待排查的机器上留下状态。
    expect(
      existsSync(wouldBeZip),
      '被拒的导出仍然写出了目标文件 ⇒ 用户会拿着一个半截 / 空的配置包去别处导入',
    ).toBe(false)
    expect(
      readdirSync(home),
      '被拒的 package 调用在 $AGENT_WORKFLOW_HOME 里落了文件（典型是 db.sqlite）⇒ ' +
        '参数校验发生在打开数据库之后，一次拼错的命令就给机器留下了状态',
    ).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-018 —— backup 的回执与磁盘产物
// ---------------------------------------------------------------------------

test('RFC-319 OPS-018: backup 说「写好了」当且仅当盘上真有一个可用的 tar.gz，失败也不许留下残骸 @nightly', () => {
  const home = freshHome('backup')
  try {
    // ⚠️ 这条用例**不假设 backup 今天能成功**，因为在发行二进制上它今天不能：
    // `cli/backup.ts:16` 用的是 `Paths.migrationsDir`（`util/paths.ts:94-96`，
    // 解析到源码树里的 `packages/backend/db/migrations`），而单二进制里没有那个
    // 目录——`cli/user.ts:72-78` / `cli/restore.ts:32-35` / `cli/start.ts:346-355`
    // 都为此做了 `IS_EMBEDDED` 的解包，backup 没有。实测详见文件末尾。
    //
    // 所以这里锁的是**回执与磁盘的一致性**，这条不变量在缺陷修好之前之后都成立，
    // 而且修好之后会自动开始校验账本上写的那件事（真的产出一个可用的 tar.gz）：
    //   * 说了 `backup written:` ⟺ 退出码为 0；
    //   * 盘上有产物 ⟺ 说了 `backup written:`；
    //   * 无论成败都不许留下 `.staging-*` 半成品。
    const backupsDir = join(home, 'backups')
    const listBackups = (): string[] =>
      existsSync(backupsDir) ? readdirSync(backupsDir).sort() : []

    for (const extra of [[], ['--include-worktrees']]) {
      const label = extra.length === 0 ? 'backup' : 'backup --include-worktrees'
      const attempt = runCli(home, ['backup', ...extra])

      expect(
        attempt.out.trim(),
        `\`${label}\` 什么都没打印 ⇒ 用户对着一个空终端，既不知道备份放在哪，` +
          '也不知道到底成没成',
      ).not.toBe('')

      const claimed = /^backup written: (.+)$/m.exec(attempt.out)?.[1]?.trim() ?? null
      expect(
        claimed !== null,
        `\`${label}\` 的回执与退出码对不上 ⇒ 要么它以 0 退出却没说写到哪（备份脚本记成功、` +
          '实际什么都没留下），要么它说写好了却以非 0 退出（备份脚本记失败、明天没人来救）',
      ).toBe(attempt.code === 0)

      const produced = listBackups().filter((n) => n.endsWith('.tar.gz'))
      expect(
        produced.length > 0,
        `\`${label}\` 的回执与磁盘对不上 ⇒ 备份这件事唯一的交付物就是那个文件，` +
          '回执说有而盘上没有，是最坏的一种"以为自己有备份"',
      ).toBe(claimed !== null)

      if (claimed !== null) {
        expect(
          existsSync(claimed),
          `\`${label}\` 回执里报的路径在盘上不存在 ⇒ 用户按这个路径去取备份会扑空`,
        ).toBe(true)
        const listing = runTar(['-tzf', claimed])
        expect(listing.code, `\`${label}\` 产出的不是一个能解开的 tar.gz：${listing.out}`).toBe(0)
        for (const entry of ['db.sqlite', 'manifest.json']) {
          expect(
            listing.out,
            `\`${label}\` 产出的包里没有 ${entry} ⇒ 恢复时会以「不是备份包」被拒，` +
              '而用户是在灾难现场才发现这一点',
          ).toContain(entry)
        }
      }

      expect(
        listBackups().filter((n) => n.startsWith('.staging-')),
        `\`${label}\` 之后留下了打包用的暂存目录 ⇒ 每失败一次就多占一份整库大小的磁盘，` +
          '而这类命令通常配在定时任务里反复跑',
      ).toEqual([])
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 未覆盖 / 实测缺陷（写下来是为了让下一个人不必重新发现）
// ---------------------------------------------------------------------------
//
// 1. **`agent-workflow backup` 在 `acad5b94` 的发行单二进制上完全不可用。** 无论新
//    机器还是 daemon 跑过的机器，它都以退出码 1 收场，stderr 只有一句 `Can't find
//    meta/_journal.json file`——既没有 `backup failed:` 前缀（那一版 `cli/backup.ts`
//    的 `openDb` 在 try 之外），也不提这跟迁移目录有关。同一个根因还带塌了
//    `migrate` / `migration-report`，以及 `package` 在 `--as-user` 之后的全部实质
//    路径：这四处直接用 `Paths.migrationsDir`（`util/paths.ts:94-96`，指向源码树里
//    的 `packages/backend/db/migrations`），而 `cli/user.ts` / `cli/restore.ts` /
//    `cli/start.ts` 都为单二进制做了 `IS_EMBEDDED` 解包。`doctor` 还在主动建议用户
//    去敲 `agent-workflow backup`。
//    上面 OPS-018 因此写成**回执 ⟺ 磁盘**的等价式而不是「一定成功」：在坏的那一版
//    上它锁住「失败也不许骗人、不许留残骸」，在修好的版本上成功分支自动接管，开始
//    校验账本上写的那件事（真的产出一个含 db.sqlite + manifest.json 的 tar.gz）。
//    两种二进制都实跑验证过全绿。
//
// 2. **`config set <未知键> <值>` 以 0 退出并打印 `<键> = undefined`。** schema 把
//    未知键剥掉（这是对的，用例锁住了「不落盘」），但退出码骗人——脚本里一个拼错
//    的键名会被记成"配好了"。上面只断言了"不落盘"与"回执里至少有键名"，没有把
//    退出码写成期望，因为 0 是缺陷而不是契约。
//
// 3. **未覆盖的 restore 分支**：`--no-migrate` / `--skip-integrity-check` 两个逃生
//    闸、`direction: forward` 的真迁移路径、以及 pre-migration 备份的二进制绑定拒绝
//    （`RestorePreMigrationBinaryError`）。它们都需要**两个迁移代数不同的二进制**
//    才能在 e2e 层构造，单次 CI 只产出一个。同理未覆盖 `--stage` 之后重启真正生效
//    的那一跳——它已由 `e2e/ops-local-recovery.spec.ts` 的 OPS-020 从 HTTP 面覆盖。
//
// 4. **未覆盖的 user 分支**：`--role admin|user|guest` 的另外三个取值（只跑了
//    manager 与 --admin）、OIDC 托管用户的改密拒绝（`oidc-password-managed`，需要
//    先接一个 OIDC 提供方）、以及对 `__system__` 的三条不可变拒绝——CLI 走的是
//    `findByUsername`，而 `__system__` 是一行真实存在的用户，够得着但会改动那行
//    保留数据，风险不对等，留给后端单测。
