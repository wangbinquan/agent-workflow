# RFC-285 — 语义统一与权限收口（proposal）

状态：Draft（2026-08-12 落档）
来源：`design/system-commons-unification-audit-2026-08-12.md` §5 决策台账
D1/D5/D6/D7/D8/D20/D21（用户已拍板方向）。本 RFC 是**行为变更批**：每一项都
在 §4 能力影响清单逐条列出用户可见变化。方向不再重议；实现中的新歧义反问用户。

## 1. 背景

审计发现一组「同一威胁模型/同一语义存在两种答案」的分叉（403/404 双轨、删除
拦截三档、stale 错误码 4+ 种、call 入口不检查 owner 失活），以及四个已登记的
权限洞与一个跨面不一致的 memory 权限模型。用户已逐条拍板统一方向。

## 2. 目标（七组行为变更）

- **B1 任务域 404 同形统一（D1）**：tasks/reviews/clarify 详情的
  `ForbiddenError('task-not-visible')` 403 改为与「不存在」同形的 404
  （对齐 taskCollab/taskQuestions 既有形态与 RFC-248 H9 反枚举论证）；
  更新 ~4 份锁定 403 的测试；前端错误文案改「不存在或无权查看」。
  taskQuestions.ts:41-44 的反向注释一并修正。
- **B2 删除引用拦截统一中档（D5）**：六类资源删除时对任务引用统一为
  「只拒**非终态**引用」——workflow 从「拒一切（含终态）」**放宽**；
  workgroup 从「不查」**收紧**；agent 维持现状。三份 scheduled 扫描已由
  RFC-284 收敛单点，本批只改判定档位；错误披露沿用 discloseRefs 形态。
- **B3 owner 失活拒启 call 子任务（D7）**：call-workflow/call-workgroup 子任务
  启动前重建 owner actor（对齐 scheduled/webhook 的 rebuild+active 检查）；
  owner 失活时 call 节点以明确错误码 `call-owner-inactive` 失败；
  `as unknown as` 伪造 Actor 改为显式 `InheritedActor` 构造器。
- **B4 query token 收窄（D8）**：`extractRawToken` 的 query 通道仅对 `/ws/*`
  升级路径生效；REST 面只收 `Authorization: Bearer`。实现前先 grep 前端/CLI/
  测试的存量 REST query-token 用法并同批迁移。
- **B5 stale 错误码归一（D6）**：`workflow-version-conflict` /
  `workgroup-version-conflict` / `skill-version-conflict` / `*-copy-stale`
  归一为 `resource-operation-stale` 族（fence **机制不动**）；前端错误处理
  与 i18n 同批适配；旧码是否保留一个版本期兼容 → 见 §5 开放项 Q1。
- **B6 四个存量权限洞（D20）**：
  ① review 评论 PATCH/DELETE 补作者校验（`row.author === actor.user.id`，
  owner/admin 旁路），DELETE 补 decided 冻结（对齐 PATCH）；
  ② `/ws/repo-imports/:batchId` 补 batch-ownership upgradeGate（发起者 + 资源
  管理员可见；RFC-152 D4 遗留）；
  ③ 导入路径 visibility 硬编码 public 改为 private（workflow.ts:54 /
  skill-zip.ts:430，对齐 RFC-231「导入归导入者 + private」默认；存量已导入行
  不回填）；
  ④ memory distill 蒸馏任务详情（候选 + LLM 会话）读门收紧为仅资源管理员
  （随 B7 模型）。
- **B7 memory 权限模型更新（D21）**：
  读面——资源 scope 随绑定资源可见性（现状）；**repo 与 global scope 从
  仅管理员放宽为全体登录用户可读**；
  管理面——随 scope 资源写权（现状）+ **资源管理员（admin+manager，
  `isResourceAdminRole`）对所有记忆全量可管**；
  distill 详情读门=仅资源管理员（后端补门，与 UI 意图对齐）；
  前端谓词漂移同批修（backlog:99：`usePermission('memory:approve')` 恒 true
  的两处改 `isResourceAdminRole` 判定，且 UI 从 admin-only 放宽为 admin+manager
  与后端一致）。

## 3. 非目标

