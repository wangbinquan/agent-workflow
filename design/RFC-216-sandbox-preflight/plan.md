# RFC-216 任务分解（v4 —— 三轮设计门后定稿）

> 读序：[proposal.md](./proposal.md) → [design.md](./design.md) → 本文。
> 特征：小而内聚的只读 CLI，默认**单 PR** 交付。v4 并入三轮设计门 17 findings + 3 决策。

## 子任务

| ID | 内容 | 依赖 | 备注 |
| --- | --- | --- | --- |
| **RFC-216-T1** | `config/index.ts` 抽 `readConfig(path): Config \| null`（缺→null、存在→**只读解析**、损坏→**throw**）；`loadConfig` 逐字节不变 + 测试 | 无 | **P1-1/P2#2-r2**：缺→null 零变化；已存在 partial→字节不变 + 嵌套默认 parity；损坏→throw 不写；loadConfig 回归锁；调用点不可达 save |
| **RFC-216-T2** | `services/sandbox/guidance.ts` 纯函数：`renderSandboxReport`（返 `{text,exitCode}`，入参含 `diag`/`bwrapOnPath`/`requireAvailable`/`configUnreadable`）/`detectPackageManager`/`installHint`/`usernsHint` + `guidance.test.ts` | 无 | 纯零副作用；§8-1 全 case + §5 真值表逐格 |
| **RFC-216-T3** | `cli/sandbox.ts` `sandboxCommand()`：argv allowlist（fail-closed，未知→exit 2）+ `readConfig` **try/catch 降级** + `boundedSpawn`（复用 **`killProcessTree`**，超时 + `finally` 两处组杀，**catch Bun.spawn 抛→归一 unavailable 永不 throw**，侧记 `ProbeDiagnostics` 判别联合）→probe + `Bun.which` + render + `main.ts` `case`/usage + `sandbox-cli.test.ts`（§8-4 子进程退出码全表 + spawn 抛归一 + 损坏 config 降级 / §8-5 两个有界回收 fixture / §8-6 ProbeDiagnostics） | T1,T2 | **P1#1/#2/#3/#4-r3 + P1#1/#2/#4-r2 + P2#1** |
| **RFC-216-T4** | 只读守卫：静态白名单 + `boundedSpawn` 调用点守卫 + **三子进程场景**（A 未装 / B 装了坏记 argv / macOS），每个**双 HOME（HOME + AGENT_WORKFLOW_HOME）隔离**、禁令零执行、零写入、探测 argv 精确白名单 | T3 | **P1-1/P1-2/P1#1-r3**：变异（打印→执行、误用 loadConfig、boundedSpawn 挪用、漏 AGENT_WORKFLOW_HOME）必红 |
| **RFC-216-T5** | `cli/doctor.ts` 加 `checkSandbox()`（`ok=!(enforce&&不可用)`，经 boundedSpawn，**自 catch readConfig 抛→降级不 reject**）+ `doctorCommand` mode×available 矩阵 + **损坏 config 下 doctorCommand 不被截断** | T2,T3 | **决策 B/P1-5/P1#4-r3** |
| **RFC-216-T6** | `docs/sandbox.md` 自检节（含 `--require-available` + 退出码表） | T3 | 纯文档 |
| **RFC-216-T7** | 门槛全绿 + `build:binary` + **双 OS** smoke + 推后查 CI | T1–T6 | 不回归 golden argv/既有子命令 |

## PR 拆分建议

**单 PR**：`feat(backend): RFC-216 沙箱环境自检 CLI（agent-workflow sandbox）`。`readConfig`
抽取虽触 `config/index.ts`，但 `loadConfig` 逐字节不变 + 回归锁，随同 PR。

## 验收清单（对应 proposal.md §5）

- [ ] AC-1 macOS seatbelt + 真实可用性 + 可用退 0
- [ ] AC-2 Linux `Bun.which`→null → 安装命令（含 unknown 回退）+ 如实标注 + mode≠off 退 1
- [ ] AC-3 Linux `Bun.which`→路径且 `kind==='exit'` 非零 → stderr 证据 + **有条件** sysctl（非确诊 userns）；真实 exit 124 ≠ 超时
- [ ] AC-4 各不可用态（未装/装了坏/timeout/spawn-error）且 mode≠off → 含「重启 daemon」；表驱动 oracle + 删提示变异必红
- [ ] AC-5 mode=off → 注明关闭 + 默认退 0
- [ ] AC-5b 真值表：默认 `off||available`→0 / 严格档 `mode≠off&&available`→0；异常（spawn 抛/timeout/损坏 config）归 unavailable 走表、不崩 exit 1；off+available/timeout/throw 交叉格入测
- [ ] AC-6 只读：静态白名单 + boundedSpawn 调用点守卫 + **三场景 sentinel**（A 未装印安装命令 / B 装了坏无安装命令+argv 白名单 / macOS）；每场景**双 HOME 隔离** + 禁令零执行 + 零写入；变异必红
- [ ] AC-7 结论与 `probeSandboxMechanism` 同源（仅注入 boundedSpawn）
- [ ] AC-8 doctor `checkSandbox` 真值表（仅 enforce+不可用 fail）+ doctorCommand 矩阵 + **损坏 config 不截断**
- [ ] AC-9 help 列出 `sandbox` + 子进程级 stdout/exitCode 锁（exit 改恒 0 必红）
- [ ] AC-10 有界回收：复用 killProcessTree（超时 + finally 两处组杀）；两 fixture（忽略 SIGTERM+孙进程 / fork 后立即退出）→ 有限返回 + 零 survivor
- [ ] AC-11 argv fail-closed：未知 flag（拼错）/positional/缺值 → exit 2，不静默回退；--help 优先
- [ ] 变异实证：missing/userns 互斥、只读三场景、退出码全表、spawn 抛归一、超时+finally 回收、argv、readConfig 回写、doctor 矩阵+损坏 config、重启提示 —— 各自必红
- [ ] `build:binary` + 双 OS smoke + CI HEAD 双 OS 绿

## 登记

- `design/plan.md` RFC 索引：RFC-216 行（Draft → 实现后 Done）。
- `STATE.md`：顶部「进行中 RFC」行；完工后转已完成 + Done。
