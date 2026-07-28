# RFC-234 Codex 设计门记录（2026-07-28，一轮）

- 执行：codex rescue task `task-ms40bxta-ndez4g`（首次 `task-ms3zdavi-zb6pih` 僵尸
  ——pid 消失、日志/rollout 冻结在启动后 3 秒、零产出，按 dev-gotchas §Codex 判据
  cancel 后 `--fresh` 重跑成功）。Codex session `019fa672-55d3-79b2-97f8-c79efabfafc3`。
- 结论：NOT-CLEAN，6 P0 + 8 P1 + 2 P2，**16/16 全采纳**折入 design v2（修订账
  design §14；proposal D14/D19/D26/AC-7/AC-13/AC-14 同步修订）。

## 原始 findings（verbatim 摘录，含定位）

### P0
1. 可配置 runtime 使"仅 cwd 文件工具、无 Bash/网络"在 OpenCode 与 Claude Code 两端
   都不成立（design §1/§12）：`runner-filesystem-v1` 无 child/network 边界；RFC-224
   hermetic 权限尾对系统 agent 重新 deny 全部文件工具；claude driver 忽略 permission
   形状并 bypass。→ 采纳：冻结枚举 `intent-read-v1` + RFC-224 资格扩项 + runtime
   fail-closed；文件访问只读白名单，缺能力 runtime 配置期拒绝。
2. 密钥分类漏掉 MCP argv/URL 与 Plugin spec，双向脱敏可被合法字段绕过（design §4/§8）：
   `--token=…`、URL userinfo/query、plugin spec 嵌 token、options 非敏感键均可携带
   凭据进 dump/输出/快照。→ 采纳：闭集 secret-slot 投影（argv[1:] 全遮、URL 剥
   userinfo+query、spec 走 redactGitUrl、options 字符串值全遮）+ 入向凭据模式扫描 +
   waiver + 物化/错误/诊断统一遮蔽。
3. OCC 没有绑定"用户实际确认的草稿"，旧轮或旧页面可提交另一份变更集（design §2/§6/§7）。
   → 采纳：context_revision 单调 epoch + 不可变 intent_drafts(draft_hash) + commit
   CAS(draftRevision+draftHash+epoch+无 in-flight) + 晚到轮归档不上位。
4. "生成副本"没有被明确当作全新资源复核全部引用，可能复制出未授权能力（design §9）。
   → 采纳：copy 规范化为 create，物化后全部直接引用/依赖闭包/human 成员全量复验，
   无 grandfather（对齐 RFC-231 copy 先例）。
5. 现有 Skill 2PC 与插件 GC 不是整包提交协议，崩溃后无法维持"全部终态可见或全部
   不可见"（design §9）。→ 采纳：intent_apply_journal（prepared/applying/committed/
   failed + prepared_artifacts + receipt），boot/GC 按 bundle 收敛，committed 后
   skill live 树 roll-forward 幂等发布；插件"先记后装"。
6. `clientMutationId` 没有持久 claim 或唯一约束，响应丢失会重复创建整包资源
   （design §2/§6/§9）。→ 采纳：journal UNIQUE(session_id, client_mutation_id) 绑
   draft_hash，重复请求幂等返回原 receipt/error（对齐 RFC-101 fusion decision claim
   先例）。

### P1
1. 模型侧身份协议自相矛盾（update 要 raw resourceId 但 serializer 不输出；歧义要
   ownerUsername 但 username 禁入 prompt；update→copy 无 resultRef）。→ 采纳：统一
   会话内不透明句柄 `res#type#n`（对齐 RFC-167 member#N），弃 raw id/ownerUsername；
   重接线锚定 opId。
2. 自动依赖闭包可被修改却没有逐资源 OCC 基线。→ 采纳：context_manifest 覆盖全部
   实际 dump 资源（handle/id/fence/dumpHash），rebase 原子重建整闭包。
3. commit 的 finalName/secret/humanBinding 覆盖层没有闭集 schema 与最终复验点。→
   采纳：服务端签发槽位 (opId, slotId, jsonPointer, kind)，覆盖后重物化+全量
   schema/validator 复验+final hash 与确认页一致。
4. `requests` 把不可信模型输出变成自动扩大数据披露的授权。→ 采纳：申请只生成待
   批准建议，使用者逐项批准后才入下轮 dump；无自动挂载（D19 收紧）。
5. 多轮重放既丢失旧草稿，又未定义提交后的新上下文起点。→ 采纳：intent_drafts 不可
   变 revision（可恢复历史版）；提交成功关闭 epoch：归档已应用草稿、清空 current、
   原子重建 manifest、注入 post-commit 摘要。
6. 合法 changeset 最大可超协议硬上限两倍；历史无输入预算。→ 采纳：schema 尺寸不
   变量（files≤32×128KiB、总≤2MiB）< 传输上限（stdout cap 提至 8MiB 对齐解析
   上限）；输入侧确定性压缩（近 8 轮逐字+更早结构化一行+答案永不压缩）+ golden。
7. 临时目录清理合同前后矛盾，失败运行可能长期遗留私有 dump。→ 采纳：app-home
   `intent-scratch/{turnId}` + turn 记 scratch_retained + boot/每小时 GC（默认
   24h 保留期可配）；distiller/smoke 现状不变。
8. 会话审计权限从"管理员"悄然扩大到所有 manager（resource-admin=admin∪manager）。
   → 采纳：收敛为 `isAdminActor` 仅系统 admin；manager 404 同形 + 边界测试。

### P2
1. nonce 声称"存 turn 行"但 schema 无对应列。→ 采纳：`intent_turns.envelope_nonce`
   spawn 前同事务持久；重试=新 turn+新 nonce。
2. 测试计划避开最危险的真实 runtime、崩溃与并发路径。→ 采纳：§13 新增六组盲区
   （真实 runtime 资格实测/五断点崩溃矩阵/重放与双标签/copy-ACL/密钥闭集/注入
   演练），plan T13 落任务。
