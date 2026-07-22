# RFC-216 任务分解（v5 —— 四轮设计门后定稿，进入实现）

> 读序：[proposal.md](./proposal.md) → [design.md](./design.md) → 本文。
> 特征：小而内聚的只读 CLI，默认**单 PR** 交付。v5 并入四轮设计门 20 findings + 4 决策（A/B/C/D）。

## 子任务

| ID | 内容 | 依赖 | 备注 |
| --- | --- | --- | --- |
| **RFC-216-T1** | `config/index.ts` 抽 `readConfig(path): Config \| null`（缺→null、存在→**只读解析**、损坏→**throw**）；`loadConfig` 逐字节不变 + 测试 | 无 | 缺→null 零变化；已存在 partial→字节不变+嵌套默认 parity；损坏→throw 不写；loadConfig 回归锁；调用点不可达 save |
| **RFC-216-T2** | `services/sandbox/guidance.ts` 纯函数：`renderSandboxReport`（返 `{text,exitCode}`，入参含 `diag`/`bwrapOnPath`/`requireAvailable`/`configReadable`）/`detectPackageManager`/`installHint`/`usernsHint` + `guidance.test.ts` | 无 | §8-1 全 case + §5 真值表逐格（含 configReadable=false→exit2、off×{available,timeout,error}） |
| **RFC-216-T3** | `cli/sandbox.ts` `sandboxCommand()`：argv allowlist（fail-closed→exit2）+ `readConfig` **try/catch（损坏→configReadable=false→exit2、不篡改 available）** + `boundedSpawn`（复用 `killProcessTree`；超时+`finally` 两处组杀；**整生命周期 catch**〔启动抛/exited reject/stderr reject〕→`kind:'error'` 永不 throw；**流式 capped reader**；侧记 `ProbeDiagnostics` 判别联合）→probe + `Bun.which` + render + `main.ts` `case`/usage + `sandbox-cli.test.ts`（§8-4 退出码全表 + §8-5 回收 fixture×2 + §8-6 故障注入） | T1,T2 | 全轮 P1/P2 + 决策 A/D |
| **RFC-216-T4** | 只读守卫：静态白名单 + `boundedSpawn` 调用点守卫 + **spawn-seam 全 argv allowlist（含 macOS 注入锁 argv）** + 三子进程场景（A 未装 / B 装了坏记 argv / macOS 真绝对路径探针），每场景 **HOME/AGENT_WORKFLOW_HOME/cwd/TMPDIR/XDG 全隔离逐目录快照** + 禁令零执行 + 零写入 + **cwd 写/tmp 写/绝对路径 shell 三逃逸变异** | T3 | P1-1/P1-2/P1#1-r3/P1#1・#2-r4 |
| **RFC-216-T5** | `cli/doctor.ts` 加 `checkSandbox()`（`ok=!(enforce&&不可用)`，经 boundedSpawn，**自 catch readConfig 抛→降级不 reject**）+ `doctorCommand` mode×available 矩阵 + 损坏 config 不截断 | T2,T3 | 决策 B/P1-5/P1#4-r3 |
| **RFC-216-T6** | `docs/sandbox.md` 自检节（`--require-available` + 退出码表含 exit2/损坏 config） | T3 | 纯文档 |
| **RFC-216-T7** | 门槛全绿 + `build:binary` + **双 OS** smoke + 推后查 CI | T1–T6 | 不回归 golden argv/既有子命令 |

## PR 拆分建议

**单 PR**：`feat(backend): RFC-216 沙箱环境自检 CLI（agent-workflow sandbox）`。`readConfig`
抽取触 `config/index.ts` 但 `loadConfig` 逐字节不变 + 回归锁，随同 PR。

## 验收清单（对应 proposal.md §5）

- [ ] AC-1 macOS seatbelt + 真实可用性 + 可用退 0
- [ ] AC-2 Linux `Bun.which`→null → 安装命令（含 unknown 回退）+ 如实标注 + mode≠off 退 1
- [ ] AC-3 Linux `Bun.which`→路径 `kind==='exit'` 非零 → stderr 证据 + 有条件 sysctl；`exit 124`(`kind==='exit'&&124`)≠超时(`kind==='timeout'`)
- [ ] AC-4 各不可用态（未装/装了坏/timeout/error）且 mode≠off → 含「重启 daemon」；表驱动 oracle + 删提示变异必红
- [ ] AC-5 mode=off → 注明关闭 + 默认退 0
- [ ] AC-5b 真值表：默认 `off||available`→0 / 严格档 `mode≠off&&available`→0；异常归 unavailable 走表不崩；off+available/timeout/error 交叉格
- [ ] AC-5c 决策 D：`configReadable=false`（损坏）→ 默认与严格档均 exit 2；两轴独立、available 不篡改
- [ ] AC-6 只读：静态白名单 + 调用点守卫 + spawn-seam argv allowlist（含 macOS 注入）+ 三场景（HOME/AGENT_WORKFLOW_HOME/cwd/TMPDIR/XDG 全隔离）+ 禁令零执行 + 零写入 + 三逃逸变异必红
- [ ] AC-7 结论与 `probeSandboxMechanism` 同源（仅注入 boundedSpawn）
- [ ] AC-8 doctor `checkSandbox` 真值表（仅 enforce+不可用 fail）+ doctorCommand 矩阵 + 损坏 config 不截断
- [ ] AC-9 help 列出 `sandbox` + 子进程级 stdout/exitCode 锁（exit 改恒 0 必红）
- [ ] AC-10 有界回收：killProcessTree（超时+finally 两处组杀）+ 两 fixture 零 survivor；整生命周期 catch→`kind:'error'` + 流式 capped reader + 故障注入（exited/stream reject、超大 stderr）
- [ ] AC-11 argv fail-closed：未知 flag（拼错）/positional/缺值→exit 2，不静默回退；--help 优先
- [ ] 变异实证：missing/userns 互斥、只读三场景+三逃逸、退出码全表（含 exit2）、异常归一、超时+finally 回收、argv、readConfig 回写、doctor+损坏 config、重启提示 —— 各自必红
- [ ] `build:binary` + 双 OS smoke + CI HEAD 双 OS 绿

## 登记

- `design/plan.md` RFC 索引：RFC-216 行（Draft → 实现后 Done）。
- `STATE.md`：顶部「进行中 RFC」行；完工后转已完成 + Done。
