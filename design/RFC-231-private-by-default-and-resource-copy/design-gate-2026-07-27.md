# RFC-231 设计门（2026-07-27）

结论：**APPROVED（3 个 P1、1 个 P2 已全部折入三件套；0 open P0/P1/P2，待用户批准实施）**。

实施后注（2026-07-27）：用户已以「ok」批准，生产代码、测试与真浏览器验证均已本地完成；
实现门另见 [codex-impl-gate-2026-07-27.md](./codex-impl-gate-2026-07-27.md)。

审查由当前 Codex 会话在本地只读完成，没有调用外部子进程或委派 agent。审查逐项重读
RFC-231 三件套与 live source 的六类 ACL schema、八个 production INSERT、Fusion/host built-in
写点、Workflow/Workgroup exact revision、resource ref transaction fence、owner-scoped name、
autosave rescue copy、两个编辑器 More Dialog、created WS per-frame gate 及 RFC-099 D18/D20。

## Findings

| 级别 | 问题                                                                                                                                                                                                                                                           | 裁决 / 修正                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1   | 初稿自动名称假定源名称已满足当前 slug schema，但 `WorkflowDraftSnapshotSchema` 明确保留最长 256 字符的 grandfathered 自由格式名称；`旧流程 中文` 直接拼 `-copy` 会生成一个无法作为新资源插入的名称。                                                           | copy-name 先做确定性 ASCII slug normalize，不合法字符段变 `-`、清理边界、全空回退 `workflow`/`workgroup`，再识别 copy 后缀、截断和递增；最终复跑正式 name schema，并增加中文/空格/全非法/256→128 测试。      |
| P1   | 初稿 §3 授权顺序要求先过 visibility，但 §4 的步骤又写成“先解析 definition/读取成员再 gate”。若隐藏源的 definition 已损坏或成员异常，调用方可能得到区别于 404 的解析错误/时序 oracle。                                                                          | 原子服务顺序改为只读 ACL identity → 事务内 fresh visibility（Workflow 再过 builtin）→ 才解析 definition/读取成员/计算 hash；missing 与 invisible 始终在内容处理前同形 404。                                  |
| P1   | live `dwSaveAsWorkflow` 在异步 `assertNewRefsUsable(actor)` 后调用 `createWorkflow` 只传 `ownerUserId`，漏传 actor；最终 `assertRefsUsableInTx` 因 `actor=null` 走 system bypass，Agent ACL 在 preflight 后收紧仍可提交。只改 private 默认会把该旁路永久固化。 | RFC-231 把 actor 传播纳入创建路径统一：dynamic save 必须向 canonical service 传同一个 actor，使 owner 与最终 refs fence 绑定；新增 preflight→ACL 收紧 race test，目标 INSERT 必须原子拒绝。                  |
| P2   | 初稿 helper 只显式 stamp owner/visibility，`aclRevision=0` 仍靠 DB default，且没有写清 actor-backed service 如何防 owner 与 actor 漂移；这与“复制者必为 owner、创建 ACL 零状态”只靠调用者自觉。                                                                | private/builtin helper 都显式返回 `aclRevision:0`；copy 从 actor 直接取 owner；actor-backed canonical service 断言 owner 与 actor 一致，user route/generator 行为矩阵锁 owner/private/revision 0/no grants。 |

## 已核实的不变量

- shared ACL 闭集当前严格为 Agent、Skill、MCP、Plugin、Workflow、Workgroup；Task 已是成员制私有，
  Dynamic Workflow Space 的第七资源方案已回退，不能扩大错范围。
- 六个 canonical user INSERT 都显式写 `visibility:'public'`；Workflow YAML 与 Skill ZIP 的
  create 分支分别收敛到 `createWorkflow` / `createManagedSkillWithFiles`，所以 service 单源可以
  覆盖而无需逐 route 发明默认。
- production 另有两个直接 Workflow INSERT，均为 `builtin:true` 的 Agent/Workgroup host；
  Fusion 的 built-in create 复用 Agent/Workflow service、repair 显式写 public。built-in 白名单
  可以穷尽登记。
- SQLite 六列物理 default 当前均为 public。生产写点全部显式 stamp + writer inventory guard 后，
  为 fallback 重建六张 FK 高关联表没有额外产品收益；零 migration 不会改任何存量行。
- Workflow/Workgroup exact revision 都有 version + canonical snapshotHash；编辑器
  `ensureSaved()` 已提供这两个成员，copy request 无需信任客户端回传内容。
- `assertRefsUsableInTx` 能在同步 transaction 内读取当前 row/grants；副本是全新资源，因此传全部
  refs 而非 D15 diff 是正确极性。
- Workgroup editable snapshot 已排除 member DB id，可在保留顺序、displayName、roleDesc、
  agentId/userId 与 leaderDisplayName 的同时重新生成全部 member id。
- `workflows` 允许业务重名，但 `workgroups_owner_name_unique` 强制 owner-scoped 唯一；两者都可在
  单 daemon 的同步 transaction 内用同一 occupied-name helper 生成稳定自动名称。
- `/ws/workflows` 与 `/ws/workgroups` 对 created/updated frame 都会在 commit 后按目标 row 重新跑
  visibility；private default 不需要扩充帧 payload，但必须新增 stranger 不收帧的回归。
- 正常 copy 与 conflict/inaccessible/deleted 的 save-copy 消费不同事实：前者是 exact server
  revision，后者是冻结本地草稿；保留两条路径才能不丢失救援能力。

## 范围裁决

- RFC-231 supersede RFC-099 D18/D20 中“其它资源默认 public”，不改“缺 visibility 按 public
  读取”的 legacy 兼容，也不改 Task 成员制私有。
- existing rows 与 backup restore 保持原 ACL；overwrite/rename/owner transfer 不是新建。
- built-in public 是显式例外；隐藏的 built-in Workflow 不允许复制成用户资源。
- normal copy 对任何可查看源的 actor 开放，目标 owner 永远是该 actor、private、零 grants；
  source owner/visibility/grants/task/run/chat/history 全部不继承。
- 本 RFC 不给 Agent/Skill/MCP/Plugin 增加 copy UI/API，也不引入复制后的自动分享。
