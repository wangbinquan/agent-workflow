# RFC-372 v6 轻量实现与验收

日期：2026-10-12。当前状态：生产与用例完成，集中功能验证通过；产品已提交并推送 `95ec4a8ee9698792c148d6cadf4d241db73474d9`，推送后本地与 `origin/main` 精确一致。精确 SHA CI 尚未通过。未部署。

## 有效范围

用户已选择「现有反问的脑图模式」，并要求删除已实现的冗余内容。设计先上库至 `39d2c7b841013a41dcb8f3d3fac4cae6cc398c7c`，随后完成全部实现和测试用例，再集中执行功能验证。旧 v5/112 项由 v6/L01～L16 替代。

- 原 `clarify` / `clarify-cross-agent` 配置可选择脑图模式及分类引导。工作流格式 v7；v1～v6 只升级格式，缺省普通问卷保持。
- 模型继续输出原问题 envelope，增加可选分类路径和父题信息；重复 ID、丢失父题、循环及错误协议拒绝受理。
- 全景与聚焦共享原问题、答案、协作草稿和确认。确认依据绑定问题与答案，修改即失效；锁定题使用已提交答案优先的事实。
- 在原反问轮次追加 1～4 道分支题，沿原 System 原生执行器和发问 run 冻结配置生成，保留上下文/分类，禁止该入口推进业务 Task。
- 请求幂等信息保存在原问题元数据，重复响应/重启后重试不重复追加。上下文变化、取消、旧标签页问题集合及在途生成均在原 Task 锁内判定。
- 工作区内完成确认后使用原继续/停止反问提交、seal、dispatch 和 TaskEngine。没有独立审阅清单或完成交付页面。
- Canvas/Worker 布局、可视区域绘制、虚拟大纲、搜索、待处理定位、折叠、全图适配；空白/空格/中键拖动，指针锚定缩放，双指松开后可继续平移。单击选中；不提供「放大此分支」或双击放大。

## 冗余删除

已删除本会话未提交的独立 Session/Revision/Snapshot 命令与 DTO、专用 HTTP/WS/配置页、Task host/entry/channel、材料版本/预算/消费、设计交付与模板回流模块和旧范围测试。保留并适配可复用的画布几何/Worker/样式，没有第二套 Task 运行链。

已发布的 `db/clarifyMindmap.ts`、`db/taskClarify.ts` 及 schema 接线删除；SQLite `0248_rfc372_light_clarify`、PostgreSQL `0024_rfc372_light_clarify` 按外键依赖顺序退役十张 companion 表，保留原 tasks、node_runs、clarify_rounds 及答案。历史 `0246/0247`、PG `0022/0023` 不改写。历史逻辑备份只沿已验证完整迁移历史跳过退役表，其他行与原 artifact 校验保持，进度分母同步排除被跳过的 chunk。

共享 schema 中包含 RFC-371 并发观测投影表和配套触发器，完整保留。其后续 SQLite 迁移为 `0249_rfc371_incremental_observation`，对应 PG `0025_rfc371_observation_indexes`。这些是共享文件的并发产出，不属于脑图产品需求扩张。

## L01～L16 对照

