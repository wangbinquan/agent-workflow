# RFC-242 Claude Code 运行时安全姿态对齐（proposal）

- 状态：Draft（待用户批准）
- 日期：2026-07-31
- 关联：RFC-111（claude 运行时接入）、RFC-117（内部 agent 运行时）、RFC-205/233（containment）、RFC-224/227（opencode 执行身份）、RFC-237（intent 受控分支 + env/argv 单点化）、RFC-238（MCP 试跑）

## 背景

RFC-237 的 root 部署事故暴露了一个结构问题：claude 运行时的执行面**按能力分代**，
不同代之间的安全姿态差距很大，而差距本身没有被显式建模——只散落在注释里。
2026-07-31 的收口盘点（`docs/audit-backlog.md` §运行时/沙箱能力收口）确认，收口后
仍有三项**已知、有意分期**的姿态差：

| #   | 差距             | 现状                                                                                                                                      | 影响面                           |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A   | 业务节点世代差   | 不封印二进制、`--permission-mode bypassPermissions`、`...process.env` 全量继承                                                            | 所有 claude 协议的工作流业务节点 |
| B   | `all-deny` 空洞  | claude driver 接受 `all-deny` 但以 bypass 语义运行（无工具门）                                                                            | distiller / runtime smoke        |
| C   | 无平台级网络围栏 | opencode verified 对 local MCP / shell 有 no-network 子进程边界；claude 的 MCP 子进程由 CLI 自管，平台 containment 对 claude 仅文件系统级 | claude 业务节点 + MCP 试跑       |

三者的共同点：**平台对 claude 子进程的实际权限面小于我们在 opencode 上的承诺**，
且用户在 UI 上看不到这个差别（只有 intent 卡有一行 attestation 差异说明）。

RFC-237 已经证明了受控化的可行路径：`--tools` 装载裁剪 + `dontAsk` + 私有 configDir +
封印二进制 + 受控 env，且已有 `assembleClaudeEnv` / `claudeDeclaredControlArgv` 两个
单点原语可复用——本 RFC 把这套姿态推广到剩余执行面。

## 目标

1. **A：业务节点受控化**——claude 业务节点改为封印二进制 + 受控 env + 由 agent 声明
   驱动的工具门（不再无条件 `bypassPermissions`），与 intent 分支共用 §RFC-237 原语。
2. **B：`all-deny` 名实一致**——claude 上的 `all-deny` 必须真正拒绝全部工具
   （`--tools ""`），或显式改名为它实际代表的语义；不允许"名字说全拒、实际全开"。
3. **C：网络围栏可声明**——为 claude 提供与 opencode 同级的**平台级**网络边界能力
   （至少：agent 声明 `network: deny` 时，claude 子进程及其 MCP 子进程不可出网），
   或在能力模型里显式声明该保证不可达并在 UI/文档标注。
4. **不牺牲可观测性**：smoke 的诊断能力（它靠实际跑通证明运行时可用）不能因收窄而变哑。

## 非目标

- 不改 opencode 侧任何执行身份机制（RFC-224/227 现状不动）。
- 不引入新的 containment provider（Linux bwrap / macOS Seatbelt 复用现状；Windows 仍待未来 provider）。
- 不改 runtime 注册表 / 能力声明模型本身（`narrowedSystemPermissionProfiles` 沿用）。
- 不做 claude 的 attestation 等价物（RFC-237 已声明为设计接受差异）。

## 用户故事

1. 管理员把工作流 agent 的 `permission.bash` 设为 `deny` 并选 claude 运行时：该节点的
   claude 子进程实际加载的工具集里没有 Bash，而不是"模型自觉不用"。
2. 管理员在 root 容器里跑平台：业务节点与 intent 一样执行封印副本，二进制被替换时
   fail-closed，而不是执行被替换的字节。
3. 管理员给 agent 声明"不可出网"：claude 节点的模型调用与其 MCP 子进程受平台边界约束，
   或 UI 明确告知该运行时下此声明不生效（而不是静默不生效）。
4. 运维排障 smoke 失败：仍能拿到与今天同等的诊断信息（不因工具收窄而丢失失败原因）。

## 验收标准

- [ ] claude 业务节点：封印二进制 + `assembleClaudeEnv('controlled')` + 工具门由 agent
      声明推导；`bypassPermissions` 从业务路径消失（或仅在显式"无约束"声明下出现）。
- [ ] 既有 claude 业务 golden 断言随新契约更新且**语义不倒退**（不是删断言，是改成新形状）。
- [ ] `all-deny` 在 claude 上真正无工具可用（或该 profile 在 claude 上 fail-closed），
      `SYSTEM_PERMISSION_PROFILES` 文档不再记录"名实不符"。
- [ ] smoke 在新姿态下仍能区分：不可用 / 可用但协议不符 / 可用且正常。
- [ ] 网络围栏：给出可落地方案并实施，或在能力模型 + UI + docs 三处显式声明不可达。
- [ ] `docs/audit-backlog.md` 对应三条未决项转为已收口（或改写为已声明差异）。
- [ ] 四门禁全绿 + 实现门 findings 闭合。
