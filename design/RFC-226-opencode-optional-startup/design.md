# RFC-226 OpenCode 可选运行时与 daemon 启动解耦 — design

状态：Done（2026-07-24，用户已批准；设计门与实现门通过）。以 `proposal.md` 为产品合同。

## 1. 当前调用链

```text
startCommand
  ├─ loadConfig
  ├─ getRuntimeDriver("opencode")
  ├─ driver.probe(binary, 20s)
  │    └─ probeOpencode -> Bun.spawn("<binary> --version")
  │         └─ recordOpencodeBinaryVersion(binary, version)
  ├─ missing/incompatible -> lock.release + process.exit(1)
  ├─ git capability gate
  ├─ open DB / seed runtime rows
  └─ createApp({ opencodeVersion: probe.version })
```

问题不只是 exit 条件：probe 本身在 DB/runtime 解析之前无条件执行了可选 runtime executable，并把
一个历史 argv 拼写缓存的副作用变成 daemon 可用性的前置条件。

## 2. 目标调用链

```text
startCommand
  ├─ loadConfig
  ├─ [不解析、不执行 OpenCode]
  ├─ git capability gate
  ├─ open DB / seed runtime rows
  └─ createApp({ opencodeVersion: null })

显式诊断或执行
  ├─ /api/runtimes/status | Test | models | doctor
  │    └─ 各自现有 bounded/official diagnostic gate
  └─ business/system/smoke execution
       └─ RuntimeDriver -> RFC-224 verified plan -> exact official snapshot
```

启动与运行时 readiness 分离：daemon health 表示控制面活着；某个 runtime 是否能执行由 runtime
status 与该次操作的 admission 表示。版本门只是后移，不删除：不满足版本要求时 runtime
validation 明确失败，但不反向终止 daemon。

## 3. 生产改动

### 3.1 `cli/start.ts`

删除整段 OpenCode boot probe 与 `BOOT_PROBE_TIMEOUT_MS`。`getRuntimeDriver` import 仍保留给
Claude Code 的条件式 soft probe；`markProductionOpencodeCommand` 仍用于后续任务恢复/启动闭包，
不因本 RFC 删除。

`createApp()` 明确传 `opencodeVersion: null`。不做后台 fire-and-forget probe：那仍会在用户没有
选择 OpenCode 时执行可选 binary，也会重新引入启动竞态与含糊的 health 状态。

git probe 继续 fail closed，并继续由 `services/gitVersion.ts` 自身的 timeout 常量约束；注释不再
把它类比为 OpenCode hard gate。

### 3.2 health / status

`AppDeps.opencodeVersion` 暂保留 `string | null` seam，避免无关的 createApp fixture 全量 churn；
production 永远传 `null`，测试可以显式注入字符串验证 wire 兼容。

`/health` shape 不变：

```ts
{
  ok: true,
  opencodeVersion: string | null,
  dbVersion: number,
  uptime: number,
  runningTasks: number
}
```

contract registry 改为 `z.string().nullable()`。真实 daemon 与 CLI e2e 断言 `null`；
`formatStatus()` 把 null 显示为 `(not checked at startup)`，避免 `(unknown)` 同时承载“没查”和
“查失败”。

### 3.3 use-time gates 保持

本 RFC 不改以下执行接缝：

- `opencodeDriver.buildBusinessSpawn()` → `buildVerifiedOpencodeBusinessPlan()`；
- `opencodeDriver.buildSpawn()` → `buildVerifiedOpencodeSystemPlan()`；
- runtime status/models 的 `withOfficialOpencodeSnapshot()`；
- runtime smoke 的 verified system plan；
- RFC-224 source-reachability guard。

因此删除 boot `--version` 不会放宽生产 binary：实际使用仍要求 official manifest 的
v1.18.3 + OS/arch digest，且 copy 后 re-hash。

显式 Runtime status/Test/probe 同样不把“进程能执行”冒充为“版本合格”。OpenCode status
精确使用 `ok = probe.ran === true && probe.compatible`；旧版、版本不可解析或不匹配 official
build 的 OpenCode 必须得到失败结果。wire 不新增 `compatible/minVersion`，runtime row 可继续
存在，方便管理员修正 binaryPath 或禁用/删除。这一失败不改变 daemon lifecycle。Claude Code
保留既有 status 可用性语义，不随本 RFC 扩大行为变化。

### 3.4 旧 version registry 语义

