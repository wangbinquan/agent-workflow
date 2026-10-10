# CI 修复：RFC-371 字符串生成器返回类型

## 失败事实

本 RFC 的夹具修复提交 `7f83f3ce514cecbe68d9c451200babf4f8ccadc2` 已自动触发主 CI 和完整 Windows。Windows run `38020057586` / job `114118853532` 的 RFC-254 platform suites、其后全部测试阶段成功；其中 `rfc370-task-host-runtime-lifecycle.test.ts` 的 52 个 SQLite provider 用例及一个全局调用者用例共 53 次实际执行全部 pass，九个 not-attached 用例不再超时。

整个 Windows 结论仍为 failure。Typecheck 报出 `packages/frontend/tests/rfc371-persistent-default-range.test.ts:197:16`、`:198:12`、`:199:13` 三条 `TS7024`；frontend 返回 2，backend/shared/system-mocks 均返回 0，后续构建及运行步骤 skipped。不能把测试通过记为完整 Windows 成功。本轮尚未签主 CI 的终态或 211 次完整生命周期人口。

## 有限修复

该文件由并行 RFC-371 会话在 `f495f7b1da3be22fc37c8166af5d618744fb09b0` 引入。在原 `test.each([... ] as const)` 表中，bad JSON / null / array 三个字符串生成器保持原 `'{'`、`'null'`、`'[]'` 返回值，只在各自 `()` 后补 `: string`。显式返回类型解除三个生成器依赖参数表上下文的循环推断。

只增加三个类型注解；逆向删除这三处注解后，整个测试文件与前驱原 11326 字节逐字相等。全部原测试注册、14 行数据、断言、回调体、预算、mock 和已有并行内容都保留。无需新增运行测试；现有 hosted 类型检查和测试负责验收。STATE 在完整旧正文前加记录，plan 在完整旧正文后追加记录。

## 验收界限

本有限候选只覆盖一个测试及三个 RFC 记录文件，独立实现门只审功能和原内容保持。测试执行、类型检查和构建均由 GitHub 完成；本机仅允许有限 format/lint 与纯文本/AST/JSON 检查。

发布后采用后继 exact-SHA 自动主 CI 和默认完整 Windows，总共 73 个作业终态必须全部成功，并对原生命周期 211 次实际执行逐标题核对。前驱失败保留；没有 rerun 失败测试来掩盖错误。HumanGate 生产实现、19 owners / 三启动根整体、H7/A-T7/A-G、CS adapters、首次 M0 部署及后续 M1–M4、RFC 完成均未签。
