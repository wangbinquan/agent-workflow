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
