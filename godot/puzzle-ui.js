const PHASE_LABELS = {
  loading: '正在布阵', playerTurn: '红方行棋', opponentTurn: '黑方应对',
  animating: '行棋中', wrongMove: '再想一想', paused: '已暂停',
  success: '破局成功', failure: '再试一次', demonstrating: '解法演示', error: '加载遇到问题',
};

function messageFor(view) {
  if (!view) return '正在准备教学关卡…';
  if (view.error) return '棋局暂时无法继续，请重新开始本关。';
  if (view.demonstrating) return view.outcome?.status === 'success'
    ? '演示结束。退出演示后，会恢复你之前的棋局。'
    : '正在演示完整走法。你可以随时退出，回到之前的棋局。';
  if (view.phase === 'success') return '将死成立！可以进入下一关，或展开本关思路回顾。';
  if (view.phase === 'wrongMove') return '这条走法偏离了推荐解法。可悔棋重新思考，也可继续尝试。';
  if (view.phase === 'failure') return view.outcome?.reason === 'turnLimit'
    ? '红方步数已用完。悔棋或重新开始，试着更快地将死黑将。'
    : '本次未达成将死目标。悔棋或重新开始，再试一种走法。';
  if (view.phase === 'paused') return '棋局已暂停，继续后会接着当前局面行棋。';
  if (view.phase === 'opponentTurn') return '黑方正在应对，请观察接下来的变化。';
  if (view.phase === 'animating') return '正在行棋，请稍候。';
  if (view.hint) {
    if (view.hint.showDestination) return '已标出推荐棋子与落点，试着完成这一步。';
    if (!view.hint.move && !view.hintLevel) return '当前变化暂时没有提示。可悔棋回到前面的局面，或继续尝试。';
    return view.hint.text;
  }
  return '观察将帅位置，寻找制胜的一步。';
}

