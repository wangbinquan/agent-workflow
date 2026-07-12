# RFC-170 · skills 存储层与 ACL 一致性加固

- 状态：Draft
- 日期：2026-07-12
- 发起：RFC-169（资源页双栏化）设计门评审第 5–16 轮持续深挖，暴露出 skills 存储层与共享 ACL 服务的一批**先于 RFC-169 就存在**的并发/一致性缺陷。这些与双栏 UI 改造无因果关系，用户 2026-07-12 拍板从 RFC-169 拆分、独立立项。

## 1. 背景

RFC-169 把 agents/skills/mcps/plugins 四页改成双栏 master-detail，带来两个新语义：**保存后留在原地**（用户会连续编辑同一资源）+ **多标签页 keep-mounted**。评审这两个语义的安全性时，Codex 对照仓库真实源码逐轮攻击，从 skills 保存路径一路挖到存储层与 ACL 服务，累计 12 轮、24 个 high/medium findings——**全部集中在 skills 文件存储与权限一致性域，且都是现存代码的缺陷**：

- `commitSkillVersion` 是「先 `rmSync(live)` 后递归 `cpSync`」（`skillVersion.ts:324-357`），无原子性——磁盘满/中途崩溃留半棵树；
- `deleteSkillFile` 只做词法判等（`skill.ts:416-438`），`./SKILL.md`/大小写别名能真删主文件（RFC-169 已修基础守卫，realpath/inode 边角留此）；
- skills 资源级 DELETE 按 name 执行、无身份前置——同名删除重建后旧页面能删掉新 owner 的资源与版本历史；
- `approveFusion` 以 `skillName+baseSkillVersion` 提交（`fusion.ts:751-766`）、不存 skillId 不复核 owner——ABA 后可写进他人新资源、错误更新 memory provenance；
- source 禁用/删除/重扫描/reconcile 按 registrar 身份删 skill 行（`skill-source.ts`），技能 owner 转移后旧 registrar 仍可删；
- `PUT /api/*/acl` 无版本 CAS（`resourceAcl.ts:259,307-328`）——过期请求可把 stale owner/grants 写回，**夺回所有权、恢复已撤销授权**，这是**全六类 ACL 资源共享的漏洞**；
- 并发 `createManagedSkill` / ZIP create 先写共享目录再插行——两窗口同见名称空闲时互相覆盖 live。

**RFC-169 slim 复审第四轮定案**：基础 `contentVersion` CAS 叠在现状非原子发布（`commitSkillVersion` DB 提交后才拷 live）上不安全——5xx/断线后重载读「新版本号 × 残缺正文」、下次 CAS 反铸更高版本永久回退内容。因此 **combined-save 单请求 + 单 fenced detail-read + 版本锁整套保存协议**不在 169、整体落在本 RFC（与快照权威 + rename 原子发布同时落地才安全）；169 的 skills 保存沿现状 double-PUT LWW（无 CAS），前端只做简单互斥+刷新重播种；**深层版本一致性（不确定提交后 content rebase、离线排队写屏障、跨页/跨窗口/A→B→A 持久版本锁）169 明确不做——它们是后端非原子双 PUT 的症状、前端堵不死，随本 RFC 的 combined read/save + 复合 token CAS + 快照权威原子发布一并根治**（本 RFC 落地后服务端版本栅栏使这些前端补偿完全不必要）。本 RFC **不引入新产品功能**，是一次存储层与 ACL 服务的正确性加固。

## 2. 目标

1. **不透明复合前置 token**：skills 读接口回带 `{skillId, contentVersion, metaRevision}` 编码的不透明 token，所有版本写必填、CAS 校验、成功回带新 token——根治同名删除重建 ABA、仅元数据变更绕过。
2. **全域乐观并发**：详情 combined-save / 文件写 / 文件删 / restore / ZIP overwrite / fusion 审批六条**版本写**，加资源 DELETE / 源冲突 replace / 迁移决策 / source 生命周期 / ACL PUT / 创建六类**身份·生命周期写**，构成**封闭 mutation inventory**；每条最终提交事务内校验 token/身份 + 重读 ACL。
3. **版本快照唯一权威**：版本快照是唯一真值源、live 目录只是可重建投影；发布用临时目录 + `rename` 原子换入；任何不一致（崩溃半棵树、在线换入失败）一律从快照重建，修不好则该技能在线 quarantine 拒读写。
4. **运行时注入隔离全链**：quarantine 不止拦 API——检查点落两 runtime 共用的 pre-spawn 技能解析层 + skillId/generation 随 ResolvedSkill 传到 `stageSkills`、在复制 live 前最后校验。
5. **存量分叉安全升级**：升级前「文件树比快照新」的技能（旧 ZIP overwrite / 手工编辑，都是合法内容）不自动覆盖——进入「待迁移决策」态，用户二选一（采纳当前文件树生成新版本 / 恢复快照），决策前无条件捕获不可变候选、多代接力，任何时点的手工编辑都不丢。
6. **source 生命周期权限**：`reconcileSource` 拆 user(actor)/system 两模式；一切用户触发的 source 操作逐 child 复核 owner/admin；system reconcile 仅「owner 未脱离 registrar 的目录客观消失」允许 actorless 删除。
7. **ACL 接口版本化 CAS**：`PUT .../acl` 必带 `expectedResourceId` + 单调 `aclRevision`，共享服务同事务比较推进——**全六类 ACL 资源同时受益**。
8. **创建并发保留**：技能创建改为 name+skillId 原子保留先行、操作专属 staging 构建、仅 reservation owner 发布。

