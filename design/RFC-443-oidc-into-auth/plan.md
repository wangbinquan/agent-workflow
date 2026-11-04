# RFC-443 实施计划

**前置**：RFC-442 落地（`9c1a6f2a9`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                          | 依据      |
| ---------- | ----------------------------------------------------------------------------- | --------- |
| RFC-443-T1 | 两个 OIDC 文件原样迁入 `auth/oidc/`，原文件删除                               | design §1 |
| RFC-443-T2 | 引用改到新位置：两个路由、`auth/oidc/identity.ts`、bootstrap                  | design §2 |
| RFC-443-T3 | 用例改 import；RFC-305 锁与架构报告归属表；新增 RFC-443 用例；前端与 e2e 注释 | design §3 |
| RFC-443-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI         | design §6 |
| RFC-443-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（B / D 第九步）       | —         |

## 验收清单

- [x] AC-1 两个 `services/` 文件删除，源码不再 import 旧路径；`auth/` 不 import `services/`
- [x] AC-2 计数按实测更新（路由 12 → 10，`services/` 223 → 221）
- [x] AC-3 受影响用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-04，候选基于 `9c1a6f2a9`）

- **静态**：后端与 shared 的 `tsc` 0 错；eslint `--max-warnings 0` 与 promises 配置无告警（后端、shared、前端与 e2e 改动的文件）；
  改动的 TS 文件已按 prettier 格式化。
- **全量 SQLite**（`bun run test:backend`，四分片，3700 s）：23337 pass / 127 skip / 20 fail，另有 15 条测试间未处理错误。
  - **本 RFC 的问题**：无。本 RFC 改动或新增的用例全部通过；shared 的 `oidc-provisioning` 用例 9 / 9。
  - **负载超时，与本 RFC 无关**：20 条全部按各自时限超时（RFC-396 MR 候选桥 12 条、RFC-167 dw-confirm 3 条，RFC-131、RFC-363、
    RFC-370 V16、RFC-075 自动提交、RFC-193 wrapper review 各 1 条），7 个文件单独复跑全部通过（1 / 37 / 4 / 8 / 3 / 29 / 7 pass）。
- **导出仓库**（`9c1a6f2a9` 的 `git archive` 加候选路径，提交后运行，同时接 PostgreSQL 真库）：
  - 共 209 个文件：全部 139 个架构测试；提及 OIDC、OAuth2、开通或 `/api/auth/` 的用例；路由错误码棘轮、API 合同与覆盖、
    测试套件策略、RFC-305 架构锁与本 RFC 改动的用例；去重后合并；
  - 结果 2778 pass / 2 fail / 4 skip：
    - **本 RFC 的问题，已修**：新用例断言「`services/oidc/` 目录不存在」。导出脚本只删文件，留下空目录，断言就红了；
      git 不跟踪目录，空目录本身不是回退。改为断言「该目录下没有源文件」，重建导出后 5 / 5 通过；
    - 组合根路由面在四路并行下 PostgreSQL 启动超时，单独复跑通过（2 pass）；
  - RFC-305 架构锁（15）、OIDC 提供方服务、OAuth2 回调、登录策略、探测、路由错误码棘轮、API 合同（525）与测试套件策略均通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，SQLite 与 PostgreSQL）：每个引擎 17 个阶段（当前绿、15 个历史回归变异
  各自变红、当前再绿）全部符合预期，源文件哈希前后一致。
- **计数复核**：import `services/` 的路由 10 个；`services/` 221 个文件；`auth/` 下没有对 `services/` 的 import。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- `providers.ts`、`provisioning.ts` 与 HEAD 逐字节相同；
- 四个引用方只改 import 路径（`oidc-auth.ts` 的 import 被 prettier 合成一行），`auth/oidc/discovery.ts` 只改注释里的路径；
- RFC-305 锁的消费者清单只把同一条边的来源路径换成新位置。

## PR / 提交

单个提交：`refactor(backend): RFC-443 OIDC 提供方服务与开通策略归 identity-access 的 auth/oidc（RFC-294 W4 B/D）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