| 条目 | 实现与验证证据 |
| --- | --- |
| L01 普通问答兼容 | 原提示词缺省分支、旧 envelope、v1～v6 迁移、旧 cross HTTP 与多来源等待回归通过。 |
| L02 节点模式/冻结配置 | 两种 inspector 接线；原 node mechanics / native options 使用冻结工作流；完整 TaskEngine 八种组合通过。 |
| L03 分类/父子持久化 | shared parser → 原 round questionsJson → DTO → 单一 UI 投影，双 provider 流程通过。 |
| L04 错误结构 | shared 图合法性与协议边界用例通过，遍历为迭代实现。 |
| L05 共享状态 | React 工作区/持久化/导航回归及浏览器切换、确认、刷新恢复通过。 |
| L06 确认/全后代状态 | 内容依据、答案修改失效、聚合后折叠及 5000 节点投影用例通过。 |
| L07 草稿/锁定/集中提交 | 原 draft 写入与 DTO、已提交答案覆盖旧草稿；双 provider 与前端耐久性回归通过。 |
| L08 分支追问 | 原生生成器、祖先上下文、同类追加；SQLite/PG original-round 用例与真实浏览器追加通过。 |
| L09 幂等/过期/旧标签页 | 同请求共享结果、持久 request 元数据、重启重试、上下文 stale、旧问题集合冲突等回归通过。 |
| L10 失败/取消/提交竞态 | 取消不追加，生成中原 quick/defer/wholeRound seal 共同拒绝；错误可恢复及全体有效确认回归通过。 |
| L11 原续跑/多来源 | 实际 scheduler 原 Task 完成八案例；原多来源等待与 HTTP 双 provider 回归通过。 |
| L12 两种运行时/会话模式 | OpenCode/Claude Code × self/cross × inline/isolated 实际原生 fixture 子进程组合通过。 |
| L13 广深大图 | 5000 题、300 同级、100 层的完整投影/布局/定位用例；正式浏览器 Worker 与虚拟列表（小于 60 行 DOM）通过。 |
| L14 画布交互 | pointer/pinch/键盘/不双击缩放用例；1280/390/320px、主题与定位浏览器验证通过；实际标签绘制不碰撞回归通过。 |
| L15 清理/升级 | 原独立源文件/接线移除，SQLite 实际升级与 PG 历史重放/真实 provider 回归通过，历史 artifact 还原编排用例通过。 |
| L16 验证/交付 | 全部开发和用例完成后执行集中验证，独立功能实现检视 PASS；产品发布/远端精确 SHA CI 仍待关闭。 |

## 实际执行

测试环境：macOS arm64、Bun 1.4.0；PostgreSQL 使用本次临时 Docker 测试实例，Chromium 使用本次 Playwright 安装。原生 CLI 为 fixture，未调用付费模型，未修改真实任务。

| 范围 | 最后有效结果 | 本地证据 |
| --- | --- | --- |
| shared 模式/解析/版本兼容等 16 文件 | 140 pass / 0 fail，363 expect | `/private/tmp/rfc372-scope-v6/shared.log` |
| SQLite + PostgreSQL 原反问/原 cross 路由/多来源/升级 5 文件 | 39 pass / 0 fail，1814 expect | `/private/tmp/rfc372-scope-v6/backend-final2.log` |
| 实际 TaskEngine 八种原生组合 | 8 pass / 0 fail，84 expect | `/private/tmp/rfc372-scope-v6/engine3.log` |
| 两个正式 daemon bootstrap 的追问生成器接线 | 1 pass，另 8 个不相关测试按名称过滤 | `/private/tmp/rfc372-scope-v6/bootstrap-regression.log` |
| 前端工作区/草稿/跨轮导航/Canvas 6 文件 | 28 pass / 0 fail | `/private/tmp/rfc372-scope-v6/frontend5.log` |
| 最终标签绘制与画布几何 | 6 pass / 0 fail | `/private/tmp/rfc372-scope-v6/canvas-labels.log` |
| 最终二进制 build + smoke | exit 0 | `/private/tmp/rfc372-scope-v6/build-final.log` |
| 最终正式浏览器 2 个流程 | 2 pass，12.0s | `/private/tmp/rfc372-scope-v6/browser-final.log` |
| 前端 typecheck / 本次末次修改 lint + format | exit 0 | `frontend-typecheck4.log`、`lint-final.log`（同目录） |
| 最终迁移计划核对 | 0 new immutable files，验证通过 | `/private/tmp/rfc372-scope-v6/migration-final-verify.log` |
| 原备份布局与最终表清单 | 1 pass / 0 fail，15 expect | `/private/tmp/rfc372-scope-v6/backup-schema-final.log` |

