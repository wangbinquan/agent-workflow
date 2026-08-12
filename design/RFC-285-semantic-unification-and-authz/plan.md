# RFC-285 — 任务分解（plan，v2）

> 前置：RFC-284 批 C 已落；**Q1-Q7（proposal §5）拍板后对应批次才可开工**；
> 每批第一子任务=逐锚复核（v1 教训）。

## 批次

- T1 前置排查落档：B4 存量 query-token 全量清单（rg `query('token')` 含
  routes/auth.ts）+ B5 stale 码产出/消费全量对照表 + B1 `task-not-visible`
  产出点全集——三份清单附录本文件。
- T2 B1 404 统一（触点全集 + oracle 消除测试 + 成员门反例 + durability/文本锁
  改判 + ≥10 测试文件改判）。
- T3 B3 InheritedActor 三臂（含 scheduled rebuild 收编三合一；Q5/Q6 裁决落地）。
- T4 B4 token 双入口（含 routes/auth.ts 第二读点收编）。
- T5 B2：schema 迁移（workflow_id FK 软链化）→ 应用层三档统一 → 披露聚合 →
  展示层悬空容忍（Q2 现网检查先行）。
- T6 B5 stale 码归一（按 T1 对照表全改；Q1/Q7 形态）。
- T7 B6①（作者校验+冻结回归锁）+ ②（BatchRecord ownership + upgradeGate）。
- T8 B6③ 三路回归锁 + backlog 导入条销账。
- T9 B7：现状矩阵回归锁 + B6④ distill 门 + 前端 useIsResourceAdmin 两点 +
  candidate（Q4）+ CLAUDE.md/注释过期句更正。
- T10 实现门（独立子代理）+ backlog 销账（review 冒名 / ws-repo-imports /
  memory 谓词过期条 / 403-404 口径 P3 条）+ STATE/索引收尾。

## 依赖

- T2/T3/T4 互独立；T5 依赖 Q2；T6 依赖 Q1/Q7；T9 依赖 Q3/Q4。
- 全程不碰 webhook 路由文件（RFC-283 在途）；B5 与 RFC-283 的新 fence 码在
  实现期对表。

## 验收清单

- [ ] AC-1…AC-8（proposal §6 v2）
- [ ] E 清单（v2：E1-E6/E8/E11）外零行为差异
- [ ] v1 虚项三处的回归锁在位（E7/E9/E10 降级产物）

## 实施记录（2026-08-13）

- **T1+T2（commit 82cd8d72）**：三份前置清单落档（B4 抓到 design 漏列的死体第三
  读点 tokenAuth）；B1 六触点 404 同形（同形基准修正为「探测面资源」的 missing
  分支：reviews→node-run-not-found / clarify→clarify-session-not-found）；
  byte-oracle 实测抓到两条真可区分性（feedback 中间件/路由分支文案不一、reviews
  初版误用 task-not-found）并修复；测试改判 15 文件 + 三处 byte-oracle。
- **T4（0a9badc3）**：REST 关 ?token=（双显式入口 + 死体 tokenAuth 删除 + 红→绿
  改判 + 边界文本锁）。
- **T3（a9d7eefe）**：buildInheritedActor 三臂单源（Q5 `__system__` 幽灵放行 /
  Q6 resume 豁免注释锁；scheduled 收编）；call-owner-inactive 新码 + i18n。
- **T6（afea367e）**：六方言码归一——实测发现 resource-operation-stale 本就是
  agent/plugin/mcp 在网家族码（RFC-201/231 先行），本批实为并族：16 方言产出点
  加 10 家族直写点全收 staleConflictError 单源（helper 附 resource 字段）；
  灭绝锁 rfc285-b5；26 处断言改判。
- **T7（93f02dd0）**：B6① 评论作者校验（矩阵 + 冻结优先序锁）+ B6②
  /ws/repo-imports 升级门（发起者 ∨ 资源管理员、缺行同形拒绝；REST 同数据面
  收紧属能力收缩未列 E 清单，登记 backlog 呈拍板）。附带 rfc222 外人删除断言
  按 B1 分层改判（T2 排查漏网）+ T3 lint 遗留。
- **T8+T9（本 commit）**：B6③ 三路 private 装配锁；B6④ 逐锚复核——**先行会话
  已修**（五端点全带 identity:'resource-admin'，头注已正，v2 所记「真洞」在
  HEAD 已不成立，降级为复核记录）；B7 现状矩阵回归锁（scope×角色×读/管理）+
  Q4 candidate 读面收紧（list 两读法过滤 + detail 同形 404 + byte-oracle +
  发布恢复用例）+ 前端 useIsResourceAdmin 两点换用（E11；role-gate 源锁改锚）。
