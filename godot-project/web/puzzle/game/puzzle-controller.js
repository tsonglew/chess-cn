import {HINT_COPY,hintTexts} from './hint-copy.js';
import { createSession, submitMove, exportStableSnapshot, undoRound as undoSession, restoreSession, legalSessionMoves } from './session.js';
import { clone, invariant, terminalStatus } from './position.js';
import { loadSolution, lookupSolution } from './solution-tree.js';
import { chooseDefense } from './opponent.js';

/** 将死判定先于预算；缺失证明保持未知，不当成必败。 */
export function evaluateObjective(puzzle, snapshot, proof = {}) {
  const terminal = terminalStatus(snapshot), remaining = puzzle.goal.maxRedTurns - snapshot.redTurnsUsed;
  const base = { redTurnsUsed: snapshot.redTurnsUsed, redTurnsRemaining: Math.max(0, remaining), winner: terminal.winner };
  if (terminal.over) return { ...base, status: terminal.winner === 'red' && terminal.terminalReason === puzzle.goal.kind && remaining >= 0 ? 'success' : 'failure', reason: terminal.terminalReason };
  if (remaining <= 0) return { ...base, status: 'failure', reason: 'turnLimit' };
  if (proof.proofStatus === 'disproven') return { ...base, status: 'unproven', reason: 'noForcedMate' };
  return { ...base, status: proof.proofStatus === 'proven' ? 'inProgress' : 'unproven', reason: proof.proofStatus === 'proven' ? 'none' : 'proofUnavailable' };
}