- 不改 fence 机制（B5 只动错误码）；不做 RFC-283 范围（webhook trigger 权限
  下放是它的事）；不改任务成员制模型本体；不做资源 ACL 语义变化（仅消费）。

## 4. 能力影响清单（逐项呈批）

| #   | 变化                                                | 方向         | 影响                                                                                                                    |
| --- | --------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| E1  | 任务详情无权访问 403→404（B1）                      | 语义变化     | API 消费方无法再靠 403/404 区分「存在但无权」与「不存在」（这正是目的）；前端文案合并                                   |
| E2  | workflow 删除从拒一切任务引用放宽为只拒非终态（B2） | **能力扩张** | 只被历史（终态）任务引用的 workflow 现在可删；终态任务详情里的 workflow 链接可能悬空（展示层需容忍，与 agent 现状同型） |
| E3  | workgroup 删除从不查任务引用收紧为拒非终态（B2）    | **能力收缩** | 正被运行中任务使用的 workgroup 将不可删（此前可删并留下孤儿引用）；需现网确认无依赖此行为的运维习惯                     |
| E4  | owner 失活后 call 子任务拒启（B3）                  | **能力收缩** | 失活账户的运行中任务在 call 节点失败收场（此前静默继续）；与 scheduled/webhook 对齐                                     |
| E5  | REST 面不再接受 ?token=（B4）                       | **能力收缩** | 依赖 query token 的 curl/脚本习惯失效（须改 Bearer header）；WS 升级不受影响                                            |
| E6  | stale 错误码换族（B5）                              | wire 变化    | 依赖旧错误码字符串的外部消费方需适配（仓内前端同批改）                                                                  |
| E7  | 导入产物默认 private（B6③）                         | **行为变化** | 导入他人 bundle/zip 后资源不再自动公开；需要公开须显式改 visibility                                                     |
| E8  | distill 详情仅资源管理员（B6④/B7）                  | **能力收缩** | 普通用户 PAT 直连不再能读蒸馏会话（UI 本就不给入口）                                                                    |
| E9  | repo/global 记忆读面放开（B7）                      | **能力扩张** | 全体登录用户可读 repo/global scope 记忆（原仅管理员）；注入面不变                                                       |
| E10 | manager 获得全量记忆管理权（B7）                    | **能力扩张** | manager 可增删改审所有记忆（原仅 admin）                                                                                |

## 5. 开放项（实现前需用户拍板）

- Q1（B5）：旧 stale 错误码是否保留一个版本期的兼容映射（wire 返回新码 +
  `legacyCode` 字段），还是直接切换？（仓内消费方同批改，外部消费方未知）
- Q2（B2/E3）：workgroup 收紧前是否需要现网数据检查（是否存在正被非终态任务
  引用且用户有删除习惯的 workgroup）？

## 6. 验收标准

- AC-1 B1：任务域全部「无权」路径返回 404 且响应体与真不存在字节同形
  （oracle 消除测试：两种情况响应不可区分）；原 403 锁定测试全部改判并注明本 RFC。
- AC-2 B2：六类 × {无引用/仅终态引用/非终态引用} 删除矩阵测试；E2/E3 两向
  变化各有红→绿对。
- AC-3 B3：owner 失活 → call 节点 `call-owner-inactive` 失败 + 父任务 failed
  收场；活跃 owner 全链不变；InheritedActor 类型层无 `as unknown as`（grep 锁）。
- AC-4 B4：REST 带 ?token= 401；/ws/\* 升级照常；存量用法迁移清单归零。
- AC-5 B5：新码全链（后端产出/前端识别/i18n 双语）+ 按 Q1 决策的兼容形态测试。
- AC-6 B6①：非作者 PATCH/DELETE 403、作者/owner/admin 放行、DELETE 冻结锁；
  B6②：非发起者升级拒绝、发起者与管理员放行；B6③：导入产物 visibility=private
  断言（bundle 与 zip 两路）；B6④ 并入 AC-7。
- AC-7 B7：读面矩阵（4 scope × {普通用户/owner/manager/admin}）、管理面矩阵、
  distill 详情门、前端谓词与后端同判（两处漂移点修复 + 回归锁）。
- AC-8 每批 pin worktree gate 全绿 + exact-SHA CI 绿；实现门（独立子代理）跑过。