## 3. 非目标

- 不改任何前端 UI（RFC-169 已落）；本 RFC 是后端存储/服务层加固，前端仅需在收到新 token/409/待迁移态时按既有横幅/对话框呈现（少量适配）。
- 不改产品功能语义（技能仍是技能、版本历史仍是版本历史）；改的是并发正确性。
- 不扩大到 skills 以外的资源存储（agents/mcps/plugins DB-为源，无文件树一致性问题）；唯一横向扩散是 ACL PUT 的 `aclRevision`——那是共享服务，六类资源自然一起受益。

## 4. 现存漏洞清单（逐条，均先于本 RFC）

| # | 漏洞 | 现状代码 | 根治手段 |
| --- | --- | --- | --- |
| V1 | 同名删除重建 ABA / 仅元数据绕过 | contentVersion 非世代标识 | 复合 token skillId+contentVersion+metaRevision |
| V2 | 文件写删/ZIP/fusion 无版本栅栏 | `commitSkillVersion` 调用点多不带 expectedVersion | 六条版本写统一 OCC |
| V3 | 发布无原子性、崩溃留半棵树 | `rmSync→cpSync`（skillVersion.ts:324-357） | 快照权威 + rename 原子换入 + 崩溃从快照重建 |
| V4 | quarantine 漏运行时注入 | resolveSkills 直读 managedPath | pre-spawn + stageSkills 双检查点 |
| V5 | 升级静默回滚 legacy live | 恢复器不覆盖 existing-but-different | 待迁移决策 + 多代候选 |
| V6 | conflict-replace 先删后导丢数据 | 先删 occupier 再 reconcile | replace journal + 可回滚交换 + replacing 世代互斥 |
| V7 | source 生命周期越权删 | 按 registrar 身份删 skill 行 | reconcileSource user/system 拆分 + 逐 child ACL |
| V8 | ACL PUT 过期写回夺权 | 无版本 CAS（resourceAcl.ts） | expectedResourceId + 单调 aclRevision（六资源） |
| V9 | 并发创建互相覆盖 live | 先写共享目录再插行 | name+skillId reservation + 专属 staging |
| V10 | SKILL.md 符号链接/inode 身份 | 基础 case-fold 已在 169 | realpath/inode 兜底 |

## 5. 验收标准

1. 复合 token 全链：ABA（删除重建同名）、仅元数据变更、缺失 token 三反例全被 409/400 拒；连续保存 token 逐次推进不误 409。
2. 六条版本写 + 六类身份/生命周期写构成封闭 inventory；每条「预检通过→owner transfer→提交」屏障测试证明最终事务内 ACL 重读拒绝旧 owner。
3. 快照权威：注入崩溃点（DB 提交后 rename 前 / 复制中 / cpSync 抛错）+ 各 phase kill/restart，重启从快照重建、旧 token 写 409；快照亦损→degraded 隔离。
4. quarantine 全链：重建失败后分别启动 opencode/claude 任务被拒；resolve→quarantine→stage 交错必拒。
5. 存量升级：旧 ZIP overwrite 后升级不丢内容；候选捕获后手工改 live→L1 成下代候选可最终采纳；采纳内容与预览逐字节一致；恢复候选留档。
6. source 生命周期：owner transfer 后 remove/disable/enable/rescan/replace 对无权限 child 跳过标 orphaned；system reconcile 仅目录客观消失且 owner=registrar 才删。
7. ACL：同 owner 的 grant/visibility 迟到写、transfer、删除重建 ABA、workgroup 路径全被 aclRevision CAS 拒；六类资源共享服务同断言。
8. 创建 reservation：create×create / create×ZIP / create×system-reconcile 并发只有 reservation owner 发布、输家只清自己 staging。
9. migration ×1（fusions token 列 + per-skill 迁移标记）落地、`upgrade-rolling` journal 计数锁 bump；全门禁绿。

（详细协议与 24 findings 折法见 design.md；RFC-169 设计门 R5–R16 记录整体承接为本 RFC §9 设计门记录。）
