# RFC-617 实施计划

依赖：RFC-575、RFC-591、RFC-593。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-617-T1 迁移**：六个文件原样迁入 platform，读者改指（design §1）。
- **RFC-617-T2 账本与锁**：钉着旧路径的账本、源码锁与计数随之改（design §1）。
- **RFC-617-T3 门与文档**：新增 RFC-617 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 W9-D 注记（design §2）。
- **RFC-617-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-617-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 六个文件在新位置，没有读者取旧位置
- [x] AC-2 新文件只取 node / shared / platform，行为不变
- [x] AC-3 计数 53 → 47；新增 RFC-617 用例并登记
- [x] AC-4 exact SHA CI 全绿

## 集中验证

候选导出 = HEAD `a36412c24` + 只含本 RFC 的路径（93 条）。

- **静态**：backend `tsc --noEmit`（6144 MiB 堆）0 错；70 个改动的 TS 文件 eslint（`--max-warnings=0`，另跑 promises 配置）与仓库根
  `tests/perf/run.ts` 的 eslint 均 0；prettier 全过；性能基准 `bun build tests/perf/run.ts` 成功（CI 的 perf 任务直接跑它）。
- **用例第一轮**（改动路径的传递闭包 + 名字 + 全部架构与文档读者，1,656 个文件）：抓到三处真问题，均已修——
  - `.github/workflows/windows-platform.yml` 的路径过滤钉着 `util/fileTrust.ts` 与 `util/gitHardening.ts`（`ci-workflow-path-filters`、`rfc473`、`rfc474` 三处红）：
    迁移后 Windows 任务不会再因这两个文件触发，删去两条字面量（已被同一块的 `platform/execution/local/**` 覆盖）；
  - 改指脚本把 `rfc593` 两条写在字符串里的伪造源码也改了（其一是 `util/git` 前缀的近似对照，负对照因此失效），恢复原文，`rfc591` 收紧放行；
  - 仓库根 `tests/perf/run.ts` 不在第一版改指范围内，补改，RFC-617 用例的语料随之加上仓库根 `tests/`。
    另 `rfc321` 红：导出的本地 git 没有发布历史，与此前每次导出（如 RFC-614）同一断言，环境性。
- **用例第二轮**（第一轮之后的改动 + 全部架构与文档读者，473 个文件）：除 `rfc321`（同上）外全过。
- **架构报告**（同一 HEAD 的对照导出 vs 候选）：计数只有 `legacy-horizontal-files` 53 → 47；其余集合条目数不变，只是路径换到新位置。
- **变异**（4 / 4 被抓）：旧位置留一跳转出（RFC-617 ①、`rfc376`、`rfc575` 红）；读者改回取旧位置（RFC-617 ②）；迁入的文件取模块（RFC-617 ③、`rfc376` 的
  platform → modules）；用例 `mock.module` 旧位置（RFC-617 ②）。每次恢复后导出干净。
- **并发**：共享工作树里 RFC-616 在验证之后改了 `employeeTypePackage.ts`（新增过程度量的导出，引用它尚未提交的文件）。本提交按验证过的版本
  （HEAD + 本 RFC 的一行 import）提交该文件，不带入、也不改动它的在制品。

## CI（AC-4）

- 实现提交 `9f1b2535f`：CI run 45866414822 的 68 个测试 / 构建 job 全绿；格式检查红——`rfc254-platform-surface-guard` 改指后一行超出 printWidth
  （本 RFC 的缺陷：发布前的格式检查只跑了改写脚本碰过的文件），`a18f85368` 只按 prettier 折行。
- `a18f85368`：CI run 45868339529 全绿（70 / 70）；windows-platform 在两个提交上都绿。

## 实现门（本会话自审，只审功能）

检视口径：只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

- 六个迁移文件与 HEAD 原文逐行对比：只有 design §0 裁定一列出的三行不同（两条 import、一处注释）。
- 37 个 `src` 读者文件的改动只有 import 说明符与六处注释（逐行机械核对）；用例侧的字符串改动逐条核对为有意的放行 / 路径钉 / 标题更新。
- 运行期按路径取这些文件的地方：凭据助手单独构建的入口（`util/gitCredentialHelper.ts` 与它的租约）未动、不取迁移的文件；`rfc254-git-windows` 按路径读
  `gitHardening.ts` 已改指；CI 触发面（Windows 路径过滤）与 perf 任务的入口已改。
- 结论：功能面无遗留问题；集中验证中发现的三处均已修并复验。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
