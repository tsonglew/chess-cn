import * as R from '../rules.js';
import { assertPosition, assertSquare, allLegalMoves, terminalStatus, sameSquare, clone, invariant } from './position.js';

// 私有会话不向UI暴露任何活动数组；表现层仅消费深拷贝收据。
const sessions = new WeakMap();
function internal(session) { const data = sessions.get(session); invariant(data, '无效棋局会话'); return data; }
function snapshot(data) {
  return clone({ schemaVersion: 1, puzzleId: data.id, puzzleVersion: data.version, revision: data.revision,
    pieces: data.state.pieces, turn: data.state.turn, moves: data.moves,
    redTurnsUsed: data.moves.filter((_, index) => index % 2 === 0).length, lastMove: data.state.lastMove });
}
export function createSession(puzzle, { developmentPreview = false } = {}) {
  // Explicit preview entry: retain the source candidate status and never imply editorial approval.
  const allowedStatus = puzzle?.status === 'verified' || developmentPreview === true && puzzle?.status === 'candidate';
  invariant(allowedStatus && puzzle.verification?.status === 'passed', '只能创建已验证关卡会话，教学预览须显式启用');
  invariant(puzzle.id && Number.isInteger(puzzle.contentVersion) && puzzle.contentVersion > 0, '关卡版本无效');
  assertPosition(puzzle.initialPosition);
  invariant(puzzle.initialPosition.turn === R.RED, '首版关卡必须红先');
  const session = Object.freeze({ puzzleId: puzzle.id });
  sessions.set(session, { id: puzzle.id, version: puzzle.contentVersion, revision: 0,
    initial: clone(puzzle.initialPosition.pieces), moves: [],
    state: { ...clone(puzzle.initialPosition), history: [], lastMove: null } });
  return session;
}
export function submitMove(session, move, { expectedRevision } = {}) {
  const data = internal(session);
  invariant(expectedRevision === data.revision, '棋局已更新，请重新选择');
  assertSquare(move?.from); assertSquare(move?.to);
  const legal = allLegalMoves(data.state).find(candidate => candidate.pieceId === move.pieceId && sameSquare(candidate.from, move.from) && sameSquare(candidate.to, move.to));
  invariant(legal, '非法着法或行棋方不正确');
  invariant(!terminalStatus(data.state).over, '棋局已经结束');
  const before = snapshot(data);
  const nextState = clone(data.state); // 原子提交：规则调用失败不改变原状态。
  const captured = R.applyMove(nextState, nextState.pieces.find(p => p.id === legal.pieceId), legal.to);
  data.state = nextState; data.moves.push(clone(legal)); data.revision++;
  const status = terminalStatus(data.state);
  return { revision: data.revision, move: clone(legal), captured: captured ? clone(captured) : null,
    before, after: snapshot(data), check: status.check, terminalReason: status.terminalReason, winner: status.winner };
}
export function undoRound(session) {
  const data = internal(session);
  if (!data.moves.length) return null;
  const count = data.moves.length % 2 === 0 ? 2 : 1;
  for (let index = 0; index < count; index++) { R.undo(data.state); data.moves.pop(); }
  data.revision++;
  return snapshot(data);
}
export function exportStableSnapshot(session) { return snapshot(internal(session)); }
export function legalSessionMoves(session) { return allLegalMoves(internal(session).state); }
export function capturedPieces(session) {
  const data = internal(session), present = new Set(data.state.pieces.map(p => p.id));
  return clone(data.initial.filter(p => !present.has(p.id)));
}
export function restoreSession(puzzle, saved, options = {}) {
  invariant(saved?.schemaVersion === 1 && saved.puzzleId === puzzle.id && saved.puzzleVersion === puzzle.contentVersion &&
    Number.isInteger(saved.revision) && saved.revision >= 0 && Array.isArray(saved.moves), '存档版本/格式不匹配');
  const session = createSession(puzzle, options);
  for (const move of saved.moves) submitMove(session, move, { expectedRevision: internal(session).revision });
  const replayed = snapshot(internal(session));
  const canonical = pieces => JSON.stringify([...pieces].sort((a, b) => a.id - b.id));
  invariant(canonical(replayed.pieces) === canonical(saved.pieces) && replayed.turn === saved.turn &&
    replayed.redTurnsUsed === saved.redTurnsUsed && JSON.stringify(replayed.lastMove) === JSON.stringify(saved.lastMove), '存档局面与合法重放不一致');
  internal(session).revision = Math.max(saved.revision, replayed.revision) + 1;
  return session;
}
// TODO[DEV-01] 将现有 main.js/3D 动画接到此收据接口，完成网页集成回归。
// TODO[DEV-06] 控制器负责在撤销前使表现和对手任务的generation失效。
