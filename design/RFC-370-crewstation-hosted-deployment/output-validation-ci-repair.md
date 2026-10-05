# 输出校验切面的 CI 源码读取地址修复

`77017a6789e434b16ce30a3e54ea6b8e8f9dc5d6` 的 Windows run `37362639406`、job `111940665659` 在 RFC-254 的原 portable relative-path 源码锁失败。该锁仍读取 legacy `services/envelope.ts`；完整 `NODE_VALIDATE_IO` 已原样迁到 `modules/task-execution/infrastructure/local/filePortOutputValidation.ts`，legacy facade 保留准确同步出口。失败日志和先前完整原函数对拍均保留。

修复只把这个既有 source-reader 的地址指向实际 native IO。两个 `toPortableRelativePath(relative(...))` 原断言、其余全部测试内容和预算保持；生产源码、native 算法、同步兼容 API 及选中异步 policy 不变。本机只做该测试的 format/lint 与纯源文／AST 对拍，不运行 AW tests/typecheck/build/service；后继 exact-SHA 主 CI 和 Windows 另验。

生产人口仍为 `sha256:f888632c511a6cd2cd5f205280681aca5c71cbc6e68e133f47404c0a57e6d7b9`，复用已通过的一次原 scoped census，不重跑 classifier/generator。这个普通后继只退役上一批四个具名 matching 增长许可，129 行顺序、why、baseline 和全部实际计数、331 原债加七条真实地址、SPI/SCC 及其他 matching 内容保持。

`0fd982ff` 的主 CI `37359218532` 终态为 cancelled，保留已执行的 PostgreSQL RFC-310 question-set stash 失败；frontend job 日志记录 runner shutdown/cancel，未提供前端断言失败证据。该后端失败另行归因，不能用本次 Windows 源码地址修复宣告已解决。完整 Task 共同核心 DESIGN-R2 已有限 PASS，源码尚未实施；全根、A-G、CS 首次部署及完整 RFC 继续开放。
