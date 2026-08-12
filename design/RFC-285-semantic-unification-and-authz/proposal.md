# RFC-285 — 语义统一与权限收口（proposal）

状态：Draft v2（2026-08-12 落档；同日双路独立设计门大修——**v1 的 B6①③ 与 B7 建立在
过期 backlog 之上，实测代码已先于账本达到目标态**，本版按 HEAD 实测现状重写，
详见 §7 设计门记录）。
来源：`design/system-commons-unification-audit-2026-08-12.md` §5 决策台账
D1/D5/D6/D7/D8/D20/D21。方向不再重议；**§5 开放项 Q1-Q7 须用户拍板后才能实现对应批次**。

## 1. 背景

审计发现「同一语义两种答案」的分叉与若干权限洞。设计门逐锚核实后，工作量重新
定界：D20/D21 的一部分目标态**已经在代码里**（backlog 过期），这部分降级为
「回归锁定」；真实的行为变更集缩小并精确化如下。

## 2. 目标

- **B1 任务域 404 同形统一（D1）**：把「存在但无权」的 403 全部改为与「不存在」
  同形的 404。**触点全集**（设计门扩面，不止初稿三处）：
  `routes/tasks.ts` visibilityCheck、`routes/reviews.ts:105-106`、
  `routes/clarify.ts:111-112`、`routes/worktree-files.ts:57-71`、
  `routes/port-artifacts.ts:61-72`、`routes/taskFeedback.ts:76`，以及
  `rg "task-not-visible"` 全量核出的其余产出点。
  **边界钉死**：只统一「可见性判定」（canViewTask 失败→404）；**成员制写门 403
  保留**（可见非成员的写操作仍 403，加反例断言）。WS 面已同形（rfc152 锁定），
  明示不动。连带面：`rfc193-port-artifacts-api.test.ts:265` 源码文本锁、前端
  `lib/clarify/durability.ts:310` 的 `status===403` 停写分支（403→404 后须改判，
  否则被撤权协作者的草稿同步从「干净停写」变「无限重试」）、后端测试改判 ≥8 文件
  - 前端 2 文件（如实计数，初稿 ~4 份低估）。
- **B2 删除任务引用统一中档（D5）**：目标不变（只拒非终态引用；workflow 放宽、
  workgroup 收紧、agent 现状即中档）。**设计门必要补强**：workflow 放宽**撞外键**
  ——`tasks.workflow_id` 是 NOT NULL 硬 FK（schema.ts:892-894）且生产
  `PRAGMA foreign_keys=ON`，应用层放行后 DELETE 直接 SQLITE_CONSTRAINT 500。
  故 B2 含一个 **schema 迁移**：`tasks.workflow_id` FK 软链化（对齐
  `tasks.workgroupId` 的 "durable soft link, no FK" 先例，schema.ts:1004），
  终态任务详情容忍悬空 workflow 引用（展示层与 agent 现状同型）。
  错误披露**保持聚合 count**（沿 workflow.ts:689-694 的 task-ACL 论证——
  不能把他人任务的 id/status 披露给资源 owner），初稿「沿用 discloseRefs 形态」
  仅适用于 scheduled 引用。
- **B3 owner 失活拒启 call 子任务（D7）**：显式 `buildInheritedActor` 取代
  `as unknown as` 伪造。**三臂矩阵**（设计门扩面）：新启 call-workflow
  （scheduler.ts:3867-3870）、新启 call-workgroup（scheduler.ts:4043 起的
  `startWorkgroupTaskFromFrozen` 臂，无伪造 actor、需另行接检查）、
  resume 臂（scheduler.ts:3373 `resumeTask(db, childTaskId, …)` 现不经 owner
  检查）——resume 是否同检见 **Q6**；`ownerUserId` 为 NULL 的 legacy 任务现走
  `?? '__system__'` 放行——归宿见 **Q5**。
- **B4 query token 收窄（D8）**：`auth/session.ts:257-265` 与**第二读点**
  `routes/auth.ts:476-483`（本地 extractRawToken，设计门抓出）双双收编为
  `extractBearerToken`（REST）/`extractUpgradeToken`（仅 /ws/\*）两显式入口。
  存量核实干净：前端 REST 全 Bearer、e2e 全 Bearer、bootstrap token 不打 REST、
  前端 WS 靠 URL token（保留正确）。
- **B5 stale 错误码归一（D6）**：产出点改 `resource-operation-stale`（附
  `resource` 字段）。**消费面补全**（设计门）：不止前端——后端
  `skill-zip.ts:678-686`（`skill-version-conflict` 分支决定 overwrite outcome）、
  `services/fusion.ts:1442-1447`、前端 `useWorkgroupAutosave.ts:497`
  （RFC-225 冲突恢复状态机）都要同批改。族外两点需拍板：
  `repo-group-version-conflict`（六类之外）与衍生码 `skill-overwrite-stale`
  是否入族见 **Q7**；与 RFC-283 在途新增的 webhook fence 码协调（若其新码
  不入族，归一完又出新方言）。旧码兼容期见 **Q1**。
