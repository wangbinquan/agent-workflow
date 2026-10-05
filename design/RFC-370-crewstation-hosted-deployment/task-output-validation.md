# A-T2／A-T5：Task 输出内容校验的异步切面

沿用已批准的 `agent-invocation-factory.md`。Task 的正常共同核心在退出本机入口前，必须把输出内容校验与归档一起交给选中内容实现。当前 `resolvePortContentDetailed` 虽已使用共享 kind registry，仍固定消费 `NODE_VALIDATE_IO`；已完成的 `PortArtifactOperations` 只覆盖归档与读取，不覆盖这个校验读点。本增量补齐此切面，不改变输出规则，不引入 CS 生产 adapter，不关闭完整 Task、A-G 或部署。

## 1. 保留一套原规则

完整保留 `resolvePortContentDetailed` 的 undeclared kind 原文直通、`parseKind → getHandlerForParsedKind` 派发、结果投影与 `PortValidationError` 分类。`PortValidationFailure`、错误类及旧 options 声明保留全部成员、构造、注释、可选性与兼容出口；声明和共同策略归 TE application，避免新 application 反向引用自己的 legacy facade 形成值级循环。

共享 registry 的五个真实 parametric handler 提供必需的 `validationPolicy`。path／list 的原完整 validate 正文移为 generator policy，只在原实际 IO 与子项调用处 yield；旧同步 `validate` 是这同一 policy 的 native interpreter，保持同步 API、原返回值、同一异常与原错误分支。string／markdown／signal 的无 IO 算法保持，policy 只调用其原纯验证。原 classic `OutputKindHandler` 四方法合同不扩展，原 static registry、所有 matches、codec、判据、预算与断言不改变，不增加动态注册或第二套 kind 分类器。

同步补齐现有 parametric 合同的类型消费者。RFC-080 的负面类型夹具必须实现新 `validationPolicy`，仍只故意缺少原 `baseNames / carriesData / bulletSuffix / examplePlaceholder / isReviewableBody` 五项；原 `@ts-expect-error` 继续专门钉住这些成员不得变成 optional，不能被另一个缺失的必需 policy 遮蔽。原负面断言与预算保持。

policy 使用 shared 的双效果合同：原 path resolution 的完整结果与 UTF-8 read，允许同步值或 Promise。共同 interpreter 逐个执行真实效果；异步拒绝以 `generator.throw` 回到原算法位置，不能提前读取全部文件、重放 handler 或吞掉原异常。list 仍按原 item codec 顺序逐项验证、收集全部失败与成功 item，保留原返回 shape、索引与 detail 次序；没有并行预取或新增 first-failure 规则。空路径、词法与实际路径判定、扩展名、文件不存在、空正文、scalar、signal、空 list 和多行 markdown 的所有既有规则保持。

## 2. 独立内容实现与正常 purpose

TE application port 提供 `PortOutputValidationContent`：`resolve(workspaceRef, rawContent)` 返回 `targetRef / relativePath / insideWorkspace`，`readUtf8(targetRef)` 返回文本；仅选中 adapter 解释引用。application 的桥将这些事实投影为原共享验证 IO shape，原共享字段拼写不导致 normal policy 将引用按本机路径解释。每个 resolution、read 的调用时点、receiver、返回值和异常保持，没有按实现种类分支或缺方法回落。

外部正常消费者只接 `PortOutputContentValidation.resolve({ rawContent, kind?, port?, workspaceRef })`，取得原 `body / sourcePath? / items?` 或同一错误类；不会传任意文件操作、物理 cwd 或 CS DTO。composition 必须收到完整所选 content receiver；构造无 IO。原 `NODE_VALIDATE_IO` 的完整两个实现和注释迁入 `infrastructure/local`，保留原 helper、relative portable 拼写及原读效果，构成真实 native content 实现；legacy envelope 继续保留原同步 API 和准确类型出口。

正常 Task common core 随后在原 eager validation 调用点接必需的选中 purpose，所有输出的验证、归档、失败记录和结算次序保持。本增量不向 normal options 添加可选字段或 native fallback，也不借既有归档 reader 冒称此校验已经接线。legacy `runNode` 仍消费其原同步 helper，通过兼容 facade 使用同一共同 policy；三个真实 root 与其 fanout/resume 在完整 Task 接线单元验收。

## 3. 功能验收与发布

对拍原 path／list 全正文、codec、handler 派发、失败 payload、两个 native IO 正文及原全部 legacy APIs；只有实际效果位置、声明 owner 与同步解释入口改变。保留所有既有 shared kinds、envelope、包含关系和双 provider eager validation 用例及其原断言／预算。新增实际选中异步内容用例：不透明引用、等待 resolve/read、receiver、解析失败零读、空／错误扩展名零 read、原 read 拒绝分类、resolution 拒绝原样传播、list 全失败聚合／顺序、markdown wire 字节与 scalar/signal 不读；另验同步旧 API 与真实本机路径投影。

源码有限功能门、一次冻结候选的原 canonical／owner／public／SPI／SCC 匹配生成与 metadata 门、确切 SHA hosted CI 分别验收。本机只做目标 format/lint 与纯源文／AST／JSON 验证，不执行 AW tests/typecheck/build/service。原失败历史、共享内容和全部并行输出保持。完整 A-T5／A-T7／AC00／A-G 后才独立 CS adapters，M0 首次真实部署后逐项 M1～M4；当前没有 AW-in-CS 部署。
