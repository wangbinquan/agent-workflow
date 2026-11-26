# RFC-621 实施计划

依赖：RFC-620（同一批账本文件，先发布 RFC-620）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-621-T1 迁移**：`SYSTEM_USER_ID` 进 shared，令牌文件进 `platform/crypto`，旧文件删除，`auth/actor.ts` 的转出删除（design §1）。
- **RFC-621-T2 改指与账本**：读者按语法树改写；owner 表、按路径读令牌文件的锁与计数（design §1）。
- **RFC-621-T3 门与文档**：新增 RFC-621 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 W9-D 注记（design §2）。
- **RFC-621-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-621-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个旧文件不在，新位置在，没有读者取旧位置
- [x] AC-2 `SYSTEM_USER_ID` 只有 shared 一处来处
- [x] AC-3 计数 44 → 42；新增 RFC-621 用例并登记
- [ ] AC-4 exact SHA CI 全绿

## 集中验证

候选导出 = HEAD `3fc01a40a`（RFC-620）+ 只含本 RFC 的路径（76 条）；三个带着 RFC-616 未提交改动的文件（bootstrap 的 `daemonHttpComposition.ts`、
`daemonModules/digitalEmployee.ts` 与 shared 的 `index.ts`）按「HEAD + 本 RFC 的 import / 导出行」写入。

- **改写**：按语法树改写，先在对照导出上演练（58 个文件，逐个一致；没有丢掉 import 列表里的注释）；`T/users-cli.test.ts` 的动态 import 在演练中被识别出来、改取 shared。
- **静态**：backend 与 shared 的 `tsc --noEmit` 0 错；改动的 TS 文件 eslint（`--max-warnings=0`，另跑 promises 配置）0；prettier 全过。
- **用例第一轮**（shared 全部 210 个文件 2,362 条 + backend 改动路径的传递闭包与全部架构、文档读者 799 个文件）：shared 全过；backend 里 RFC-621 用例 ③ 查出
  identity-access 自己声明的三份 `SYSTEM_USER_ID`，改取 shared（design §1）；`rfc167` 一条与 RFC-619 / 620 时同样在高负载下红（时序敏感，对照导出同样红），`rfc321` 环境性。
- **用例第二轮**（三份改动的传递闭包 + 全部架构与文档读者，316 个文件）：全过。
- **架构报告**（同一 HEAD 的对照导出 vs 候选）：计数只有 `legacy-horizontal-files` 44 → 42；模块取 legacy `auth/` 的 import 边少了 21 条（改取 shared）。
- **变异**（4 / 4 被抓）：`auth/actor.ts` 重新转出（RFC-621 ③）；`auth/token.ts` 放回一跳转出（RFC-621 ①、`rfc376`）；用例经旧路径取 `SYSTEM_USER_ID`（RFC-621 ①②）；
  backend 里重新声明一份（RFC-621 ③）。每次恢复后导出干净。

## CI（AC-4）

待推送。

## 实现门（本会话自审，只审功能）

检视口径：只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

- 取值不变：shared 的 `SYSTEM_USER_ID` 与原来的 `'__system__'` 相同（RFC-621 用例 ① 断言），identity-access 删去的三份本地常量也是同一个值。
- 令牌文件逐字迁移（只加一行文件头来由），生成、读取、轮换与权限不变。
- 改写只动 import：剩下只有类型的 import 改为 `import type`（`consistent-type-imports` 要求），并入 shared 的名字不改变绑定。
- 结论：功能面无遗留问题；集中验证中发现的三份本地常量已改取 shared 并复验。

## PR / 提交

一个提交：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
