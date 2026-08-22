# RFC-315 实施计划：统一事件自动化规则权限合同

- 状态：In Progress（实现与全量本地门禁完成，等待提交及远端精确 SHA CI）
- 对应：[`proposal.md`](./proposal.md) / [`design.md`](./design.md)

## 1. 任务

| 任务 | 内容                                                                | 当前状态                              |
| ---- | ------------------------------------------------------------------- | ------------------------------------- |
| T1   | 冻结两套路由、权限、owner 与 token 现状                             | Done                                  |
| T2   | shared 新权限族、Event Center catalog/i18n、role preset             | Done                                  |
| T3   | `0202` grant/PAT 迁移、冗余清理、audit/幂等锁                       | Done                                  |
| T4   | 来源无关规则 RouteMeta、PAT fence、write principal、owner/launch 门 | Done                                  |
| T5   | Webhook RouteMeta/service/frontend 切统一权限名                     | Done                                  |
| T6   | 来源无关规则 owner UX 与 mutation authority generation              | Done                                  |
| T7   | shared/migration/HTTP/frontend 定向矩阵                             | Done                                  |
| T8   | RFC-294 边界与旧名/`event-sources` 退役棘轮                         | Done（现有架构门 + source inventory） |
| T9   | RFC、STATE、索引与发布/回滚说明                                     | Done                                  |
| T10  | 全量本地 gate、精确路径提交、远端 exact-SHA CI/visual 归因          | In Progress                           |

## 2. 验证清单

### shared/catalog

- [x] 五个新点存在，生产 permission enum 中五个旧点不存在
- [x] catalog/group/i18n 穷尽
- [x] user=read，manager=read+CRUD，无 override；admin 全量；guest 无
- [x] override system-domain / PAT never；delete 仍 explicit

### migration

- [x] grant 同 verb rename、冲突与 provenance
- [x] role preset 冗余清理；`event-sources:update` 不映射
- [x] active/revoked/expired PAT rename/去重且状态不变
- [x] invalid/mixed PAT JSON 原字节；audit 原字节
- [x] 幂等
- [x] 新 scope 的 Webhook PAT 路由保持可达

### backend

- [x] admin/manager/user/guest 默认读写矩阵
- [x] manager own 成功、other 404；admin global 成功
- [x] 显式 CRUD grant 仅 own；显式 override 可跨 owner
- [x] owner body 伪造 422；cross-owner 404 先于 body 校验
- [x] create 缺权限 403；数字员工 create/update 缺 launch 403 且零目标改写
- [x] Webhook PAT 可达；来源无关规则 PAT 拒绝

### frontend

- [x] 两面板共享 owner-aware helper
- [x] manager 只看到 own-row 控件，other 只读
- [x] user 全量只读，无 create/edit/toggle/delete
- [x] owner 公共身份、id fallback、“我的规则”
- [x] actor authority generation 与 request-boundary 重验
- [x] 用户可见术语改为“事件自动化规则”

### release gates

- [x] targeted format/lint/typecheck/test 全绿
- [x] `bun run gate:local` 全绿（非网络沙箱；后端四分片、frontend、shared、system-mocks 均零失败）
- [ ] 精确路径 staged diff / commit trailer 验证
- [ ] 推送 `origin/main`，证明远端包含目标 SHA
- [ ] exact-SHA hosted CI 与 visual 终态归因
- [ ] RFC/STATE/索引置 Done

## 3. 提交与共享 main 约束

实现位于从 `origin/main` 冻结出的隔离 worktree；原共享工作树中的 RFC-310 并发 WIP 不属于本任务。提交只精确暂存 RFC-315 路径，不使用 broad stage、stash、reset、rebase、amend 或 force-push。若远端前进，先重新冻结并以非破坏方式整合，再重新跑受影响门。

## 4. 完成定义

proposal AC-1～AC-12 有源码/测试证据；全量 gate 通过；提交已推到远端 main；目标 SHA 或包含它的后继 SHA hosted CI 终态可归因；取消 run 不算绿；STATE 与 RFC 索引同步为 Done。
