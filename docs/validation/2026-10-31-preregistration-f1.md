# 后续预注册 F1：修复配准假阳性后的新预留集复测（2026-10-31）

本文件在抽取任务与任何 F1 运行之前提交。背景见 [严格评估](2026-10-30-strict-evaluation.md)：E2 的错误来自稀疏界面上的模板配准假阳性与"只证明已提交"的后置条件。修复（提交 `1f20163`）：每个点击目标在 28×28 邻域内与示例逐点核对，值字段覆盖点击目标的策略在输入前拒绝；无值占位符的后置条件标为弱核验。E2 的六个任务已被查看，不再作为预留集。

## 任务抽取规则

候选池只按任务名称确定（实现者从未打开过这些任务的页面源码），排除拖拽、滚动、悬停、绘制、颜色、日期选择等明显超出 click/type/key 的类别：

`click-link, click-dialog, click-dialog-2, click-option, click-tab, click-test, click-test-2, enter-password, enter-text-2, enter-text-dynamic, focus-text, focus-text-2, click-button-sequence, unicode-test, multi-layouts, multi-orderings, login-user-popup, simple-arithmetic, odd-or-even, find-word, read-table, read-table-2`

用 Python `random.Random(2026103101).sample(pool, 6)` 抽取 6 个。若抽到的任务在固定版本中缺少依赖文件或无法加载，按同一随机序列顺延下一个，并记录。

## 设计

- **F1-M（预留）**：每任务 50 台，P-T 与 B-T，各 2 个区组，区组内臂顺序随机。模型 `gpt-6-astra` medium，预算与 E2 相同。
- **F1-D（开发集回归检查）**：B-T 在同构与混合开发集上各 2 次（100 台），检查修复没有降低正确率或广播覆盖；与此前结果为非配对比较，只作回归检查。

## 判定规则

- **H3′（主）**：F1-M 合计正确项 B-T ≥ P-T − 2%（相对 P-T 总项数），且零重复提交。
- **H3″（安全）**：由广播送达造成的错误提交 = 0（广播阶段完成的桌面中 reward ≤ 0 的数量）。
- 次要：逐任务报告广播覆盖率、时间比与 token 比，不设通过线。
- **F1-D**：两组开发集 B-T 均 100% 正确、广播覆盖 100% 视为无回归。
- 任一不成立如实报告，不追加补救实验翻转结论。
