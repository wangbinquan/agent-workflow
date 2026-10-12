# RFC-372 v6 完成审计与剩余发布条件

日期：2026-10-13。范围沿用用户批准的 v6/L01～L16；旧 v5/112 项已被明确替换，不重新纳入，也不记为完成。

本次从当前主检出、保留数据库、实际输出、原验证日志、独立检视原始消息及远端祖先关系复核。**L01～L15 的实现和本地功能验收成立，完整任务与 System Mock 固化已上库。L16 的本地验收、检视、提交同步和终态 CI 记录已完成；全仓质量门仍未通过，RFC 继续 In Progress。**

## 逐项合同与证据

| 条目                         | 当前实现与可复查证据                                                                                                                                                                                                                                                                                                    | 审计结论                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| L01 普通问答兼容             | [普通协议与提示词回归](../../packages/shared/tests/rfc372-light-clarify.test.ts) 检查未配置脑图时的原提示词、旧问题和不要求确认的原提交；shared 本地 140 pass、双 provider 原路由回归通过。                                                                                                                             | 实现及功能验证完成                 |
| L02 self/cross 模式及冻结    | [原节点配置](../../packages/frontend/src/components/canvas/inspector/ClarifyModeEdit.tsx)、[v7/旧版本兼容](../../packages/shared/tests/rfc372-workflow-mode.test.ts)、[真实 TaskEngine](../../packages/backend/tests/rfc372-task-engine.test.ts)。保留任务的两个冻结节点均为 mindmap，并保存预置方向。                  | 完成                               |
| L03 元数据端到端             | [原协议解析](../../packages/shared/src/schemas/clarifyMindmap.ts)、[原轮次读写](../../packages/backend/src/modules/collaboration/infrastructure/clarifyFollowupStore.ts)、[单一工作区](../../packages/frontend/src/components/clarify/mindmap/MindmapWorkspace.tsx)。实际已完成轮次保存分类、父题、追加请求依据及答案。 | 完成                               |
| L04 错误结构                 | [共享协议回归](../../packages/shared/tests/rfc372-light-clarify.test.ts) 覆盖缺失父题、重复 ID、循环、缺失元数据；完整任务实际断言非法模型输出返回 422 且不追加。                                                                                                                                                       | 完成                               |
| L05 双视图/刷新              | [原详情页](../../packages/frontend/src/routes/clarify.detail.tsx)、[工作区回归](../../packages/frontend/tests/rfc372-workspace.test.tsx)、[完整旅程](../../e2e/rfc372-mindmap-journey.spec.ts)。切换视图、保存草稿、刷新后确认均使用同一原问答。                                                                        | 完成                               |
| L06 确认和全量状态           | [确认依据](../../packages/shared/src/clarifyMindmap.ts)、[投影及耐久性回归](../../packages/frontend/tests/rfc372-projection-durability.test.ts)。修改回答令确认失效；折叠后仍统计全部后代；实际最终 9 个答案均有确认依据。                                                                                              | 完成                               |
| L07 原草稿、锁定题及集中提交 | [双 provider 原轮次回归](../../packages/backend/tests/rfc372-light-clarify.test.ts) 检查已封存祖先以最终答案覆盖旧草稿，并检查集中路径及快捷路径共享原 seal。                                                                                                                                                           | 完成                               |
| L08 分支上下文与业务边界     | [原生成操作](../../packages/backend/src/modules/collaboration/application/clarifyFollowup.ts)、[原生生成适配器](../../packages/backend/src/modules/task-execution/composition/clarifyFollowupGenerator.ts)。实际 self/cross 在同一轮追加，祖先答案与分类进入提示词，业务只在原提交后续跑。                              | 完成                               |
| L09 幂等、过期与旧标签页     | [原轮次回归](../../packages/backend/tests/rfc372-light-clarify.test.ts) 覆盖同请求重放、持久请求依据、祖先修改及迟到响应拒绝、已追加后旧问题集合提交冲突。                                                                                                                                                              | 完成                               |
| L10 失败、取消与提交竞态     | 同一双 provider 回归与[请求归属回归](../../packages/frontend/tests/rfc372-followup-navigation.test.tsx)；实际旅程检查原生取消返回 409、问题数不变、非法输出后的重试及两层深入。                                                                                                                                         | 完成                               |
| L11 原续跑和多来源           | [TaskEngine 回归](../../packages/backend/tests/rfc372-task-engine.test.ts) 与原多来源等待、cross HTTP/MCP 回归。本地完整任务的 self/cross 两轮都为 answered，Task 为 done，最终输出来自原运行记录。                                                                                                                     | 完成                               |
| L12 两种 runtime/会话        | TaskEngine 实际执行 OpenCode/Claude Code × self/cross × inline/isolated 八种组合，两套正式 bootstrap 另验接线。原生进程使用 fixture CLI，不代表真实模型质量验收。                                                                                                                                                       | 完成                               |
| L13 广深大图                 | [5000 题完整投影/布局回归](../../packages/frontend/tests/rfc372-projection-durability.test.ts)、[正式浏览器大图](../../e2e/rfc372-mindmap.spec.ts)。覆盖 300 同级、100 层、全量计数、Worker、定位和虚拟列表；大图由展示 fixture 提供，不冒充后端 5000 题压力验证。                                                      | 完成                               |
| L14 画布交互                 | [Canvas 行为回归](../../packages/frontend/tests/rfc372-mindmap-canvas.test.tsx)、[交互几何回归](../../packages/frontend/src/features/clarify/__tests__/mindmap-interaction.test.ts)、正式浏览器 1280/390/320px 和主题验证。取消分支放大及双击缩放，保持编辑期间视口稳定。                                               | 完成                               |
| L15 冗余与升级               | 原 87 个扩大实现文件中的 86 个当前不存在，剩余同名工作区已以轻量问答投影重写；保留任务数据库无十张退役 companion 表。[SQLite/PG 升级和旧备份编排回归](../../packages/backend/tests/rfc372-task-schema.test.ts) 通过；真实 PG 升级/恢复边界 7 pass。历史迁移未改写，记录型目标不冒充真实 PG 完整恢复验收。               | 完成                               |
| L16 验证、独立检视与发布     | 先完成开发及用例，再集中验证；独立源码检视发现的功能问题已有修复及限定 PASS。设计先发布，产品与完整旅程已推送，最终源码修正为 `304c4108c`，远端可达；对应 CI 已终态并逐项归因。                                                                                                                                         | 功能交付记录完成；全仓 CI 门未通过 |