- **B6 存量洞（按实测现状重定界）**：
  ① review 评论：**只补作者校验**（PATCH/DELETE 均缺 actor 参数——这半边成立）；
  「DELETE 补 decided 冻结」是 v1 虚项——update/delete 现状已对称冻结
  （review.ts:1959-1964 / :2025-2030），降级为回归锁。历史行 `author` 为
  LOCAL_DECIDER 兜底值（:1890）的比对语义：**兜底值行按 owner/admin-only 处理**
  （无法归属作者的行不给「作者」通道）。
  ② /ws/repo-imports：**先建 ownership 再上 gate**——`repo_import_batches` 表
  不存在（v1 锚点失实），批次是内存 `BatchRecord` Map（repoBatchImport.ts:66-81）
  且无 owner 字段。设计改为：BatchRecord 增 `ownerUserId` + 路由（cached-repos.ts:140）
  传 actor + ws spec 加 upgradeGate（发起者 ∨ 资源管理员；缺行 404 同形）。
  ③ 导入 visibility：**v1 目标态已被 RFC-231 实现**（skill-zip.ts:198,327 与
  workflow create 均走 initialPrivateResourceAcl；两处 v1 锚均脱靶）——降级为
  三路回归锁（yaml/zip/bundle）+ backlog 过期条销账。~~E7~~ 撤。
  ④ distill 详情门：**真洞成立**——`routes/memoryDistillJobs.ts:31,104,120`
  gate 仅 `memory:read`（文件头注释自称 admin-baseline 是过期注释）。收紧为
  RouteMeta `identity:'resource-admin'`（registry.ts:212 既有档）。
- **B7 memory 权限模型（按实测现状重定界）**：**后端读面与管理面已是 D21 目标态**
  ——`canViewMemory`（memory.ts:740-755）repo/global 已全员放行；
  `canManageMemory`（:764-782）首行 `isResourceAdminActor`（=admin+manager）
  已全量放行。~~E9/E10~~ 撤，改为**现状矩阵回归锁**（防将来漂移）。
  真 delta 三项：B6④ distill 门；**前端收窄修正**——`useIsAdmin()`（admin-only）
  在 memory.tsx:85 / memory.distill-jobs.$jobId.tsx:47 两点**窄于后端**，改
  admin+manager 谓词（新 `useIsResourceAdmin` hook；v1 所引三锚与
  「usePermission('memory:approve') 恒 true」均已失效——backlog:99 过期，
  真问题方向相反）；**文档修正**——CLAUDE.md「repo/global 仍 admin」过期句、
  memoryDistillJobs.ts:7-8 过期注释随本批更正。
  新暴露两题需拍板：repo_group scope 档位（**Q3**）、candidate 未审蒸馏产物
  现全员可读含 body 与 B6④ 威胁模型的矛盾（**Q4**）。

## 3. 非目标

不改 fence 机制；不碰 RFC-283 范围（其 webhook 路由文件全程不动）；不改任务
成员制模型本体；不动 memory 注入面（memoryInject）。

## 4. 能力影响清单（v2，逐项呈批；~~删除线~~=v1 虚项已撤）

| #       | 变化                                                                                   | 方向                 | 影响                                                                                                                         |
| ------- | -------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1      | 任务域「存在但无权」403→404（触点全集含 worktree-files/port-artifacts/taskFeedback）   | 语义变化             | 消费方无法靠错误码探测任务存在性（即目的）；成员门 403 保留；durability 停写分支同批改判                                     |
| E2      | workflow 删除放宽为只拒非终态 + **`tasks.workflow_id` FK 软链化 schema 迁移**          | 能力扩张+schema 变更 | 仅被历史任务引用的 workflow 可删；终态任务详情 workflow 链接可悬空（与 workgroup/agent 同型）；迁移含 12-step rebuild 风险面 |
| E3      | workgroup 删除收紧为拒非终态引用                                                       | 能力收缩             | 正被运行中任务使用的 workgroup 不可删（此前可删留孤儿）；Q2 现网检查先行                                                     |
| E4      | owner 失活后 call 子任务拒启（两条新启臂；resume 臂与 NULL-owner 按 Q5/Q6 裁决后并入） | 能力收缩             | 失活账户运行中任务在 call 节点失败收场（`call-owner-inactive`）                                                              |
| E5      | REST 面不再接受 ?token=（含 routes/auth.ts 第二读点）                                  | 能力收缩             | query-token 的 curl 习惯失效；WS 升级不受影响；存量核实零仓内依赖                                                            |
| E6      | stale 错误码换族（后端+前端消费面全改）                                                | wire 变化            | 外部消费方需适配；Q1 决定兼容期形态                                                                                          |
| E8      | distill 蒸馏详情读门 memory:read → 资源管理员（admin+manager）                         | 能力收缩             | 普通用户 PAT 直连不再能读蒸馏会话（UI 本就不给入口）；与后端管理面模型对齐                                                   |
| E11     | 前端 memory 管理入口从 admin-only 放宽为 admin+manager（对齐后端现状）                 | UI 能力扩张          | manager 在 UI 看到记忆管理入口（后端权限早已允许，纯 UI 对齐）                                                               |
| ~~E7~~  | ~~导入产物默认 private~~                                                               | —                    | v1 虚项：RFC-231 已实现，降级为回归锁                                                                                        |
| ~~E9~~  | ~~repo/global 读面放开~~                                                               | —                    | v1 虚项：现状已全员可读，降级为回归锁                                                                                        |
| ~~E10~~ | ~~manager 获得记忆管理权~~                                                             | —                    | v1 虚项：isResourceAdminActor 已含 manager，降级为回归锁                                                                     |
| E12     | candidate 状态记忆读面收紧为仅资源管理员（Q4 拍板）                                    | 能力收缩             | 普通用户不再能看到待审蒸馏候选（含 body）；人审发布后进入全员读面；与 E8 同一威胁模型                                        |

