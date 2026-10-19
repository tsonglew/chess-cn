# Godot 残局来源与接入约定

Godot 使用原 Three.js 残局入口 `js/puzzle-main.js` 实际加载的 8 个自编教学预览，沿用会话、证明图、提示、黑方应对和进度模块。没有将历史候选题库包装为已审核棋谱。

## 数据状态与打包

- 原入口选择 `puzzles/previews/catalog.json`；正式目录 `puzzles/catalog.json` 的 `releaseIds` 为空。
- 8 个自编局面保留 `status: candidate`。它们的自动求解为 `passed`，独立棋理、文案与难度复核仍待完成，因此界面须明确标注「教学预览」。
- 不打包尚无完整局面的历史候选记录，也不把原 JSON 升级为 `verified`。
- 数据逐字复制到 `godot-project/web/puzzle/data/previews/` 和 `data/solutions/`。原 `solution.path`、来源说明、审核状态均保留；加载器仅将经校验的固定路径映射到新部署位置。
- `puzzle/source-manifest.json` 记录每份来源文件的原 SHA-256 以及有适配的模块。原目录不修改。
- `puzzle/rules.js` 与已有 `godot-project/web/rules.js` 完全一致。规则副本用于保持原模块相对导入关系；测试检查二者一致性。
- `tools/build-godot.mjs` 将 `puzzle/` 递归复制到 `/godot/puzzle/`，清除上次生成的同名目录，并在 `build-manifest.json` 列出所有嵌套资源摘要。代码/数据不需要重打 Godot 的模型资源。

## 接口

```js
import { loadPuzzleCatalog } from './puzzle/loader.js';
import { createPuzzleController } from './puzzle/game/puzzle-controller.js';
import { loadProgress, saveProgress } from './puzzle/game/progress.js';

const { levels, preview } = await loadPuzzleCatalog();
const loaded = await loadProgress(storage, levels.map(entry => entry.puzzle), {
  developmentPreview: preview,
});
const controller = createPuzzleController({
  developmentPreview: preview,
  presentation: { sync, play, cancel },
  onSave(envelope) { /* 更新 progress.resume 后调用 saveProgress */ },
  onComplete(award) { /* 按 puzzleId/contentVersion 幂等合并最佳记录 */ },
});
await controller.start(levels[0].puzzle, levels[0].solution, savedEnvelope);
```

`loadPuzzleCatalog()` 返回 `{levels: [{puzzle, solution}], preview: true}`。加载器检查目录状态、ID、局面合法性、FEN、自动验证字段、解法 SHA-256，并重放完整证明图以检查所有黑方防守。它是此次 Godot 接入新增的装配层；原复制逻辑仅在下述模块中适配，不修改来源文件或棋谱状态。每批最多并行加载 3 个关卡，以限制简单静态服务器上的连接数；网络连接/响应读取中断会显示失败资源路径，等待用户重试，数据验证错误不会被吞掉、改写为网络错误或自动忽略。离线测试重新求解全部红方解集，并与原证明图逐项比较。

控制器从原逻辑仅增加显式 `developmentPreview` 选项，向会话/恢复传递；进度加载增加相同选项。未显式启用时仍拒绝候选局面。原入口曾在内存将候选状态改成 `verified`，此接入保留候选状态并将允许预览作为独立选项。

`presentation.play(receipt, {signal, generation})` 接收：

```js
{
  revision, move: {pieceId, from: {row, col}, to: {row, col}},
  captured, before, after, check, terminalReason, winner
}
```

`before` / `after` 与 `presentation.sync(snapshot)` 使用同一稳定格式：

```js
{
  schemaVersion, puzzleId, puzzleVersion, revision,
  pieces, turn, moves, redTurnsUsed, lastMove
}
```

此快照没有可变 `history`。控制器先提交规则结果，再等待 `play()` 完成动画；表现层应在 Godot `move_done` 后 resolve，取消时释放等待、使旧 generation 失效。不要二次 `applyMove` 修改会话。棋子选择使用 `controller.getLegalMoves()`，避免原自由对弈规则允许的“吃将”代替将死判定。

控制器提供三级提示、整回合悔棋、重试、图外继续、解法演示及演示退出、暂停/恢复。`onComplete` 仅真实对局成功时触发，演示不授予完成记录。本次同时修复原逻辑中“最后一着动画尚未结束便暂停或刷新”的遗漏结算：恢复成功状态时调用同一 `completeOnce()`；同一会话不重复结算，跨刷新由宿主幂等合并完成记录。

`storage` 为 `{read(key), write(key, value), remove(key)}`，可同步或返回 Promise。原进度键是 `chess-cn.progress.v1`，具有串行写入、备份、损坏隔离和未来版本写保护。宿主可用命名空间适配器隔离 Godot 存档；返回的 `warnings` 应向用户可见，保存失败不得阻断棋局。`onSave` 的 envelope 含 `snapshot, phaseAfterRestore, continuationAccepted, hintLevel, hintsUsed`。

## 验证

运行 `node --test test/godot-puzzles.test.js`。覆盖全部 8 局的原始内容摘要、完整证明重算和控制器实走、候选默认拒绝、坏数据拒绝、三级提示、演示不记奖、整回合悔棋、预览恢复、完成动画中断后结算、迟到回调隔离、进度损坏恢复及未来版本保护。浏览器接入与线上验证由整体验收记录另行补充。

自动求解通过证明的是这些自编局面在限定红方着数内存在必胜解；不等同于经典棋谱来源考据、独立难度评审或正式内容发布审核。
