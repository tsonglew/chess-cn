import { boundedKey } from './solver.js';
import { allLegalMoves, nextPosition, terminalStatus, moveKey, invariant, RULES_VERSION, clone } from './position.js';

export const positionKey = (snapshot, remaining, rulesVersion = RULES_VERSION, goalKind = 'checkmate') => boundedKey(snapshot, remaining, goalKind, rulesVersion);

/** 重放整个证明图，验证边、预算和完整黑方防守；摘要在平台加载器校验。 */
export function loadSolution(artifact, puzzle) {
  invariant(artifact?.schemaVersion === 1 && artifact.puzzleId === puzzle.id && artifact.contentVersion === puzzle.contentVersion &&
    artifact.rulesVersion === RULES_VERSION && artifact.status === 'complete' && artifact.proofStatus === 'proven', '解法版本或证明状态无效');
  const rootKey = positionKey(puzzle.initialPosition, puzzle.goal.maxRedTurns, artifact.rulesVersion, puzzle.goal.kind);
  invariant(rootKey === artifact.rootKey && artifact.nodes?.[rootKey], '解法根节点不匹配');
  const visited = new Set();
  function verify(position, remaining) {
    const key = positionKey(position, remaining, artifact.rulesVersion, puzzle.goal.kind);
    if (visited.has(key)) return;
    const node = artifact.nodes[key];
    invariant(node?.proofStatus === 'proven' && Array.isArray(node.edges), '解法含未证明节点');
    visited.add(key);
    const legal = allLegalMoves(position), status = terminalStatus(position);
    invariant(node.legalMoveCount === legal.length, '解法合法走法数量不一致');
    if (status.over) {
      invariant(position.turn === 'black' && status.terminalReason === 'checkmate' && node.terminalReason === 'checkmate' && node.edges.length === 0, '解法终叶不满足将死目标'); return;
    }
    invariant(remaining > 0 && node.edges.length > 0, '解法预算耗尽或没有续着');
    const seen = new Set();
    for (const edge of node.edges) {
      const name = moveKey(edge.move);
      invariant(!seen.has(name), '解法重复走法'); seen.add(name);
      const move = legal.find(item => moveKey(item) === name);
      invariant(move, '解法包含非法走法');
      const child = nextPosition(position, move), nextBudget = remaining - (position.turn === 'red' ? 1 : 0);
      invariant(edge.key === positionKey(child, nextBudget, artifact.rulesVersion, puzzle.goal.kind), '解法子节点/预算不匹配');
      verify(child, nextBudget);
    }
    if (position.turn === 'black') invariant(seen.size === legal.length, '解法遗漏黑方合法防守');
  }
  verify(puzzle.initialPosition, puzzle.goal.maxRedTurns);
  // 完整红方解集由离线重算校验，不能仅凭图结构断言没有其他胜解。
  return clone(artifact);
}
export function lookupSolution(solution, snapshot, remaining) {
  const key = positionKey(snapshot, remaining, solution.rulesVersion, 'checkmate');
  const node = solution.nodes[key];
  const map = edge => {
    const piece = snapshot.pieces.find(p => p.row === edge.move.from.row && p.col === edge.move.from.col);
    invariant(piece, '解法走法无对应棋子');
    return { pieceId: piece.id, ...clone(edge.move) };
  };
  return { proofStatus: node?.proofStatus || 'unknown', positionKey: key,
    winningMoves: snapshot.turn === 'red' ? (node?.edges || []).map(map) : [],
    defensiveMoves: snapshot.turn === 'black' ? (node?.edges || []).map(map) : [],
    minRedTurnsToMate: node?.distance ?? null };
}
// TODO[DEV-03] 正式关卡需独立内容复核和全解集离线重算，结构验图不代替数学证明。