/** Present the shared puzzle controller without owning game or animation state. */
export function createPuzzleUI(callbacks = {}) {
  const ids = ['mode-game', 'mode-puzzle', 'puzzle-picker', 'puzzle-panel', 'puzzle-notes', 'puzzle-select',
    'puzzle-previous', 'puzzle-next', 'puzzle-goal', 'puzzle-turns', 'puzzle-status',
    'puzzle-hint', 'puzzle-demo', 'puzzle-stop-demo', 'puzzle-continue', 'puzzle-resume', 'puzzle-reload',
    'puzzle-message', 'puzzle-explanation', 'puzzle-explanation-details', 'puzzle-progress',
    'puzzle-storage-warning', 'puzzle-lock-note', 'motion-control', 'observation', 'keyboard-details'];
  const elements = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const listeners = [];
  let current = { active: false, loading: true, levels: [], records: {}, view: null };
  let previousActive = null, previousPuzzle = null, optionsSignature = '';
  const bind = (id, event, handler) => {
    const element = elements[id];
    element.addEventListener(event, handler);
    listeners.push(() => element.removeEventListener(event, handler));
  };
  bind('mode-game', 'click', () => callbacks.onMode?.('game'));
  bind('mode-puzzle', 'click', () => callbacks.onMode?.('puzzle'));
  bind('puzzle-select', 'change', event => {
    const chosen = current.levels.find(level => level.id === event.target.value);
    if (chosen && !chosen.locked) callbacks.onChoose?.(chosen.id);
  });
  for (const [id, name] of [['puzzle-hint', 'onHint'], ['puzzle-demo', 'onDemo'],
    ['puzzle-stop-demo', 'onStopDemo'], ['puzzle-continue', 'onContinue'],
    ['puzzle-previous', 'onPrevious'], ['puzzle-next', 'onNext'], ['puzzle-resume', 'onResume'], ['puzzle-reload', 'onReload']]) {
    bind(id, 'click', () => callbacks[name]?.());
  }

  function render({ active = false, loading = false, view = null, levels = [], records = {}, warning = '' } = {}) {
    current = { active, loading, view, levels, records };
    const warningText = Array.isArray(warning) ? warning.filter(Boolean).join('；') : String(warning || '');
    const failed = active && !loading && !view && !!warningText;
    document.body.classList.toggle('puzzle-active', active);
    elements['mode-game'].setAttribute('aria-pressed', String(!active));
    elements['mode-puzzle'].setAttribute('aria-pressed', String(active));
    elements['mode-game'].disabled = loading;
    elements['mode-puzzle'].disabled = loading;
    elements['puzzle-picker'].hidden = !active;
    elements['puzzle-panel'].hidden = !active;
    elements['puzzle-notes'].hidden = !active;
    elements['motion-control'].hidden = active;
    elements['observation'].hidden = active;
    if (previousActive !== active) {
      elements['keyboard-details'].open = !active;
      previousActive = active;
    }
    const complete = level => !!level.completed || !!(records[level.id]?.completed && records[level.id]?.contentVersion === level.contentVersion);
    const signature = JSON.stringify([levels.length ? null : [loading, failed], levels.map(level => [level.id, level.title, !!level.locked, complete(level)])]);
    if (signature !== optionsSignature) {
      const options = levels.map((level, index) => {
        const option = document.createElement('option');
        option.value = level.id;
        option.textContent = `${String(index + 1).padStart(2, '0')} · ${level.title}${complete(level) ? ' ✓' : level.locked ? ' · 待解锁' : ''}`;
        option.disabled = !!level.locked;
        return option;
      });
      if (!options.length) {
        const option = document.createElement('option');
        option.textContent = loading ? '正在加载关卡…' : failed ? '关卡加载失败' : '暂时没有可用关卡';
        options.push(option);
      }
      elements['puzzle-select'].replaceChildren(...options);
      optionsSignature = signature;
    }
    const puzzle = view?.puzzle;
    if (puzzle) elements['puzzle-select'].value = puzzle.id;
    elements['puzzle-select'].disabled = loading || !levels.length;
    elements['puzzle-panel'].setAttribute('aria-busy', String(loading));
    const index = levels.findIndex(level => level.id === puzzle?.id);
    const previous = index < 0 ? null : levels[index - 1], next = index < 0 ? null : levels[index + 1];
    elements['puzzle-previous'].disabled = loading || !previous || !!previous.locked;
    elements['puzzle-next'].disabled = loading || !next || !!next.locked;
    elements['puzzle-next'].title = next?.locked ? '先通关当前关卡' : next ? `前往「${next.title}」` : '已经是最后一关';
    elements['puzzle-lock-note'].textContent = next?.locked ? '通关当前关卡，即可解锁下一关。'
      : next ? '下一关已解锁，可随时继续。' : '最后一关，也可以回看前面的局面。';
    const limit = puzzle?.goal?.maxRedTurns;
    elements['puzzle-goal'].textContent = failed ? '关卡暂未载入' : limit ? `红方 ${limit} 步内，将死黑将` : '红方先行，将死黑将';
    elements['puzzle-turns'].textContent = `红方 ${view?.snapshot?.redTurnsUsed || 0}${limit ? ` / ${limit}` : ''} 步`;
    elements['puzzle-status'].textContent = loading ? PHASE_LABELS.loading : failed ? '加载失败' : PHASE_LABELS[view?.phase] || '准备布阵';
    elements['puzzle-status'].dataset.phase = failed ? 'error' : view?.phase || 'loading';
    elements['puzzle-message'].textContent = loading ? '正在准备教学关卡…' : failed ? '关卡加载失败，请重试。也可以先切回自由对弈。' : messageFor(view);
    elements['puzzle-reload'].hidden = !failed;
    elements['puzzle-reload'].disabled = loading;
    elements['puzzle-progress'].textContent = `已通关 ${levels.filter(complete).length} / ${levels.length}`;
    const hintLevel = view?.hintLevel || 0, phase = view?.phase;
    elements['puzzle-hint'].textContent = hintLevel >= 3 ? '提示已全部展开' : `提示 ${hintLevel + 1} / 3`;
    elements['puzzle-hint'].title = ['提示制胜思路', '标出推荐棋子', '标出推荐落点'][hintLevel] || '已展示全部提示';
    elements['puzzle-hint'].disabled = loading || phase !== 'playerTurn' || hintLevel >= 3;
    elements['puzzle-demo'].disabled = loading || !view || ['loading', 'paused', 'animating', 'opponentTurn', 'error'].includes(phase);
    elements['puzzle-demo'].hidden = !!view?.demonstrating;
    elements['puzzle-stop-demo'].hidden = !view?.demonstrating;
    elements['puzzle-stop-demo'].disabled = loading;
    elements['puzzle-continue'].hidden = phase !== 'wrongMove';
    elements['puzzle-continue'].disabled = loading;
    elements['puzzle-resume'].hidden = phase !== 'paused';
    elements['puzzle-resume'].disabled = loading;
    elements['puzzle-explanation'].textContent = puzzle?.explanation || '先观察将帅的位置和彼此的牵制。';
    if (previousPuzzle !== puzzle?.id) {
      elements['puzzle-explanation-details'].open = false;
      previousPuzzle = puzzle?.id;
    }
    elements['puzzle-storage-warning'].textContent = warningText ? `${failed ? '' : '进度提醒：'}${warningText}` : '';
    elements['puzzle-storage-warning'].hidden = !warningText;
  }

  return { render, destroy() { listeners.splice(0).forEach(remove => remove()); } };
}
