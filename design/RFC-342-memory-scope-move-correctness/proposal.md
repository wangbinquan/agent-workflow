# RFC-342 — Memory scope move 事务正确性（RFC-294 P0-A）

- 状态：In Progress（2026-08-29；本地候选已实现，待发布/hosted CI）
- 授权：用户于 2026-08-29 明确要求“开始落地剩余 P0”
- 同步基线：`69eaf95488c86c5190fd7ff1360cf272b7826979`
- 前置：RFC-041、RFC-045、RFC-099、RFC-248、RFC-294、RFC-305、RFC-324
- 范围：content PATCH 收窄、专用 Move command、可信 request authority、双 scope 授权、OCC、
  durable move receipt、commit 后 WS、现有编辑 UI 切换到 Move、竞争/rollback/注入受众测试

## 1. 问题

通用 `PATCH /api/memories/:id` 同时接受内容字段和 `scopeType/scopeId`。scope 不只是展示属性：approved memory 的
scope 决定后续 prompt 注入受众。若只在路由外检查当前行，随后直接修改 scope，会把“能改旧 scope”错误等价成“能把内容
搬进任意新 scope”；若事务内先发 `memory.updated` 再回滚，还会留下 ghost observer frame。

RFC-294 P0-A 要求把内容编辑与 scope move 分开，并使 row、当前权限、旧/新目标、状态、审计 receipt 在同一同步事务里
形成一个事实。

## 2. 目标

1. generic PATCH 只改变 `title/bodyMd/tags`，wire 与 service 双层拒绝 scope 字段。
2. 新增 `POST /api/memories/:id/move`；input 只含 `expectedVersion + destination scope`，身份来自 factory-minted
   `CommandContext.RequestAuthority`。
3. 同一 `dbTxSync` 内重读用户/权限、memory、旧 scope、新 scope、目标存在性和状态；scope update 用 memory version CAS。
4. 每次真实 move 同事务写一条不可变 `memory_scope_move_events` receipt；rollback 后 memory 与 receipt 同时不存在变化。
5. `memory.updated` 只在 transaction 返回后发布；no-op、失败与 rollback 均不发。
6. 已批准/归档的 memory 暂不原地 move；只有 candidate 可搬，之后仍须按原审批流批准才进入新注入受众。
7. 现有编辑对话框不再向 PATCH 混入 scope：candidate 调用 Move；approved/archived 明示并冻结 scope 控件。

## 3. 非目标

- 不改变 memory create/promote/archive/delete 的产品流程。
- 不重写历史 `node_runs.injected_memories_json`；历史注入快照继续冻结。
- 不给 approved/archived 增加“直接迁移受众”能力，也不在本 RFC 设计复制/再审批 UI。
- 不迁移 memory 模块到 RFC-294 W4 分层终态，不领取 W4 credit。
- 不做额外门检；只验证本 RFC 的功能、原子性、恢复和用户可见行为。

## 4. 裁决

### D1 — content PATCH 与 Move 是两个命令

`MemoryPatchRequestSchema` 保留内容字段；显式出现 `scopeType/scopeId` 即失败，不能依赖 Zod 的 unknown-key strip。
Move 使用 strict schema，额外的 Actor、permissions、role 或其它 authority snapshot 一律不是合法 input。

### D2 — Move 当前只允许 candidate

`candidate` 可在审批前纠正归属；`approved/archived` 返回 `409 memory-move-status-forbidden`。这避免同一条已生效知识在
没有重新审批的情况下改变注入受众。

### D3 — 旧 scope 与新 scope 都要可写

- agent/workflow：owner、write grant 或 `resource-acl:bypass`；目标必须存在；
- repo/repo_group/global：沿现有 memory 管理判据，仅 account 级 `resource-acl:bypass`，repo/group 目标必须存在；
- PAT 只使用 token matrix 后的权限，不能从账号角色借回 bypass。

不可见目标继续表现为 not-found；可见但不可写表现为 forbidden。旧 scope 同样检查，不能只验证 destination。

### D4 — current authority 在 writer transaction 内重建

route 只把当前认证 subject/source 交给 identity-access factory。Move 在 `dbTxSync` 中解析 opaque context，并从 `users`、
`user_permission_grants` 和 `resource_grants` 重建当前 Actor；写前再次读取，测试 seam 模拟的 grant/target drift 必须被拒绝。

### D5 — expected memory version 是唯一 OCC token

请求提交 `expectedVersion`。读时不等即 `409 resource-operation-stale`；写入使用 `(id, version)` CAS，并把 resulting version
固定为 `expected + 1`。相同 scope 是成功 no-op，不加版本、不写 receipt、不发 WS。

### D6 — durable receipt 与 scope CAS 同事务

`memory_scope_move_events` 记录 operation、memory、actor/source、前后 scope、expected/resulting version、trace refs 与时间。
它不设 user/memory FK，以便后续删除聚合或账号后仍保留事实；唯一 `(memory_id, resulting_version)` 防止一个版本对应多次 move。

### D7 — observer 在 commit 之后

transaction 只写 durable state。成功返回后才发原有 `memory.updated` frame，`changedFields` 为实际变化的
`scopeType/scopeId` 子集。frame 失败不伪装成数据库回滚；数据库失败绝不先发 ghost frame。

## 5. 能力影响

| 能力                 | 结果                                                 |
| -------------------- | ---------------------------------------------------- |
| 编辑 title/body/tags | URL 与响应保持，scope 字段从此明确 422               |
| candidate 归属纠正   | 新增 versioned Move endpoint                         |
| approved/archived    | 内容仍可按既有规则编辑；scope move 返回 409          |
| prompt 注入          | candidate 不注入；move 后批准只进入新 scope audience |
| WebSocket            | 继续使用 `memory.updated`，只在 commit 后发送        |
| 编辑对话框           | candidate scope 走 Move；非 candidate 明示冻结 scope |
| 历史注入快照         | byte-frozen，不回写                                  |

## 6. 验收标准

- **AC-1**：generic PATCH 的 route schema 和 service 都拒绝 scope 字段，row/version 不变。
- **AC-2**：Move payload 无 Actor/permission snapshot；伪造/序列化的 `CommandContext` 不能进入事务。
- **AC-3**：agent/workflow owner、read、write、foreign-public 与 manager bypass 的旧/新 scope 双矩阵成立。
- **AC-4**：repo/global 路径要求正确 bypass，PAT 不借 account bypass，destination 不存在时 fail closed。
- **AC-5**：stale version、approved、archived、目标删除、权限漂移和 memory 竞争均零 durable move。
- **AC-6**：写后 fault 同时回滚 scope/version 和 receipt，且零 `memory.updated` ghost frame。
- **AC-7**：真实 move 恰有一条 receipt 和一帧 commit 后 WS；same-scope no-op 三者均不变。
- **AC-8**：move candidate 后批准，inject loader 在旧 scope 不再看到、在新 scope 恰好看到该 memory。
- **AC-9**：migration 从 fresh/upgrade journal 可应用，schema constraints 拒绝非法 scope pair、no-op 和非 +1 version。
- **AC-10**：candidate UI scope save 先调用 Move，后续 content PATCH 不含 scope；approved/archived UI scope 不可编辑且有可见说明。
- **AC-11**：发布 SHA 的 hosted CI 终态成功后才关闭 RFC-294 P0-A。
