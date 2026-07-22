# RFC-216 任务分解

> 读序：[proposal.md](./proposal.md) → [design.md](./design.md) → 本文。
> 特征：小而内聚的只读 CLI，默认**单 PR** 交付。

## 子任务

| ID | 内容 | 依赖 | 备注 |
| --- | --- | --- | --- |
| **RFC-216-T1** | `services/sandbox/guidance.ts` 纯函数：`renderSandboxReport` / `detectPackageManager` / `installHint` / `usernsHint` + `guidance.test.ts` | 无（仅用 `SandboxStatus`/`SandboxMode` 类型） | 纯函数，零副作用；测试策略 §7-1 全 case |
| **RFC-216-T2** | `cli/sandbox.ts` `sandboxCommand()` + `main.ts` `case 'sandbox'` + usage 行 + `sandbox-cli.test.ts`（含 §6 只读守卫） | T1 | 唯一 spawn=探测；退出码语义 |
| **RFC-216-T3** | `cli/doctor.ts` 加 `checkSandbox()` + 测试 | T1 | **可选项**——用户可在批准时砍（AC-8）。砍则同 PR 去掉、AC-8 标 N/A |
| **RFC-216-T4** | `docs/sandbox.md` 加「## 自检：`agent-workflow sandbox`」节（+ README 索引若有） | T2 | 纯文档 |
| **RFC-216-T5** | 门槛全绿 + `build:binary` smoke（新子命令进单二进制、不回归 golden argv/既有子命令）+ 推后查 CI | T2,T3,T4 | typecheck/lint/test/format:check |

## PR 拆分建议

**单 PR**：`feat(backend): RFC-216 沙箱环境自检 CLI（agent-workflow sandbox）`。
特征小、强内聚，无需拆分。T3 若被砍随同 PR 移除。

## 验收清单（对应 proposal.md §5）

- [ ] AC-1 macOS seatbelt + 真实可用性 + 可用退出 0
- [ ] AC-2 Linux 127 → 发行版安装命令（含 unknown 回退）+ mode≠off 退出 1
- [ ] AC-3 Linux 非 127 非零 → userns sysctl 指引（不打印安装命令）+ 安全提示
- [ ] AC-4 不可用且 mode≠off → 含「重启 daemon 生效」
- [ ] AC-5 mode=off → 注明关闭 + 退出 0
- [ ] AC-6 只读守卫：唯一 spawn=探测，变异必红
- [ ] AC-7 结论与 `probeSandboxMechanism` 同源
- [ ] AC-8 doctor 沙箱检查项（若保留 T3）
- [ ] AC-9 help 列出 `sandbox`
- [ ] 变异实证：missing/userns 分支互斥、只读守卫、退出码 —— 各自必红
- [ ] `build:binary` smoke + CI HEAD 双 OS 绿

## 登记

- `design/plan.md` RFC 索引：追加 RFC-216 行（状态 Draft → 实现后 Done）。
- `STATE.md`：顶部「进行中 RFC」行指向本目录；完工后转已完成 + Done。
