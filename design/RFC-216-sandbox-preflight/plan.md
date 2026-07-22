# RFC-216 任务分解（v2 —— 随设计门修订更新）

> 读序：[proposal.md](./proposal.md) → [design.md](./design.md) → 本文。
> 特征：小而内聚的只读 CLI，默认**单 PR** 交付。v2 并入设计门 7 findings + 3 决策。

## 子任务

| ID | 内容 | 依赖 | 备注 |
| --- | --- | --- | --- |
| **RFC-216-T1** | `config/index.ts` 抽只读 `readConfig(path): Config \| null`（缺文件返回 null、**不写盘**）；`loadConfig` 重构为 `readConfig(path) ?? (saveConfigRaw(DEFAULT); return DEFAULT)`（行为逐字节不变）+ 测试 | 无 | **P1-1**：缺文件→null 且 home 零变化；loadConfig 缺文件仍写默认（回归锁） |
| **RFC-216-T2** | `services/sandbox/guidance.ts` 纯函数：`renderSandboxReport`/`detectPackageManager`/`installHint`/`usernsHint` + `guidance.test.ts` | 无 | 纯函数零副作用；`bwrapOnPath`/`requireAvailable` 入参；测试策略 §8-1 全 case |
| **RFC-216-T3** | `cli/sandbox.ts` `sandboxCommand()`（`boundedSpawn`→probe + `readConfig` + `Bun.which` + render + `--require-available`）+ `main.ts` `case 'sandbox'` + usage 行 + `sandbox-cli.test.ts`（子进程退出码 §8-3 + 超时 fixture §8-4） | T1,T2 | **P1-3/P1-4/P2-1/P2-2**：Bun.which 分未装/坏、退出码语义、有界探测 |
| **RFC-216-T4** | 只读守卫两层：静态白名单 `sandbox-cli-readonly-guard.test.ts`（禁 child_process/Bun.$/execSync/fs 写；Bun.spawn ≤1）+ 子进程 sentinel 测试（假 apt/bwrap/sysctl + 全新 HOME → 零执行 + 零写入含无 config.json） | T3 | **P1-1/P1-2**：变异（打印→执行、误用 loadConfig）必红 |
| **RFC-216-T5** | `cli/doctor.ts` 加 `checkSandbox()`（`ok = !(enforce && 不可用)`，经 boundedSpawn 探测）+ `doctorCommand` mode×available 矩阵测试 | T2 | **决策 B/P1-5**：warn+不可用不撞红 doctor、enforce+不可用退 1 |
| **RFC-216-T6** | `docs/sandbox.md` 加「## 自检：`agent-workflow sandbox`」节（含 `--require-available`）+ README 索引若有 | T3 | 纯文档 |
| **RFC-216-T7** | 门槛全绿（typecheck/lint/test/format:check）+ `build:binary` + **双 OS** smoke（`<bin> sandbox`/`--help` 报告与退出码，不回归 golden argv/既有子命令）+ 推后查 CI | T1–T6 | —— |

## PR 拆分建议

**单 PR**：`feat(backend): RFC-216 沙箱环境自检 CLI（agent-workflow sandbox）`。特征小、
强内聚。T1 的 `readConfig` 抽取虽触 `config/index.ts` 共享文件，但 `loadConfig` 行为不变、
有回归锁，随同一 PR 交付。

## 验收清单（对应 proposal.md §5，已并入设计门修订）

- [ ] AC-1 macOS seatbelt + 真实可用性 + 可用退出 0
- [ ] AC-2 Linux `Bun.which`→null → 发行版安装命令（含 unknown 回退）+ 如实标注 + mode≠off 退 1
- [ ] AC-3 Linux `Bun.which`→路径但探测非零 → hedge sysctl（不打印安装命令）+ exitCode/stderr + 安全提示
- [ ] AC-4 不可用且 mode≠off → 含「重启 daemon 生效」
- [ ] AC-5 mode=off → 注明关闭 + 默认退出 0
- [ ] AC-5b `--require-available` → 可用 0 / 否则（含 off、不可用）非零
- [ ] AC-6 只读：静态白名单守卫 + 子进程 sentinel（零执行 + 零写入含无 config.json）；变异必红
- [ ] AC-7 结论与 `probeSandboxMechanism` 同源（仅注入 boundedSpawn）
- [ ] AC-8 doctor `checkSandbox` 真值表（仅 enforce+不可用 fail）+ doctorCommand 矩阵退出码
- [ ] AC-9 help 列出 `sandbox` + 子进程级 stdout/exitCode 锁（exit 改恒 0 必红）
- [ ] AC-10 探测有界：boundedSpawn 超时 → 报告「探测超时」+ 退出 1；永不退出 fixture 证明不挂起
- [ ] 变异实证：missing/userns 互斥、只读两层、退出码（含 --require-available）、超时、doctor 矩阵 —— 各自必红
- [ ] `build:binary` + 双 OS smoke + CI HEAD 双 OS 绿

## 登记

- `design/plan.md` RFC 索引：RFC-216 行（Draft → 实现后 Done）。
- `STATE.md`：顶部「进行中 RFC」行指向本目录；完工后转已完成 + Done。