- **T5（本 commit）**：**Q2 现网只读检查**（daemon db.sqlite，2026-08-13）——
  按 shared/lifecycle.ts 终态定义（done/failed/canceled/**interrupted**），
  被非终态任务引用的 workgroup 引用行 = **1**（awaiting_human ×1；另有
  interrupted ×7 属终态不阻删、done ×37 / failed ×14 / canceled ×2）。收紧
  影响面极小，照拍板落地。迁移 0151：tasks.workflow_id 硬 FK → soft link
  （rename-first 12-step；实证 runner 固定 foreign_keys=OFF 下 RENAME 不改写
  14 条入向 FK 的引用文本，语序安全；行数断言 + fk/quick check 全过；专属
  migration-0151 测试四锁）。应用层三档统一：workflow 只拒非终态（rfc199
  红→绿对：running 拒删 → 翻 done 删除成功 + 悬空软链实证）、workgroup 新增
  非终态门（E3 收紧，rfc285-b2 矩阵：拒删披露仅聚合 count / 仅终态可删 /
  翻终态转绿）、agent 现状即中档（源注升级：agent-in-use 挡的是 workflow
  定义引用，与任务引用是两回事）。展示层核对：task detail 只渲染冻结
  workflowId 文本；服务源 getTask 经 leftJoin 活取 workflowName（落 null）、
  前端按 nullable 分支渲染——容忍链成立（实现门路 1 P3-1 更正「无活取」
  表述并补穿透断言于 rfc199 套件）。
- **附带**：unsaved-guard ESC flaky 治本（93f02dd0 CI ubuntu 腿复发后定案——
  与数字键家族同根因：Dialog Escape 是 effect 挂的 window 原生监听；act 冲刷
  锚点修复，5×19 循环绿；backlog 销账）。
- **门禁与推送**：T1-T7 链推送 93f02dd0（exact-SHA CI 重跑 success）；
  T5/T8/T9 + 迁移契约批推送 849cfd91。
- **T10 实现门（双路独立子代理，pin 849cfd91 只读）**：路 2 判**可收工**——
  0 P1/P2，3 条 P3 全处置：b5 单源锁改跨行正则并把 mcp/applyChangeset 两处
  多行直写收编 helper；taskFeedback 头注更正；Q5 注释定界，'**system**'
  字符串臂=真身查行系有意行为，普通凭据无法伪造 owner、无越权面，补字符串
  臂测试。路 1 报 **P1-1**：849cfd91 ubuntu CI 实锤 Linux bun:sqlite 在
  FK OFF 下 RENAME 仍改写入向引用——rename-first 平台不安全，macOS 侥幸绿。
  修复与并行会话的 e2ab70be（legacy_alter_table 方案；该 commit 曾裹入本会话
  盘上半程编辑成坏杂交，未推送）**融合定稿**：官方 12-step 反序，唯一 RENAME
  只作用于零入向引用的临时名、平台无关；叠加迁移期 legacy_alter_table=ON
  双保险；新增「唯一 RENAME 源」结构锁与 legacy 不泄漏断言。P2-1（clarify
  触点零覆盖）补 byte-oracle 时又实测抓出第三条残余可区分性——detail 端点
  missing 形态是 clarify-round-not-found 带 id 文案而非 session-not-found，
  不可见分支改为逐字节镜像端点真实 missing 形态。路 1 其余 P3：详情穿透断言
  已补（rfc199）、CLAUDE.md Q4 半句已正、写门探测残留登记 backlog、AC-3
  行为臂维持文本锁兜底档（P3-6 记账）。**剩余：本批 gate+push+CI 绿后 AC-8
  才闭环；design/plan.md 索引 + STATE.md 终账仍被 RFC-293 未落档卡住。**

## T1 附录：三份前置排查清单（2026-08-13 实测 HEAD=87ed494d）

### ① B4 query-token 读点全量（rg `query('token')`/extractRawToken/extractToken）

| 读点                                                         | 面                                                                                            | 处置                                                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth/session.ts:257-265` extractRawToken（query‖header）    | REST 主链（:66 消费）                                                                         | 收窄为 `extractBearerToken`（仅 Authorization 头）                                                                                                                     |
| `routes/auth.ts:469-474` 本地同名 extractRawToken            | REST（:178/:260 消费）                                                                        | 删除本地副本、改调共享 REST 入口（设计所记 :476-483/:177/:259 为 v2 落档时行号，现漂到 :469/:178/:260，语义同）                                                        |
| `auth/token.ts:48-69` tokenAuth+extractToken（query 优先！） | **生产零消费的死导出**——`rg tokenAuth` 仅测试 `auth-token.test.ts` 引用；设计门漏列的第三读点 | **直接删除** tokenAuth/extractToken/safeEqual（删除优于 deprecate）；`ensureTokenFile`/`rotateTokenFile` 是活的 token 文件管理（cli/start.ts:568），保留；测试同批裁剪 |
| `ws/server.ts:110` searchParams.get('token')                 | WS 升级（保留正确）                                                                           | 收编为 `extractUpgradeToken` 显式入口 + 「REST 面不 import」文本锁                                                                                                     |

### ② B5 stale 码产出/消费全量对照表（rg version-conflict|copy-stale|overwrite-stale）

| 旧码                                   | 产出点                                                            | 消费点                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| skill-version-conflict                 | skillDeleteOp.ts:171 / skill.ts:443,710 / skillVersion.ts:464,525 | skill-zip.ts:679（overwrite outcome 分派）/ fusion.ts:1449 / i18n×2 / shared skill.ts:108 注释 |
| skill-overwrite-stale（Q7 入族）       | skill-zip.ts:530,542,558,579,685                                  | shared/schemas/skill.ts:243 枚举                                                               |
| workflow-version-conflict              | workflow.ts:552,588,678,758                                       | i18n×2                                                                                         |
| workflow-copy-stale                    | workflow.ts:273                                                   | 前端 workflows.edit.tsx:764                                                                    |
| workgroup-version-conflict             | workgroup/launch.ts:208 / workgroups.ts:410,465,549,569           | 前端 useWorkgroupAutosave.ts:499（RFC-225 状态机）                                             |
| workgroup-copy-stale                   | workgroups.ts:258                                                 | 前端 workgroups.detail.tsx:619                                                                 |
| repo-group-version-conflict（Q7 入族） | repoGroup.ts:568                                                  | （无专项消费；i18n 域表兜底）                                                                  |
| —（文档面）                            | resourceAcl.ts:28-30 D6 fence 选型表内嵌旧码名                    | 同批更新表格                                                                                   |

RFC-283 webhook fence 码对表：实现 T6 时 rg 一次 `webhook.*stale|webhook.*conflict` 再定。

### ③ B1 task-not-visible 产出点全集 + 改判面

- 产出点（route 面，全改 404 同形）：tasks.ts:1207 / reviews.ts:106（+:88 注释）/
  clarify.ts:112 / taskFeedback.ts:76 / worktree-files.ts:69 / port-artifacts.ts:69。
- **同形基准=各触点的「探测面资源」missing 分支**（T2 实施时修正的设计细则）：
  task 域五点同 `task-not-found`；reviews 的探测面是 nodeRunId → 同
  `node-run-not-found`（用 task-not-found 会泄露 run 存在）；clarify 的探测面是
  session → 同 `clarify-session-not-found`。
- 保留面：ws/registry.ts:541（WS 已同形，rfc152 锁定，不动）；util/errors.ts:71 doc 注释顺改；
  写门 403（requireTaskMember / ensureClarifyMember / ensureReviewMember：clarify answers、
  review decision、members PUT——rfc099-task-members 的 carol 用例是「可见成员打管理写门仍
  403」的 AC-1 反例）；rfc167 的 turn-engine resume 403 是生命周期锁，非可见性。
- 前端改判：lib/clarify/durability.ts:310——现行判据实为 `status===403 || status===409`
  （设计所记「403 停写」不全），改为 404 并入 disable 集（被撤权/被删除均停写，草稿仍留本地，
  clarify-draft-durability 新增 404 回归锁）；i18n 两键均不动（task-not-visible 仍是 WS 活码）。
- 测试改判清单（T2 实测 **15 文件**，较 rg 初扫多出两个纯状态断言的漏网）：后端
  rfc152-ws-channel-registry（锁 WS 保留面，不改）/ rfc109-sync-route ×2 /
  rfc099-membership-attribution ×3 / rfc099-task-members ×2（+carol 反例注）/
  tasks-visibility（+byte-oracle）/ worktree-files-acl（+byte-oracle）/
  rfc193-port-artifacts-api（:265 文本锁改锚：404 在场 + 旧码归零）/
  rfc212-revalidation-behavior（WS，不改）/ api-tasks-alerts-visibility ×2 /
  rfc142-review-rounds / rfc152-ws-task-channel（WS，不改）/
  routes-task-feedback（+byte-oracle；**rg 漏网**——只断状态无字面量）；
  e2e/auth-isolation.spec.ts ×2；前端 parent-task-link.test.tsx（注释改锚）/
  rfc203-l1-completeness（不改，键仍活）/ clarify-draft-durability（新增 404 例）。
