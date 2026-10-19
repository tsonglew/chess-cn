import {loadPuzzleCatalog} from './puzzle/loader.js';
import {createPuzzleController} from './puzzle/game/puzzle-controller.js';
import {loadProgress,saveProgress,defaultProgress} from './puzzle/game/progress.js';

// Keep the existing controller as the only owner of puzzle rules and turns.
// Godot consumes its immutable receipts through the presentation port.
export function createGodotPuzzleMode({presentation,onChange,storage}) {
  let levels = [], progress = defaultProgress(), view = null, warning = '';
  let active = false, loading = false, initialized = false, loadingTask = null;
  let activation = 0, controller = null;
  const notify = () => onChange(getState());
  const levelViews = () => levels.map(({puzzle},index) => ({...puzzle,
    completed:!!progress.records[puzzle.id]?.completed && progress.records[puzzle.id].contentVersion === puzzle.contentVersion,
    locked:index > 0 && !(progress.records[levels[index-1].puzzle.id]?.completed && progress.records[levels[index-1].puzzle.id].contentVersion === levels[index-1].puzzle.contentVersion),
  }));
  function getState() { return {active,loading,view,levels:levelViews(),records:progress.records,warning,preview:true}; }
  async function persist() {
    const result = await saveProgress(storage,progress);
    if (!result.saved) { warning = `进度未保存：${result.error}`; notify(); }
  }
  function reportError(error) { warning = error.message || String(error); loading = false; notify(); }
  async function initialize() {
    if (initialized) return;
    if (loadingTask) return loadingTask;
    loading = true; notify();
    loadingTask = (async () => {
      ({levels} = await loadPuzzleCatalog());
      const loaded = await loadProgress(storage,levels.map(entry => entry.puzzle),{developmentPreview:true});
      progress = loaded.progress; warning = loaded.warnings.join('；');
      controller = createPuzzleController({developmentPreview:true,
        presentation:{
          sync(snapshot) { if (active) presentation.sync(snapshot); },
          play(receipt,context) { return active ? presentation.play(receipt,context) : Promise.reject(new DOMException('已取消','AbortError')); },
          cancel() { presentation.cancel(); },
        },
        onSave(envelope) { progress.resume = envelope; void persist(); },
        onComplete(award) {
          const old = progress.records[award.puzzleId];
          const sameVersion = old?.completed && old.contentVersion === award.contentVersion;
          progress.records[award.puzzleId] = {completed:true,contentVersion:award.contentVersion,
            hintsUsed:sameVersion ? Math.min(old.hintsUsed,award.hintsUsed) : award.hintsUsed,
            bestRedTurns:sameVersion ? Math.min(old.bestRedTurns ?? Infinity,award.redTurns) : award.redTurns};
        },
      });
      controller.subscribe(next => { view = next; notify(); });
      initialized = true;
    })().finally(() => { loading = false; loadingTask = null; notify(); });
    return loadingTask;
  }
  async function activate() {
    const token = ++activation; active = true;
    await initialize();
    if (!active || token !== activation) return;
    if (view) { if (view.phase === 'paused') await controller.resume(); else notify(); return; }
    const saved = progress.resume;
    const id = saved?.snapshot.puzzleId || levels[0].puzzle.id;
    // Corrupt restore intents must not leave a half-started controller on screen.
    try { await choose(id,saved); }
    catch (error) {
      if (!saved) throw error;
      warning = '上次棋局无法恢复，已保留通关记录并重新布阵。';
      await choose(levelViews().find(level => !level.locked)?.id || levels[0].puzzle.id);
    }
  }
  function deactivate() {
    active = false; ++activation;
    if (view?.demonstrating) controller.stopDemo();
    controller?.pause(); notify();
  }
  async function choose(id,saved = null) {
    if (!active || !controller) return;
    const entry = levels.find(item => item.puzzle.id === id);
    if (!entry) throw new Error('关卡不存在');
    if (levelViews().find(level => level.id === id).locked) throw new Error('请先完成上一关');
    await controller.start(entry.puzzle,entry.solution,saved);
  }
  function relative(offset) {
    const index = levels.findIndex(entry => entry.puzzle.id === view?.puzzle?.id);
    const next = levels[index+offset];
    return next ? choose(next.puzzle.id) : undefined;
  }
  return {getState,activate,deactivate,choose,reportError,relative,
    legalMoves:() => controller?.getLegalMoves() || [],
    playMove:move => controller.playMove(move),
    hint:() => controller.requestHint(),
    undo:() => controller.undoRound(), retry:() => controller.retry(),
    demo:() => controller.startDemo(), stopDemo:() => controller.stopDemo(),
    continue:() => controller.continueAfterWrongMove(),
    pause:() => { if (active) controller?.pause(); },
    resume:() => active ? controller?.resume() : undefined,
  };
}
