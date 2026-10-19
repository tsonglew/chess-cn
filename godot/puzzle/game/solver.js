import * as R from '../rules.js';
import { allLegalMoves, nextPosition, formatFen, clone, moveKey, RULES_VERSION } from './position.js';

export function boundedKey(position, remaining, kind = 'checkmate', rulesVersion = RULES_VERSION) {
  return `${formatFen(position).split(' - - ')[0]}|${remaining}|${kind}|${rulesVersion}`;
}

/** 完整OR解集/AND防守证明；任何资源上限使整次生成incomplete，不发布部分证明。 */
export function solvePuzzle(puzzle, { maxNodes = 500000, timeMs = 30000, signal } = {}) {
  const started = Date.now(), memo = new Map();
  let visited = 0;
  const stats = () => ({ visited, cached: memo.size, elapsedMs: Date.now() - started, maxNodes, timeMs });
  function visit(position, remaining) {
    const key = boundedKey(position, remaining, puzzle.goal.kind);
    if (memo.has(key)) return memo.get(key);
    if (signal?.aborted) throw new Error('cancelled');
    if (++visited > maxNodes) throw new Error('nodeLimit');
    if (Date.now() - started > timeMs) throw new Error('timeLimit');
    const moves = allLegalMoves(position);
    const check = R.isInCheck(clone(position.pieces), position.turn);
    let node;
    if (!moves.length) {
      const success = position.turn === R.BLACK && check && puzzle.goal.kind === 'checkmate';
      node = { proofStatus: success ? 'proven' : 'disproven', distance: success ? 0 : null,
        terminalReason: check ? 'checkmate' : 'stalemate', edges: [], legalMoveCount: 0 };
    } else if (remaining <= 0) {
      node = { proofStatus: 'disproven', distance: null, terminalReason: 'turnLimit', edges: [], legalMoveCount: moves.length };
    } else if (position.turn === R.RED) {
      const edges = [];
      for (const move of moves) {
        const child = nextPosition(position, move);
        const result = visit(child, remaining - 1);
        if (result.proofStatus === 'proven') edges.push({ move: { from: move.from, to: move.to }, key: boundedKey(child, remaining - 1, puzzle.goal.kind), distance: result.distance + 1 });
      }
      node = { proofStatus: edges.length ? 'proven' : 'disproven', distance: edges.length ? Math.min(...edges.map(e => e.distance)) : null,
        terminalReason: 'none', edges, legalMoveCount: moves.length };
    } else {
      const edges = [];
      let disproven = false;
      for (const move of moves) {
        const child = nextPosition(position, move);
        const result = visit(child, remaining);
        if (result.proofStatus !== 'proven') { disproven = true; break; } // 一个反例即可反驳AND。
        edges.push({ move: { from: move.from, to: move.to }, key: boundedKey(child, remaining, puzzle.goal.kind), distance: result.distance });
      }
      node = { proofStatus: disproven ? 'disproven' : 'proven', distance: disproven ? null : Math.max(...edges.map(e => e.distance)),
        terminalReason: 'none', edges: disproven ? [] : edges, legalMoveCount: moves.length };
    }
    memo.set(key, node);
    return node;
  }
  try {
    const initial = clone(puzzle.initialPosition), remaining = puzzle.goal.maxRedTurns;
    const rootKey = boundedKey(initial, remaining, puzzle.goal.kind);
    const root = visit(initial, remaining);
    const nodes = {};
    function collect(key) {
      if (nodes[key]) return;
      const node = memo.get(key); nodes[key] = clone(node);
      for (const edge of node.edges) collect(edge.key);
    }
    collect(rootKey);
    return { status: 'complete', proofStatus: root.proofStatus, minRedTurnsToMate: root.distance,
      rulesVersion: RULES_VERSION, rootKey, nodes, ...stats() };
  } catch (error) {
    if (!['cancelled', 'nodeLimit', 'timeLimit'].includes(error.message)) throw error;
    return { status: 'incomplete', proofStatus: 'unknown', reason: error.message, ...stats() };
  }
}

export function recommendedLine(solution, initial) {
  let position = clone(initial), key = solution.rootKey;
  const line = [];
  for (let guard = 0; guard < 100; guard++) {
    const node = solution.nodes[key];
    if (!node?.edges.length) return line;
    const edges = [...node.edges].sort((a, b) => (position.turn === R.RED ? a.distance - b.distance : b.distance - a.distance) || moveKey(a.move).localeCompare(moveKey(b.move)));
    const edge = edges[0], piece = position.pieces.find(p => p.row === edge.move.from.row && p.col === edge.move.from.col);
    const move = { pieceId: piece.id, ...clone(edge.move) };
    line.push(move); position = nextPosition(position, move); key = edge.key;
  }
  throw new Error('解法图出现未受预算约束的循环');
}