## 当前源码与原验证的一致性

当前审核的 64 份脑图相关共享、前端、collaboration、fixture 和 System Mock 文件逐字节等于已验证的 `304c4108c`。本轮没有修改生产代码或测试体，也没有因他人的 HEAD 前进重复全量本地 gate。

历史审阅报告的四份不可变迁移与原 `134603ad` 字节相等，因此使用仓内链接；其他六份已变更或退役源码使用固定该提交的原文链接，逐份下载与 Git 原文比对。仅修复链接访问方式，原审阅结论、范围、字节数和 SHA-256 不变。

独立检视原始结果来自已有 `/root/rfc372_design_review` 消息：2026-10-12 12:02 UTC 关闭 seal/锁定祖先/跨轮请求三项；12:15 UTC 关闭 PG 接线、响应式样式与恢复分母三项；13:28 UTC 兼容性修正 PASS；13:48 UTC 完整旅程、System Mock 动态答案与取消转换 PASS。本轮从原始消息重新取证，未发起新审阅或跨 session 消息。

## 实际保留任务

只读查询本地保留数据库再次确认：任务 `01M4R5XY9X39Q89X0PF13R8Y83` 为 done，无 error；self 6 题、cross 3 题，均 answered，全部答案有 confirmedBasis；self 最深两层追问、cross 一层。保留文档为 1268 字节，SHA-256 `64ee90853f4f728cc7763e13799527e8249c5f60b0fc4cdc13a7936f753e2a57`，与实际最终输出逐字一致。

标准集合通过 [完整旅程 spec](../../e2e/rfc372-mindmap-journey.spec.ts) 和 [System Mock 场景](../../packages/system-mocks/src/runtime/mindmapDesignScenario.ts) 固化。模型进程被替代，API、数据库、浏览器和 TaskEngine 真实执行。本地完整旅程 1 pass / 21.7s，最终源码 CI 三平台各三条脑图 E2E 全部通过；每个平台另有 11 项脑图前端回归通过。

完整本地原日志、上述只读任务证明、源码连续性、冗余清理核对及独立检视原消息保留在 `.agent-workflow/rfc372-acceptance-20261012-final/evidence/completion-audit/`；不将本地凭据或数据库上传。

## 剩余全仓发布条件

最终源码 [304c4108c 的 CI](https://github.com/wangbinquan/agent-workflow/actions/runs/38266097678) 已终态 failure：72 个 job，22 success / 50 failure。脑图专项、provider-pair、依赖方向和公共接口检查通过。运行观测的格式/数值/缓存/路由/WS/SQL 清单及原入口断言失败保留归因；Windows wrapper 超时仍未定因。格式失败导致后续 lint、depcheck、typecheck、shared/System Mock 单测跳过，不能计为通过。

历史源码页面 HTTP 503 经单项重试仍发生，本次改为字节相同的本地或固定提交原文链接，随后只按新文档提交的精确 CI 核验。其他 session 的生产修改和失败未代修、未撤掉、未回退。**整体流水线未绿、未定因失败未闭合前，保持 RFC In Progress；不能用脑图专项通过代签全仓门。**