浏览器第一条真实创建任务、停在原反问页面、作答确认、同轮追问、刷新恢复、切换视图、原停止反问提交并观察 Task 完成；主题用真实配置 API 切换。第二条通过测试拦截提供 5000 题 payload，在正式生产 UI 中验证 Worker、完整节点计数、虚拟列表与第 4999 题定位。它不证明真实模型能一次稳定输出 5000 题，也不是后端压力基准。

历史备份用例从真实历史 SQLite 生成 artifact，并运行正式恢复编排到 recording target，验证退役表不落目标、保留表行数/原字节校验与完整进度。它不冒充真实 PostgreSQL 目标端完整恢复验收；PG 正式升级和原反问数据路径另由双 provider 用例覆盖。

## 独立功能检视与残留限制

实现检视首次发现 defer seal 绕过生成中 guard、已提交祖先被旧 draft 覆盖、同挂载组件跨轮回调串状态三项，均补修复与回归后限定复核 PASS。最终 PostgreSQL bootstrap 缺失生成器接线、移动导航样式、恢复进度分母也经补修复及源码复核 PASS。检视范围仅功能正确性与回归。

整仓 `bun run typecheck` 的最后执行仍失败：观测统计并发代码涉及 `identityPacketPage` 的 sync/async 查询类型、projection worker `drain` 的联合返回类型、增量观测测试及 Bun 类型更新后的 signal/SQLite 声明。相关源文件不是本次脑图逻辑修复范围，失败依据保存在 `/private/tmp/rfc372-scope-v6/typecheck-final.log`；不删除、覆盖、代改或回退其他会话代码来制造总绿。

必要共享文件及其依赖将保留共同产出按明确路径提交，提交说明必须覆盖观测投影/迁移与 SQLite affected-row 修复。原 cold after-commit pump 等无关在制品保持，不纳入本次提交。未发送跨 session 信息。只有核对正式提交、远端同步以及对应 CI 后，才能关闭 L16 和 RFC 状态。

最终源码候选的原 RFC-294 census 生成 13 份配套；此前生成发现未消费的 `ClarifyFollowupOperations` public 导出，移除后只针对变化候选重生成。原四个 scanner 规则保持，用主检出中的候选文件及 HEAD 的非候选只读数据构成提交语料，未创建分支、worktree 或替代检出。八项一次性增长记录分别解释本次原反问追问及并发观测投影的实际分母变化；不修改守卫、字段预算或原债务退役要求。备份用例计数更新不改变 src-only census。

## 首次发布 CI 与本会话修复

`95ec4a8e` 的 [主 CI](https://github.com/wangbinquan/agent-workflow/actions/runs/38250217082) 及辅助作业在依赖安装阶段报 `lockfile had changes, but lockfile is frozen`。对照确切差分，清理时误漏 `mermaid` 和 `happy-dom` 的 workspace 引用；原 manifest、Markdown 渲染和 Vitest 仍使用它们。这两处属于本会话清理错误，已恢复引用，完整保留并发 `@types/bun` / `bun-types` 1.4.3 升级。Bun 1.4.0 `bun install --frozen-lockfile --ignore-scripts` 验证通过：782 installs / 872 packages，no changes；证据 `frozen-install-fix.log` 位于上述临时证据目录。

早期 schema 源码复核文档中的 20 个本机绝对链接已由 [设计提交 CI](https://github.com/wangbinquan/agent-workflow/actions/runs/38240845009) 的 Lychee 日志确认失败。修复为已验证存在的首次发布 commit 源码链接和仓库内相对链接；临时证据保留路径文本。保留原历史结论和指纹，不恢复已经退役的代码。

随该无生产源码变化的后继修复，按原 highwater 规则退役八条已消费的一次性增长声明，所有基线、scanner 与 src-only census 保持。冻结安装后的全仓 typecheck 仍有 82 条错误，均在并发观测统计实现/测试及既有 Bun 类型调用处，记录于 `typecheck-installed-final.log`。后继确切 SHA CI 需重新观察，不把冻结安装通过当成所有功能通过；不代修并发观测统计代码。