export function createPuzzleController(ports = {}) {
  const sessionOptions = { developmentPreview: ports.developmentPreview === true };
  const presentation = ports.presentation || { sync() {}, async play() {}, cancel() {} };
  const listeners = new Set();
  let puzzle, solution, session, phase = 'loading', generation = 0, aborter = null;
  let hintLevel = 0, hintsUsed = 0, continuationAccepted = false, error = null;
  let completed = false, demo = null, pausedIntent = null, hint = null;
  const snapshot = () => session ? exportStableSnapshot(session) : null;
  const proof = () => lookupSolution(solution, snapshot(), puzzle.goal.maxRedTurns - snapshot().redTurnsUsed);
  const outcome = () => evaluateObjective(puzzle, snapshot(), proof());
  function cancel() {
    generation++; aborter?.abort(); presentation.cancel?.(generation - 1);
    aborter = typeof AbortController === 'function' ? new AbortController() : { signal: { aborted: false }, abort() { this.signal.aborted = true; } };
  }
  function settledPhase() {
    const result = outcome();
    if (result.status === 'success' || result.status === 'failure') return result.status;
    if (snapshot().turn === 'red') return 'playerTurn';
    return proof().proofStatus !== 'proven' && !continuationAccepted ? 'wrongMove' : 'opponentTurn';
  }
  function resumeEnvelope() {
    if (demo) return clone(demo.saved);
    invariant(session, '会话尚未启动');
    return { snapshot: snapshot(), phaseAfterRestore: phase === 'paused' ? pausedIntent : settledPhase(), continuationAccepted, hintLevel, hintsUsed };
  }
  function getViewState() {
    return { puzzle: puzzle ? { id: puzzle.id, contentVersion: puzzle.contentVersion, title: puzzle.title, goal: clone(puzzle.goal), explanation: puzzle.explanation, order: puzzle.order } : null,
      phase, snapshot: snapshot(), outcome: session ? outcome() : null, hintLevel, hintsUsed, hint: clone(hint), continuationAccepted, error, demonstrating: !!demo, generation };
  }
  function emit() {
    const view = getViewState();
    for (const listener of listeners) listener(view);
    if (!demo && session && phase !== 'disposed') ports.onSave?.(resumeEnvelope());
  }
  function completeOnce() {
    if (phase === 'success' && !completed && !demo) {
      completed = true; ports.onComplete?.({ puzzleId: puzzle.id, contentVersion: puzzle.contentVersion, redTurns: snapshot().redTurnsUsed, hintsUsed });
    }
  }
  function finish() {
    phase = settledPhase();
    completeOnce();
    emit();
  }
  async function playReceipt(receipt, token) {
    phase = demo ? 'demonstrating' : 'animating'; emit();
    await presentation.play(receipt, { signal: aborter.signal, generation: token });
    return generation === token && phase !== 'disposed' && phase !== 'paused';
  }
  async function runOpponent(token) {
    if (generation !== token || phase !== 'opponentTurn') return;
    emit();
    const current = snapshot();
    const selected = await (ports.chooseDefense || chooseDefense)({ puzzle, solution, snapshot: current, redTurnsRemaining: puzzle.goal.maxRedTurns - current.redTurnsUsed, generation: token }, { signal: aborter.signal });
    if (generation !== token || phase !== 'opponentTurn') return;
    invariant(selected.kind === 'move', selected.reason || '对手未能完成应对');
    const receipt = submitMove(session, selected.move, { expectedRevision: current.revision });
    if (!await playReceipt(receipt, token)) return;
    hint = null; hintLevel = 0; finish();
  }
  async function guarded(operation) {
    const token = generation;
    try { await operation(token); }
    catch (failure) {
      if (generation !== token || failure.name === 'AbortError') return;
      phase = 'error'; error = failure.message; emit();
    }
  }
  function restoreEnvelope(saved) {
    invariant(saved && ['playerTurn', 'opponentTurn', 'wrongMove', 'success', 'failure'].includes(saved.phaseAfterRestore) &&
      typeof saved.continuationAccepted === 'boolean' && Number.isInteger(saved.hintLevel) && saved.hintLevel >= 0 && saved.hintLevel <= 3 &&
      Number.isInteger(saved.hintsUsed) && saved.hintsUsed >= saved.hintLevel, '恢复意图格式无效');
    session = restoreSession(puzzle, saved.snapshot, sessionOptions);
    continuationAccepted = saved.continuationAccepted; hintsUsed = saved.hintsUsed; hintLevel = 0; hint = null;
    invariant(settledPhase() === saved.phaseAfterRestore, '恢复意图与棋局不一致');
    phase = saved.phaseAfterRestore;
    if (saved.hintLevel && phase === 'playerTurn') for (let index = 0; index < saved.hintLevel; index++) makeHint(false);
  }
  async function start(nextPuzzle = ports.puzzle, nextSolution = ports.solution, saved = null) {
    invariant(phase !== 'disposed', '控制器已销毁'); cancel();
    puzzle = clone(nextPuzzle); solution = loadSolution(nextSolution, puzzle);
    session = createSession(puzzle, sessionOptions); phase = 'playerTurn'; hintLevel = 0; hintsUsed = 0; hint = null;
    continuationAccepted = false; completed = false; error = null; demo = null; pausedIntent = null;
    if (saved) restoreEnvelope(saved);
    presentation.sync?.(snapshot()); completeOnce(); emit();
    if (phase === 'opponentTurn') await guarded(runOpponent);
  }
  async function playMove(move) {
    invariant(phase === 'playerTurn', '当前不能落子');
    const receipt = submitMove(session, move, { expectedRevision: snapshot().revision });
    continuationAccepted = false; hint = null; hintLevel = 0;
    await guarded(async token => {
      if (!await playReceipt(receipt, token)) return;
      finish(); if (phase === 'opponentTurn') await runOpponent(token);
    });
  }
  function makeHint(count = true) {
    invariant(phase === 'playerTurn', '当前不能提示');
    const choices = proof().winningMoves;
    if (!choices.length) { hint = { text: HINT_COPY.unknown, move: null }; emit(); return hint; }
    const move = choices[0], piece = snapshot().pieces.find(p => p.id === move.pieceId);
    hintLevel = Math.min(3, hintLevel + 1); if (count) hintsUsed++;
    const texts = hintTexts(puzzle,snapshot(),RName(piece));
    hint = { text: texts[hintLevel - 1], move: hintLevel >= 2 ? clone(move) : null, showDestination: hintLevel === 3 };
    if (count) emit(); return clone(hint);
  }
  function undoRound() {
    invariant(session && phase !== 'disposed' && !demo, '当前不能悔棋'); cancel();
    const result = undoSession(session); if (!result) return null;
    continuationAccepted = false; completed = false; hintLevel = 0; hint = null; error = null;
    phase = 'playerTurn'; presentation.sync?.(snapshot()); emit(); return result;
  }
  async function continueAfterWrongMove() {
    if (phase !== 'wrongMove') return; continuationAccepted = true; phase = 'opponentTurn'; emit(); await guarded(runOpponent);
  }
  function pause() {
    if (!session || ['paused', 'disposed'].includes(phase)) return;
    pausedIntent = demo ? 'demonstrating' : settledPhase(); cancel(); phase = 'paused'; emit();
  }
  async function resume() {
    if (phase !== 'paused') return;
    if (demo) { phase = 'demonstrating'; presentation.sync?.(snapshot()); emit(); await advanceDemo(); return; }
    phase = pausedIntent; presentation.sync?.(snapshot()); completeOnce(); emit(); if (phase === 'opponentTurn') await guarded(runOpponent);
  }
  async function startDemo() {
    if (demo || phase === 'disposed') return;
    const saved = resumeEnvelope(); cancel();
    demo = { saved, line: clone(solution.recommendedLine || puzzle.recommendedLine), index: 0 };
    session = createSession(puzzle, sessionOptions); phase = 'demonstrating'; presentation.sync?.(snapshot()); emit();
    await advanceDemo();
  }
  async function advanceDemo() {
    if (!demo || phase !== 'demonstrating') return;
    await guarded(async token => {
      while (demo && demo.index < demo.line.length && phase === 'demonstrating') {
        const receipt = submitMove(session, demo.line[demo.index], { expectedRevision: snapshot().revision });
        demo.index++; if (!await playReceipt(receipt, token)) return;
      }
      emit();
    });
  }
  function stopDemo() {
    if (!demo) return;
    const saved = demo.saved; cancel(); demo = null; restoreEnvelope(saved); presentation.sync?.(snapshot()); completeOnce(); emit();
    if (phase === 'opponentTurn') void guarded(runOpponent);
  }
  function dispose() { if(phase==='disposed')return;cancel(); phase = 'disposed'; listeners.clear(); presentation.dispose?.(); }
  const controller = { start, playMove, requestHint: () => makeHint(), undoRound, retry: () => start(puzzle, solution), continueAfterWrongMove,
    startDemo, advanceDemo, stopDemo, pause, resume, dispose, getViewState, getResumeEnvelope: resumeEnvelope,
    getLegalMoves: () => legalSessionMoves(session), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  return controller;
}
const RName = piece => ({ general: '帅', chariot: '车', horse: '马', cannon: '炮', advisor: '仕', elephant: '相', soldier: '兵' })[piece.type];
export function exportResumeEnvelope(controller) { return controller.getResumeEnvelope(); }
export function createDemonstration(puzzle, solution, options = {}) {
  return createPuzzleController({ ...options, puzzle, solution });
}
// TODO[DEV-04] TODO[DEV-06] 页面/小游戏集成及真机恢复验收见任务清单。
