# RFC-170 · 任务分解

状态：Draft（待独立走完设计门 + 用户批准后实现）。本仓 main 直推，每批自带测试、过全量门禁（typecheck/lint/test/format:check/frontend vitest/build:binary 冒烟 + migration 后 `upgrade-rolling` 计数锁 bump）。

> 依赖关系：RFC-170 **在 RFC-169 落地之后**实施。**基线澄清**：169 的 skills 保存/读取仍是**现状 double-PUT LWW**（169 只做了 SKILL.md 守卫+探针+前端 reseed，未碰保存协议）；本 RFC 从 double-PUT 基线**新建** combined-save + 单 fenced read + 复合 token CAS，且**与快照权威 + rename 原子发布同批落地**（slim 复审第四轮定案：CAS 叠非原子发布不安全，二者不可分批）。

## 批次 A —— token 与 migration 地基（不面向消费者）

- **RFC-170-T1** migration ×1：`fusions` ADD `precondition_token TEXT` + `skills` per-skill 迁移标记列（或专表）；journal 计数锁 bump；`--> statement-breakpoint` 分隔。
- **RFC-170-T2** 复合 token 编解码纯函数（`skillId+contentVersion+metaRevision` ⇄ 不透明串）+ 单测；`metaRevision` 派生（只涵盖表单/ZIP 可写 meta）。（**T3 读接口透传移入批次 B**——F2：token detail-read 不能在快照权威生效前面向消费者。）

## 批次 B —— **快照权威 + 版本写 OCC + 运行时隔离 + 分叉前置门（可独立部署的安全单元）**

> **F2 定案：批次 B 必须自成一个安全部署单元**——新写协议/token 读、运行时 quarantine 终检、存量分叉 fail-closed 前置门都必须在此批同时生效，否则独立部署 A/B 会返回「带 token 的残缺内容」、让 quarantined skill 继续被任务注入、或在完整迁移 UI 到来前静默覆盖存量分叉。完整迁移决策 **UI** 可后置（批次 C），但**读写路由 / 恢复覆盖 / runtime staging 在全部保护生效前一律不可达**；每批次可部署测试。
- **RFC-170-T7**（先落）发布改临时目录 + rename 原子换入（跨 OS 两步交换）；`commitSkillVersion` 重写为快照权威 + 在线失败即修即隔离 + 启动恢复从快照重建 + degraded 隔离拒写；**存量分叉 fail-closed 前置门**（未迁移 + live≠快照 → 读返回快照/不签 token、写拒绝、恢复绝不覆盖 existing-but-different live——现 `skillVersion.ts:527-534` 拒覆盖行为对此收紧为显式 pending 态）；崩溃/kill-restart 注入测试。
- **RFC-170-T3**（依赖 T7）读接口回带复合 token（combined detail-read + file/tree GET）+ double-read fence + 前端透传；**token 读在 T7 保护生效前不面向消费者**。
- **RFC-170-T4**（依赖 T7）**从 double-PUT 基线新建 combined-save**（单请求 + 单 fenced detail-read + `loadVisibleSkill`+`requireResourceOwner` + wire 契约 409/422 提交前/5xx 提交不确定）+ file PUT / file DELETE / restore 换复合 token 校验、`commitSkillVersion` 回带新 token、最终事务内重读 ACL；**端点在 T7 保护生效前不可达**。
- **RFC-170-T5** ZIP overwrite 纳为版本写（依赖 T7）。
- **RFC-170-T6** fusion 审批：发起持久化 token、批准同事务 CAS + legacy row fail-closed（依赖 T7）。
- **RFC-170-T9**（同批）quarantine 双检查点：pre-spawn 解析层 + skillId/generation 随 ResolvedSkill 传 stageSkills 终检（含 Claude 路径）；两 runtime 拒注入测试——**运行时隔离必须与写协议同批，否则 quarantined skill 仍被注入**。

## 批次 C —— 存量迁移决策 UI + replace + source + ACL + 创建

- **RFC-170-T10** 存量分叉**完整迁移决策**（多代候选无条件捕获/隔离快照/journal/各 phase kill-restart + 前端待迁移 UI 二选一）——**在批次 B 的 fail-closed 前置门之上**补完整决策流。
- **RFC-170-T11** conflict-replace 可回滚交换 + replace journal + replacing 世代互斥（一切最终提交检查）。
- **RFC-170-T12** 资源级 DELETE + source 生命周期（reconcileSource user/system 拆分、逐 child ACL、actorless 仅 owner=registrar 目录消失）+ 创建 name reservation。
- **RFC-170-T13** ACL PUT `aclRevision` 六资源 CAS（共享 resourceAcl 服务）+ realpath/inode SKILL.md 兜底。

## 批次 E —— 收尾

- **RFC-170-T14** 封闭 mutation inventory 源码锁 + 全量测试矩阵㉖–㊲ 逐条 + grep 复核。
- **RFC-170-T15** 归档：`design/plan.md` 索引置 Done、`STATE.md` 已完成表加行。

## 验收清单（对 proposal §5 逐条）

- [ ] 复合 token 全链（ABA/仅元数据/缺 token/连续保存）
- [ ] 6+6 封闭 inventory + 全写入口 ACL 屏障
- [ ] 快照权威 + 崩溃恢复 + 各 phase kill/restart
- [ ] quarantine 全链（含运行时注入两 runtime）
- [ ] 存量升级不丢 + 多代候选 + 逐字节一致
- [ ] source 生命周期 ACL
- [ ] ACL aclRevision 六资源
- [ ] 创建 reservation
- [ ] migration ×1 + journal 锁 bump + 门禁绿
