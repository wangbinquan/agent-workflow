# RFC-216 任务分解（v3 —— 两轮设计门后定稿）

> 读序：[proposal.md](./proposal.md) → [design.md](./design.md) → 本文。
> 特征：小而内聚的只读 CLI，默认**单 PR** 交付。v3 并入两轮设计门 11 findings + 3 决策。

## 子任务

| ID | 内容 | 依赖 | 备注 |
| --- | --- | --- | --- |
| **RFC-216-T1** | `config/index.ts` 抽只读 `readConfig(path): Config \| null`（缺文件 null、**存在也只读不回写**）；`loadConfig` 重构为 `readConfig ?? (saveConfigRaw(DEFAULT); DEFAULT)`（逐字节不变）+ 测试 | 无 | **P1-1/P2#2**：缺文件→null 零变化；已存在 partial/损坏→字节不变 + 嵌套默认 parity；loadConfig 回归锁；调用点不可达 save |
| **RFC-216-T2** | `services/sandbox/guidance.ts` 纯函数：`renderSandboxReport`（返 `{text,exitCode}`）/`detectPackageManager`/`installHint`/`usernsHint` + `guidance.test.ts` | 无 | 纯零副作用；入参含 `diag`/`bwrapOnPath`/`requireAvailable`；§8-1 全 case + §5 真值表逐格 |
| **RFC-216-T3** | `cli/sandbox.ts` `sandboxCommand()`：**argv allowlist（fail-closed，未知→exit 2）** + `boundedSpawn`（复用 **`killProcessTree`**，侧记 `ProbeDiagnostics`）→probe + `readConfig` + `Bun.which` + render + `main.ts` `case` + usage + `sandbox-cli.test.ts`（子进程退出码 §8-4 + 有界回收 fixture §8-5 + ProbeDiagnostics §8-6） | T1,T2 | **P1#1/#2/#4 + P2#1 + P1-3/P1-4/P2-1/P2-2** |
| **RFC-216-T4** | 只读守卫：静态白名单 + `boundedSpawn` 调用点守卫 + 子进程 sentinel（禁令二进制零调用 + 假 bwrap 不写禁令 sentinel + HOME 零写入 + 印出安装指引 + 探测 argv 精确白名单） | T3 | **P1-1/P1-2/P1#3**：变异（打印→执行、误用 loadConfig、boundedSpawn 挪用）必红 |
| **RFC-216-T5** | `cli/doctor.ts` 加 `checkSandbox()`（`ok=!(enforce&&不可用)`，经 boundedSpawn）+ `doctorCommand` mode×available 矩阵测试 | T2,T3 | **决策 B/P1-5**：warn+不可用不撞红、enforce+不可用退 1 |
| **RFC-216-T6** | `docs/sandbox.md` 加自检节（含 `--require-available` 与退出码表） | T3 | 纯文档 |
| **RFC-216-T7** | 门槛全绿 + `build:binary` + **双 OS** smoke + 推后查 CI | T1–T6 | 不回归 golden argv/既有子命令 |

## PR 拆分建议

**单 PR**：`feat(backend): RFC-216 沙箱环境自检 CLI（agent-workflow sandbox）`。`readConfig`
抽取虽触 `config/index.ts`，但 `loadConfig` 逐字节不变 + 回归锁，随同 PR。

## 验收清单（对应 proposal.md §5）

- [ ] AC-1 macOS seatbelt + 真实可用性 + 可用退 0
- [ ] AC-2 Linux `Bun.which`→null → 安装命令（含 unknown 回退）+ 如实标注 + mode≠off 退 1
- [ ] AC-3 Linux `Bun.which`→路径且非超时 → stderr 证据 + **有条件** sysctl（不无条件断言 userns）；真实 exit 124 ≠ 超时
- [ ] AC-4 不可用且 mode≠off → 含「重启 daemon 生效」
- [ ] AC-5 mode=off → 注明关闭 + 默认退 0
- [ ] AC-5b `--require-available` = `mode≠off && 可用` 才 0；off+available/off+timeout/off+throw 交叉格入测
- [ ] AC-6 只读：静态白名单 + boundedSpawn 调用点守卫 + sentinel（禁令零执行 + HOME 零写入 + 印出指引 + 探测 argv 白名单）；变异必红
- [ ] AC-7 结论与 `probeSandboxMechanism` 同源（仅注入 boundedSpawn）
- [ ] AC-8 doctor `checkSandbox` 真值表（仅 enforce+不可用 fail）+ doctorCommand 矩阵退出码
- [ ] AC-9 help 列出 `sandbox` + 子进程级 stdout/exitCode 锁（exit 改恒 0 必红）
- [ ] AC-10 有界回收：复用 killProcessTree（组 SIGKILL）；fixture 忽略 SIGTERM + 孙进程 → 有限返回 + 零 survivor
- [ ] AC-11 argv fail-closed：未知 flag（拼错）/positional/缺值 → exit 2，不静默回退；--help 优先
- [ ] 变异实证：missing/userns 互斥、只读三段、退出码全表、超时回收、argv、readConfig 回写、doctor 矩阵 —— 各自必红
- [ ] `build:binary` + 双 OS smoke + CI HEAD 双 OS 绿

## 登记

- `design/plan.md` RFC 索引：RFC-216 行（Draft → 实现后 Done）。
- `STATE.md`：顶部「进行中 RFC」行；完工后转已完成 + Done。
