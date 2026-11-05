# RFC-451 实施计划

**前置**：RFC-450 落地（`d29f951e0`，文档 `52d08e929`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号        | 内容                                                                                               | 依据      |
| ----------- | -------------------------------------------------------------------------------------------------- | --------- |
| RFC-451-T1  | 子模块参数解析迁入 `platform/workspace/local/submoduleParams.ts`                                   | design §1 |
| RFC-451-T2  | 镜像缓存、批量导入、后台保鲜、开发工作区仓库准备迁入 source-control `infrastructure/local`         | design §1 |
| RFC-451-T3  | `CachedRepositoryOperations` 合同（ports / public / composition）；路由、`server.ts`、HTTP 装配    | design §2 |
| RFC-451-T4  | source-control 内部、平台与装配根改取新位置                                                        | design §3 |
| RFC-451-T5  | 用例 import、随迁文本锁、发布账本与归属表、guard-manifest；新增 RFC-451 用例                       | design §4 |
| RFC-451-T5b | `git-protocols-e2e.yml` 触发清单改指新文件；新增 workflow 触发清单守卫与踩坑记录（集中验证时查出） | design §4 |
| RFC-451-T6  | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                              | design §6 |
| RFC-451-T7  | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan                                            | —         |

## 验收清单

- [x] AC-1 三个旧文件删除、零引用；路由不 import `services/`；平台 → 模块仍为 0
- [x] AC-2 计数按实测更新（路由 2 → 1，`services/` 208 → 205）
- [x] AC-3 受影响用例与新增用例全部通过（本机负载下的超时逐个复跑或同刻对照，见下）
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-05，候选基于 `52d08e929`）

本机全程高负载（负载 19～124，主要来自 Docker VM）。验证都在候选导出仓库里跑（`52d08e929` 的 `git archive` 加候选路径，提交后运行）；
集中验证中的修复同步进导出仓库后，核对 100 个候选路径与 guard-manifest 与工作树逐字节相同。

- **静态**：`tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（改动的后端与 e2e 文件）；改动的 TS 与文档已按 prettier 格式化；
  `guard-manifest.json` 刷新 RFC-359 void promise、RFC-284 git 双生文本锁与 spawn 点、RFC-311 性能防护四份守卫的行数。
- **本 RFC 的问题，已修**：`git-protocols-e2e.yml` 的 push / pull_request 触发清单仍列着 `services/gitRepoCache.ts` 与
  `services/repoBatchImport.ts`——不报红，只是 git 协议套件从此不再随镜像缓存的改动触发（按路径段扫源码引用与文本锁都扫不到 workflow）。
  改指新文件并登记平台的 `submoduleParams.ts`（原在 `gitRepoCache.ts` 里）；新增 `ci-workflow-path-filters` 用例 3 / 3（对改前的 workflow
  报出那四条，改后为空），与 `test-suite-policy`、`ci-playwright-runner-image`、`root-test-entrypoint` 同跑 41 / 41；`docs/dev-gotchas.md` 记下这条。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4315～5317 s 全部跑完，合计 23383 pass / 127 skip / 48 fail，
  另有 32 条测试间未处理错误。除导出仓库只有候选提交所致的 `rfc321` 一条外都是超时（18 个文件；46 条撞默认 5 秒、RFC-363 一条撞自带的
  30 秒），未处理错误都出在这些文件里，是超时用例被拆除后仍在跑的异步尾巴。18 个文件逐个单独复跑：16 个全过；RFC-396 MR 候选桥给 30 秒
  时限后 37 / 37；RFC-167 dw-confirm 的 `approve` 一例（用例自带 5 秒 `settleTask` 等待，到点时任务仍 running）在负载 100～115 下仍到点——
  对照：同一时刻在 RFC-450 的导出仓库里跑同一文件，失败的是同一例（5.5 s 与 5.6 s），其余 28 例两边都过。
- **导出仓库接 PostgreSQL 真库**：
  - 共 218 个文件：全部架构测试；迁移的家族（镜像缓存、批量导入、子模块保鲜与配置、开发工作区准备与新鲜度）；cached-repos HTTP（列表、
    分页、批量、子模块列、WS 导入）；隔离工作区与子模块参数；装配根与 HTTP 装配；提及这些文件的用例；RFC-440～451 用例；
  - 结果 2092 pass / 92 fail / 4 skip：除 `rfc321` 外都在 PostgreSQL 一侧超时（17 个文件；多数是测试应用在 PostgreSQL 上启动超过默认
    5 秒，超时拆除后的写入随即被代际栅栏拒绝）；
  - 给 30 秒时限后 14 个文件全过（183 pass）；三个自带预算的重型文件与 RFC-450 的导出仓库同一时刻并排复跑：RFC-311 性能防护 25 / 25
    （含 PostgreSQL 一侧的 `/api/cached-repos` keyset 首页，两边 796 s 与 798 s）、RFC-310 数字员工 e2e 4 / 4（两边各 337 s）；RFC-359 W6-T26
    PostgreSQL 计划审计的 600 秒准备钩子两边同时到点（各 603 s），其余 5 例两边都过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段全部符合预期，源文件哈希前后一致。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **计数复核**：import `services/` 的路由 2 → 1（只剩 `tasks`）；`services/` 208 → 205 个文件；`R1-inbound-module-internals` 166、
  `R2-outbound-module-to-legacy` 35 不变；模块里 import `services/` 的文件 138 → 139（迁入的家族仍取 legacy 的 `gitSubmodule`、`daemonCadence`、
  `maintenanceTicker`、`repoCredentials`）；平台 → 模块文件对 0。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的代码与原文件逐字相同（脚本逐文件核对）：镜像缓存去掉子模块参数解析那一段与只有它用的 import 后与原 `gitRepoCache.ts` 相同，该段原样
  在 `platform/workspace/local/submoduleParams.ts`；批量导入、后台保鲜只改 import；开发工作区仓库准备的接口、新鲜度判定与 build / create 原样
  迁入，`developmentDeliveryDeps` 只删去这段与它独占的 import；
- 路由六个端点与原实现等价：查询参数与 C7 双形状、PAT 删除的确认与快照、请求体校验都留在路由；刷新在有托管登记时走远端、否则按次读配置取
  克隆超时后本地刷新；批量导入按次读并发与保留期（未配置时不传，批量导入只在是数字时才用并发，保留期在发起时本就不读）、登记走所选镜像；
  快照与重试原样转发；`cached-repo-has-references` 原样抛给中央错误处理（原来的 try / catch 只是原样重抛，删去不改行为）；两个请求体 schema
  只有 `urls` / `url`，合同只转这两个字段不丢信息；
- HTTP 装配给合同的 store、镜像、配置、`appHome`、`secretBox` 与原来路由拿到的是同一批对象；装配根经 source-control composition barrel 取的
  批量导入归属 / 清理、后台保鲜与开发工作区准备是同一组函数；
- 集中验证查出 git 协议 workflow 的触发清单没有跟着迁移（见上），已修并加守卫。

## PR / 提交

单个提交：`refactor(backend): RFC-451 仓库镜像缓存家族归 source-control（RFC-294 W4 B/D）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
