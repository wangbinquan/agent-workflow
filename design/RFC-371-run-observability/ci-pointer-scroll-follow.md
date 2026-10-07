# 默认 WebKit CI：拖动泳道跟随迟到滚动

## 事实与范围

默认 WebKit 运行 `37583015939` 的原 onboarding 用例在实际泳道已成为 P1 后，拖动把手与原指针相差 `103.84375 px`，原 `<= 1 px` 几何断言两次失败。原断言、15 秒等待和全部后续排序、释放及键盘断言保留。该问题属于共享前端职责全景交互，不改变观测统计、后台用量或任务执行。

原 `updatePointerDrag` 只在 pointermove / pointerup 时校正 map 的 viewport 位移。React 调换有高度的 keyed 泳道后，浏览器可能在最后一次 pointermove 之后执行 scroll anchoring；没有新的指针事件时，源码没有入口再次校正可见位置。现有 FLIP layout effect 不移动被拖泳道，因此它也不能补这一段位移。

## 修复设计

复用当前 pointer capture 和 preview priority，只在原拖动会话保存最近的 clientY。拖动开始及顺序发生变化的 layout effect，使用实际泳道矩形减去当前已应用 transform，得到当前未平移的位置，再校正 transform，使原抓取点保持在最近指针坐标。

同一个 effect 只在拖动期间监听 window 的 capture scroll，覆盖窗口和内部滚动容器的迟到滚动；停止拖动、pointercancel、lostpointercapture 和组件卸载时移除监听。滚动校正只移动可见源泳道，不创建排序事件，不改变已有的释放坐标决定最终排序的规则。沿用当前样式、FLIP 动画和 reduced motion 行为，不增加连续动画循环、固定延迟或重试。

## 回归与退出

在已有真实 React 组件用例中增加回归：最后一次 pointermove 后，分别由窗口及嵌套容器发出滚动事件，改变实际矩形所用的 viewport 坐标；不再发送 pointermove，仍须保持抓取点与指针相等，并验证释放提交相同的 P1 顺序。原用例和断言完整保留。

本机只检查格式、lint 和语法，不运行 AW 测试、类型、构建或 E2E。新 SHA 的 hosted frontend 与原默认四分片 WebKit 的原几何断言通过后才关闭本失败。已记录的两次 WebKit 失败不改写成通过。