## 5. 开放项拍板记录（2026-08-12 用户逐条裁决，实现按此执行）

- **Q1+Q7（B5）→ 直接切换，族外码一并入族**：不留 legacyCode 兼容层（仓内消费方
  同批全改、外部消费方走 release note）；`repo-group-version-conflict` 与衍生码
  `skill-overwrite-stale` 也归一进 `resource-operation-stale` 族——彻底一次换到位，
  不留新方言（能力影响：E6 覆盖面相应扩大到 repo-group 面，实现时补进对照表）。
- **Q2（B2/E3）→ 收紧前由实现 session 直接做现网只读检查**（daemon DB 查询是否
  存在被非终态任务引用的 workgroup），结果记入 T5 实施记录；无需再询。
- **Q3（B7）→ repo_group 与 repo/global 同档全员可读**（锁定 RFC-248 AC-29 现状）；
  回归矩阵按五 scope 全覆盖。
- **Q4（B7）→ candidate 读面同步收紧为仅资源管理员（admin+manager）**：candidate
  状态记忆（含 body）人审发布后才进全员读面——与 E8 同一威胁模型自洽。
  **新增能力影响 E12（能力收缩）**：普通用户不再能看到待审候选（现可见）；
  routes/memories.ts list/detail 两读法对 status='candidate' 行加管理员门。
- **Q5（B3）→ 保留 `__system__` 放行**：NULL-owner legacy 任务的 call 子任务不受
  失活拒启影响（无 owner 可判失活）；注释锁定 + 回归测试。
- **Q6（B3）→ resume 豁免，只拦新启**：D7 边界=「新任务创建」；resume 重启已存在
  子任务行属既有执行延续，不做 owner 检查（注释锁定边界 + 豁免测试）。

## 6. 验收标准

- AC-1 B1：触点全集 404 且响应体与真不存在字节同形（oracle 消除测试）；
  成员门 403 反例断言；durability 分支改判 + rfc193 文本锁改判；
  测试改判清单如实列数（后端 ≥8 + 前端 2）。
- AC-2 B2：六类 × {无/仅终态/非终态引用} 删除矩阵；FK 软链化迁移前后
  外键行为红→绿对（done 引用下删除成功 + 详情容忍悬空端到端）。
- AC-3 B3：按 Q5/Q6 裁决后的臂矩阵（新启×2 + resume）逐臂测试；
  `as unknown as` grep 锁归零。
- AC-4 B4：REST（含 /api/auth/_）带 query token → 401；/ws/_ 照常；双入口文本锁。
- AC-5 B5：产出/消费对照表全改（含 skill-zip overwrite outcome、fusion、
  workgroupAutosave 状态机）；按 Q1/Q7 形态测试。
- AC-6 B6：①作者校验矩阵（作者/非作者/owner/admin/LOCAL_DECIDER 兜底行）+
  冻结回归锁；②BatchRecord ownership + upgradeGate 矩阵；③三路 private 回归锁；
  ④随 AC-7。
- AC-7 B7：现状矩阵回归锁（scope × 角色，读+管理两面，含 repo_group 按 Q3）+
  distill 门收紧 + 前端谓词两点 + candidate 按 Q4；CLAUDE.md/注释过期句修正；
  `rfc099-prompt-isolation` 复跑。
- AC-8 每批 pin worktree gate 全绿 + exact-SHA CI 绿；实现门（独立子代理）。

## 7. 设计门记录（2026-08-12，双路独立子代理）

v1 落档当日双路设计门共报 P1×4 + P2×6 + P3×3，全部核实属实并已修订入本 v2：
最重的一组是 **B6①③/B7 的现状描述过期**（review 冻结已对称、导入已 private、
memory 读/管两面已达标）——与审计报告 §4 诊断的「代码比账本新」同型，教训已
落实为本 RFC 每个 B 组实现前的「逐锚复核」第一子任务；其次 **B2 撞 FK**（v1
完全缺 schema 迁移设计）与 **B1 触点不全**（oracle 未消除）。E7/E9/E10 从能力
清单撤下；新增 Q3-Q7 五个开放项。findings 原文见审计 scratchpad 与本目录
git 历史（v1 版本）。