`opencode-version-registry` 不再声称默认 binary 一定在 boot 时预热。它仍接收显式
`probeOpencode()` 的结果，供 legacy/test-only `opencode run` argv 拼写使用。

RFC-224 verified production path 不依赖该 registry；若未来仍有生产路径依赖“boot 已探测”的
隐式前提，source-reachability / targeted test 必须将其视为旁路并修正，不能恢复启动探测。

## 4. 策略矩阵

| 场景                          | 是否执行 OpenCode                               | 失败影响                         |
| ----------------------------- | ----------------------------------------------- | -------------------------------- |
| daemon start                  | 否                                              | 无 OpenCode 失败面               |
| `/health` / `status`          | 否                                              | 版本为 null / 显示启动未检查     |
| `/api/runtimes/status`        | 是，按需 official snapshot + version/build gate | 不合格时单 runtime 状态失败      |
| Runtime Test / models / smoke | 是，按需受控诊断 + version/build gate           | 不合格时当前请求失败             |
| OpenCode business/system task | 是，RFC-224 verified plan                       | 当前 node/task 失败              |
| Claude Code task              | 否                                              | 不受 OpenCode 影响               |
| `doctor`                      | 是，用户显式诊断                                | doctor 报告失败；daemon 不受影响 |

## 5. 测试策略

### 5.1 先红后绿回归

1. daemon 使用 `opencodePath` 指向 poison fixture：fixture 一旦执行就写 marker 并长时间等待；
   断言 daemon 在正常预算内 ready、marker 从未创建；
2. daemon 使用不存在的 `opencodePath`：断言 ready 且 `/health.opencodeVersion === null`；
3. `daemon-start.test.ts` 删除 `opencode probe ok` 日志断言，改为断言日志不含 boot probe；
4. `cli.test.ts` 锁 status 对 null 的明确展示；
5. contract registry 接受 null；
6. 同一个旧版本/不合格 fixture 在 daemon start 场景不被执行且不阻塞，在显式 runtime
   validation 场景则得到失败结果，锁定“版本门后移而非删除”。

poison fixture 路径写入隔离的 `AGENT_WORKFLOW_HOME/config.json`，不改宿主 PATH、不依赖开发机是否
安装 OpenCode。

### 5.2 旧锁迁移

`rfc208-boot-and-external-timeouts.test.ts`：

- 删除“OpenCode boot probe 必须 timeout + fail closed”两条已被本 RFC supersede 的断言；
- 增加源码级负向锁：`startCommand` 在 git gate 前不出现
  `getRuntimeDriver('opencode')` / OpenCode `probe` / OpenCode 失败 exit；
- 保留 git boot probe 有界、PlantUML 与其它 RFC-208 测试。

### 5.3 安全回归

继续运行 RFC-224 的 official-build、source-reachability、verified-plan、runtime status/models 与
smoke 定向测试，证明 use-time exact-hash gate 未被触碰。

## 6. 文档与注释

实施时同步：

- `design/plan.md` P-1-04：标记启动强制版本探测被 RFC-226 supersede；
- `design/design.md` `/health` 字段说明：`opencodeVersion` nullable、启动不探测；
- `design/RFC-208-*/design.md`：只追加 supersession 注，不改写历史决策；
- `docs/dev-gotchas.md`：启动期探测事故改为“可选 runtime 不得成为 boot gate”；
- `util/opencode.ts`、`opencode-version-registry.ts`、`runtime/opencode/spawn.ts`、
  `runner.ts` 中依赖“boot 必探 / OpenCode hard-required”的过时注释。

## 7. 失败模式

- **误删 use-time gate**：RFC-224 定向测试与 source reachability guard 必须保持全绿；
- **health 客户端把 null 当 schema error**：shared/contract/CLI 全部显式接受 null；
- **测试偷偷使用宿主 OpenCode**：poison/missing fixture 固定在临时 home，不看开发机 PATH 状态；
- **把可选误解为自动 fallback**：调度仍按冻结 runtime 执行，OpenCode 失败不改派；
- **保留 registry 隐式前提**：生产 verified path 不读取 boot probe cache；相关注释与源码锁清理。

## 8. 发布与回滚

单 PR、无 migration。发布前跑：

```text
bun run typecheck
bun run lint
bun run test
bun run format:check
bun run build:binary
```

并额外运行 RFC-224 相关定向测试与 compiled binary 启动 smoke。回滚生产与测试/文档一并回滚即可。
