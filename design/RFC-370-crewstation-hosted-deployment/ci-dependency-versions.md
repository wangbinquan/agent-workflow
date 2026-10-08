# RFC-370 CI：Static scans 的必要依赖版本修复

## 范围和实际失败

用户已明确允许本次对 Static scans 做必要 CI 排障，不扩展为安全审计。原 4efba2f9 主 CI 37733093270 的作业 113166465118 在 dependency audit gate 步骤失败；随后 actionlint／shellcheck 未执行。这里只处理该步骤报告的四个已锁定依赖版本，不改检查策略、忽略名单、严重级别、workflow 命令或失败传播。

## 有限变更

| 依赖                      | 原锁定版本 | 新锁定版本 | 声明位置                           |
| ------------------------- | ---------- | ---------- | ---------------------------------- |
| @modelcontextprotocol/sdk | 1.27.1     | 1.31.0     | backend 与 system-mocks 的直接依赖 |
| proxy-addr                | 2.0.7      | 2.0.8      | 原 root overrides                  |
| seroval                   | 1.5.4      | 1.6.3      | 原 root overrides                  |
| source-map-js             | 1.2.1      | 1.2.2      | 原 root overrides                  |

四个版本均已通过 npm 官方 registry 的精确版本 API 确认；锁定包的 integrity 与同一官方响应相等。保留原八项 overrides 和全部无关声明。backend 原开发命令的 type-package overlay、已锁定 @types/bun、@hono/node-server 的实际解析保持；SDK 新增可选版本范围未导致后者升级。

只运行原 Bun 的 lockfile-only／ignore-scripts 依赖解析，不安装或替换共享 node_modules，不启动 AW 或执行产品测试。原本机 Bun 1.3.13 首次因默认 tempdir 写权限失败，改用本次私有临时路径后正常生成锁文件。完整 JSONC 逆变换确认 878 个 lock package keys 中只有目标四项变化，其余所有 lock 字段和 workspace 声明保持。CI 仍使用仓库原 Bun 1.4.0 和 frozen-lockfile。

## 功能兼容与验收边界

SDK 仍在同一主版本，官方包保留原 client／server 子路径导出。当前 AW 和 system-mocks 所用 Client、stdio／SSE／Streamable HTTP 客户端以及 McpServer、WebStandard／Node／stdio／SSE 服务端公开入口、构造参数与 connect／handleRequest／registerTool 调用另做有限功能复核；不把版本可解析当成产品验收。

依赖版本变更按 CLAUDE.md 的既有例外不新增产品测试。独立功能实现门、精确上库／main 与 origin 同步以及新 exact-SHA hosted CI 分别验收，原失败不倒写，检查通过前不记总绿。没有生产源码、架构 metadata 或新 census 变更，没有本机 AW tests／typecheck／build／service／E2E。总流水线全绿前继续暂停 runtime／Node／CS 新实施，H7／A-G、M0～M4 与 RFC Done 仍开放，AW 尚未部署 CS。
