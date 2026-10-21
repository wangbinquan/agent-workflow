# RFC-393 实施计划

**前置**：RFC-392 已提交，S2b 完成。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-393-T1 | 26 个文件迁入 `bootstrap/`（文件系统移动，内容只改 import 路径）；改写 `bootstrap/` 五个文件与 `main.ts` 的 import | design §2.1、§2.4 |
| RFC-393-T2 | 会话输入类型迁入 `bootstrap/daemonSessionInput.ts`；`server.ts` 改为结构声明的 core 合同 | design §2.2、§2.3 |
| RFC-393-T3 | 目录级硬门新测试，登记 guard-manifest；删去 RFC-391 的两文件 import 检查 | design §2.6 |
| RFC-393-T4 | G9 作用域与 import 规则、RFC-376 账本与变异 fixture | design §2.5 |
| RFC-393-T5 | 其余守卫、账本、清单、helper 与 workflow 路径过滤 | design §2.7 |
| RFC-393-T6 | 测试 import 与源码路径字面量改写 | design §2.8 |
| RFC-393-T7 | 文档：`docs/dev-gotchas.md` 中涉及迁移文件路径的段落 | design §4 |

**依赖**：T1 → T2 → T3、T4、T5 → T6；T7 贯穿。

## 冲突面

以下文件与 S2c 后继 RFC 串行：

- `bootstrap/**`、`cli/**`、`server.ts`、`main.ts`；
- `T/architecture/*`、`architecture/*.json`、`T/helpers/daemonGraphSource.ts`；
- RFC-370 根接线测试族。

## 验收清单

- [x] proposal AC-1～AC-4（`a1a37759e`；本地 SQLite 全量、PostgreSQL 106 个文件、双 lane 64 个文件全绿）
- [x] 推送后 CI：`a1a37759e` 的 windows-platform、maintenance-soak、三平台 e2e 均绿；主 CI `39681863635` 红在迁移漏改的三处旧路径
  （RFC-294 评审文档的 Markdown 链接、前端 `rfc208-request-deadline` 按路径片段读后端源码），`d31298011` 补改后后继 CI `39684782788` 全绿
