import { allLegalMoves, nextPosition, terminalStatus, moveKey, invariant } from './position.js';
import { lookupSolution } from './solution-tree.js';

function checkCancelled(options) {
  if (options?.signal?.aborted) { const error = new Error('已取消'); error.name = 'AbortError'; throw error; }
}
export async function chooseDefense(context, options = {}) {
  checkCancelled(options);
  const { snapshot, solution, redTurnsRemaining } = context;
  invariant(snapshot.turn === 'black', '不是黑方回合');
  const proof = lookupSolution(solution, snapshot, redTurnsRemaining);
  if (proof.proofStatus !== 'proven') return chooseAfterWrongMove(context, options);
  const node = solution.nodes[proof.positionKey];
  if (!node.edges.length) return { kind: 'terminal', move: null, source: 'verifiedDefense', reason: 'checkmate' };
  const edge = [...node.edges].sort((a, b) => b.distance - a.distance || moveKey(a.move).localeCompare(moveKey(b.move)))[0];
  const move = allLegalMoves(snapshot).find(item => moveKey(item) === moveKey(edge.move));
  invariant(move, '验证防守已不合法');
  return { kind: 'move', move, source: 'verifiedDefense', reason: null };
}

/** 图外仅作有界合法应对，明确不宣称最佳防守。每批让出事件循环以响应取消。 */
export async function chooseAfterWrongMove(context, options = {}) {
  checkCancelled(options);
  const moves = allLegalMoves(context.snapshot);
  if (!moves.length) return { kind: 'terminal', move: null, source: 'searchFallback', reason: terminalStatus(context.snapshot).terminalReason };
  const values = { general: 10000, chariot: 900, cannon: 450, horse: 400, elephant: 200, advisor: 200, soldier: 100 };
  const budget = Math.max(1, Math.min(options.maxReplyChecks ?? 512, 4096));
  let checked = 0, best = moves[0], bestScore = -Infinity;
  for (const move of moves) {
    checkCancelled(options);
    const after = nextPosition(context.snapshot, move), status = terminalStatus(after);
    let score = status.over && status.winner === 'black' ? 100000 : 0;
    const captured = context.snapshot.pieces.find(p => p.row === move.to.row && p.col === move.to.col);
    score += captured ? values[captured.type] : 0;
    // 优先避免可见的一着杀，但达到预算不能据此证明安全/无解。
    for (const reply of allLegalMoves(after)) {
      if (checked++ >= budget) break;
      if (terminalStatus(nextPosition(after, reply)).terminalReason === 'checkmate') { score -= 20000; break; }
      if (checked % 24 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); checkCancelled(options); }
    }
    if (score > bestScore) { best = move; bestScore = score; }
    if (checked >= budget) break;
  }
  checkCancelled(options);
  return { kind: 'move', move: best, source: 'searchFallback', reason: '图外有界应对，不是强制杀棋证明' };
}
// TODO[DEV-05] 真机校准图外策略节点上限、让出间隔和取消延迟。
