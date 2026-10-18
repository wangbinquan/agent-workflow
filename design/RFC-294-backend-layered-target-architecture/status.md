# RFC-294 架构报告生成说明

RFC-376 起，本文件不再保存指标或源码摘要。当前数字以最近一次 dated review 或按需生成的报告为准。

在仓库根目录运行：

```sh
bun run architecture:report --source-ref HEAD
bun run architecture:report --source-ref <rev> --gates
bun run architecture:report --source-ref <rev> --out .architecture-report/ --status .architecture-report/status.md
```

默认输出为 `.architecture-report/report.json` 和 `.architecture-report/status.md`，该目录已被 Git 忽略。
报告只读所选 revision 的已提交对象，标明完整源 SHA 和可复现的源提交时间；CLI 另打印实际生成时间。
`--gates` 打印可直接粘贴的精确例外集合与计数。报告没有写回 `architecture/` 的选项，不修改任何主题清单。

普通生产改动无需运行生成器或提交投影。硬结构门读取工作树源码；GitHub Actions 的干净 checkout 为权威。
`architecture/counts.json` 允许 measured <= max，下降只提示；抬高 max 必须同一提交改数，reason 包含 `max=<N>`。
新增例外仍须在对应 RFC 中列明并经用户确认。

`architecture:write` 已退役并以非零状态提示新命令；`architecture:status` 和旧 census / status 生成器已删除。
C7 零 consumer public 符号只进报告；G12 生命周期程序清单一致仍由 S2a 后继负责。
