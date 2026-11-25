# RFC-575 实施计划

依赖：RFC-574。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-575-T1 搬迁与改指**：三个文件迁入 platform，读者的说明符改写（design §1、§2）。
- **RFC-575-T2 门、用例与文档**：归属表、`counts.json`、两份公共内核账本、public 类型偏差账本、P0 脚本的保护清单、钉着旧路径的判据与指针；
  新增 RFC-575 用例并登记 guard-manifest（design §3）。
- **RFC-575-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；本地跑后端全量的 SQLite 一支；读已提交源码的用例在候选导出里跑；
  架构报告对照；变异验证。
- **RFC-575-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 三个旧路径不存在、没有说明符再解析到它们；`hash.ts`、`logger.ts` 逐字节相同，`domainErrors.ts` 只差一行说明符
- [x] AC-2 行为不变
- [x] AC-3 `legacy-horizontal-files` 上限 101 → 98；归属表删去三行；钉着旧路径的判据、账本与指针随改；新增 RFC-575 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `9083e8331` 加本 RFC 的 1114 个路径，含三个删除，用本地提交固化，树哈希与“HEAD 加这些路径”
的树哈希相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、`STATE.md` 与 RFC-574 转 Done 的三处记录）；代码、用例、工作流与
账本逐个文件比对，与候选相同。

- **本人缺陷六处（已修复并复验）**，都是被挪文件的钉法没被事先找到：① 日志起初放在 `platform/observability/`，撞上 `rfc371` 不许 platform
  下路径匹配 `/observ/` 的规则（运行观测归 run-observability 模块），改名 `platform/logging/`（design §5 第 2 条）；② `rfc448` 用
  `target.startsWith('util/')` 放行整个 `util/`，改成点名两个原语；③ `rfc287` 按分段拼出的路径读 `util/errors.ts`（事先的检索用了 macOS `grep -E`
  不认的 `\s`，什么也没搜到）；④ `rfc395` 的源码摘要锁钉着三个只改了 import 一行的文件，摘要随之更新；⑤ `rfc512` 的正则写成转义形式
  `util\/errors`；⑥ RFC-575 用例自己的依赖清单在日志改名后残留旧目录。另外 `rfc437` 的 webhook 绑定放行表（RFC-574 的同类问题，见 RFC-574 plan）
  在本 RFC 里改成点名 `requestParsing` 与 `domainErrors` 两个原语。教训都补进 `docs/dev-gotchas.md`“挪文件前的检索”。
- **迁移的三个文件**：`hash.ts`、`logger.ts` 与原文件逐字节相同；`domainErrors.ts` 只差取日志的那一行说明符（行数不变）。生产代码的其余改动：
  680 个读者的 import 说明符（其中 26 个文件的 import 变长后被 prettier 折行）与源码注释里的路径。
- **钉着旧路径的地方**：56 个文件里 110 处非 import 的提及（闭集依赖清单、放行项、按解析路径比对的字面量、读源码的路径、
  public 类型偏差账本的四条说明符、公共内核清单与债务账本、P0 脚本的保护清单、e2e / 前端 / shared 的现状指针）按同一张映射表改写；架构报告
  归属表删三行；`rfc377` 的 `util/git` 叶子锁按精确说明符放行三个原语（带负对照：同目录的 `publicError` 仍被拒）。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 1100 个 TS 文件无告警，生产文件（684 个）另过
  promises 配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **后端全量（SQLite）**：第一次按 CI 的分片跑法（`bun run test:backend`），四个分片都在 45 分钟的分片上限处被杀（机器
  负载 30～100，同机的虚拟机占满了 CPU），已跑完的部分查出下面五处本人缺陷；修复后改用逐文件的跑法（60 秒；4 个 worker）跑完全部 3019 个用例文件：
  24582 条通过、3 条红。其中两条是本人缺陷——`rfc512` 的一条负对照（正则里写成 `util\/errors` 的转义形式，映射表没认出）与 RFC-575 用例自己的
  依赖清单（日志改名后残留旧目录的相对路径）——修复后两个用例 20 / 20；第三条是 `rfc167` 的一条 HTTP 用例在负载下 5.6 秒后断言落空，单独跑（默认 5 秒
  超时）29 / 29，前一次被超时打断的全量运行里同一组用例也是这样，记为环境性。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本与 Windows 工作流的
  用例、钉着本次改动位置的用例，共 207 个文件、2043 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-575 用例 6 / 6、
  `rfc294-architecture-preflight` 15 / 15、`rfc317-architecture-ledgers` 15 / 15、`rfc359-w8-t29-unnormalized-unique-insert` 13 / 13、
  `rfc371-v2-observation-boundaries` 6 / 6、`rfc427-entry-root` 3 / 3、`rfc473-execution-outcome-and-resource-sessions` 12 / 12。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：十一种都被认出。搬迁一侧：旧路径上重新出现一跳转出（RFC-575 用例 ① 与
  `rfc376-structural-guards` 的 legacy 文件计数同红）；生产读者重新取旧路径（用例 ①）；迁入的文件开始取模块（用例 ② 与 `rfc376-structural-guards`
  同红）；少一个导出（用例 ③）；`util/` 里多出一个文件（用例 ④ 与 legacy 计数同红）。随改的判据：`util/git` 取同目录的 `publicError`（`rfc377` 红）；
  development-automation 的 domain 取日志（`rfc310` 红，白名单仍只放行 hash）；一个 public 面类型取日志（`rfc294-architecture-preflight` 红，偏差条数
  涨了）。行为一侧：校验错误不再映射 422（`cached-repos-http-batch` 红）、单步 SHA-256 改成 SHA-1（`rfc284-microhelpers` 红）、日志改回
  `process.stdout.write`（`log.test` 红）——证明错误映射、hash 与日志的既有用例都落在新文件上。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，101 → 98（少的正是这三个文件）。跨 context import（7530）、
  符号归属（32529）、变更入口普查（2393）、public 面（989）与 public 类型偏差（32）条数不变；偏差里四条的说明符换成新位置；有差别的其余条目都是
  这三个文件自己的（所在层从 util 变成 platform）与指向它们的 import，差在路径、行号与由它们算出的 id。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **没有行为改动的落点**：`hash.ts`、`logger.ts` 逐字节相同，`domainErrors.ts` 只差一行说明符；改写的说明符逐行看过，各只改了路径（别名的仍用
  别名、相对路径的重算）；`auth/`、`util/` 余下的一族与身份认证、任务授权一类的文件只动 import 那一行。
- **判据的覆盖面不变**：闭集清单、放行项与读源码的路径都换成新位置，条数不变；`rfc310` 的 domain 白名单仍只放行 hash 一个原语；
  `util/git` 的叶子锁只多放行三个精确说明符；public 类型偏差的条数不变（四条只换了说明符）。
- **错误、日志与 hash 的行为**：变异 m9～m11 证明错误映射、hash 结果与日志写出路径仍由既有用例覆盖到新文件上。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
