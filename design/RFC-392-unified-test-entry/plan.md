# RFC-392 实施计划

**前置**：RFC-391 已提交，其后继 CI 确认 macOS。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-392-T1 | G：`testSeams` 收拢（原 7 个 + 新增 3 个）；只服务测试的默认改必填；模块组死接缝清理 | design §2.3 |
| RFC-392-T2 | H：两条 lane 合成一个调用点，提供接收数据库绑定的入口；dispatcher、contracts harness、runtimeOpencodeFixture 改经 H | design §2.1 |
| RFC-392-T3 | 删除 V 的测试路径及相关类型、字段、导入 | design §2.2 |
| RFC-392-T4 | 迁移直接 `createApp` 的用例与注入边界用例；按 proposal §6 处理 rfc370-m2、rfc300 等 | design §3 第 2 项 |
| RFC-392-T5 | 双根源码锁与账本、守卫（design §3 第 4 项 392a 部分）；新增结构锁 | design §3 |
| RFC-392-T6 | HTTP 组合迁入 `bootstrap/` 独立文件；开发用途根迁入 `bootstrap/`、类型迁入 development-automation composition；`UnstartedApplicationScope` 迁入 G | design §2.4 |
| RFC-392-T7 | 迁移后的守卫、清单与路径过滤（design §3 第 4 项 392b 部分） | design §3 |
| RFC-392-T8 | 文档：`docs/dev-gotchas.md`、`docs/audit-backlog.md` | design §3 第 5 项 |

**依赖**：T1 → T2 → T3、T4 → T5 → T6 → T7；T8 贯穿。

## 冲突面

以下文件与 S2c 串行：

- `server.ts`、`bootstrap/daemon*.ts`、`cli/daemonModules/*`；
- `tests/helpers/providerHttpApplication.ts`、`T/architecture/*`、`architecture/*.json`；
- RFC-370 根绑定测试族。

## 验收清单

- [x] proposal AC-1～AC-3（`64dd81e8d`；本地 SQLite 全量、PostgreSQL 833 个文件与双 lane 50 个文件全绿）
- [ ] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片、windows-platform、e2e 三平台）：主 CI `39660260202` 49/49 全绿（含 PostgreSQL、
  三平台 e2e）；windows-platform `39660260356`、maintenance-soak `39660260206` 红，归因 runner 变慢（`docs/audit-backlog.md`），
  后继证据待两个 workflow 的夜间定时运行
