import * as R from '../rules.js';

export const RULES_VERSION = 'xiangqi-bounded-v1';
const TYPES = { r: 'chariot', n: 'horse', b: 'elephant', a: 'advisor', k: 'general', c: 'cannon', p: 'soldier' };
const LETTERS = Object.fromEntries(Object.entries(TYPES).map(([letter, type]) => [type, letter]));
export const clone = value => JSON.parse(JSON.stringify(value));
export const opposite = color => color === R.RED ? R.BLACK : R.RED;
export const sameSquare = (a, b) => a?.row === b?.row && a?.col === b?.col;
export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
export function assertSquare(square) {
  invariant(square && Number.isInteger(square.row) && Number.isInteger(square.col) &&
    square.row >= 0 && square.row < 10 && square.col >= 0 && square.col < 9, '坐标越界');
}

/** FEN IDs按行扫描分配；关卡自带稳定ID时用棋盘内容比对，不能覆盖关卡ID。 */
export function parseFen(fen) {
  invariant(typeof fen === 'string', 'FEN必须是字符串');
  const fields = fen.trim().split(/\s+/);
  invariant(fields.length === 6 && /^[wb]$/.test(fields[1]) && fields[2] === '-' && fields[3] === '-' &&
    /^\d+$/.test(fields[4]) && /^[1-9]\d*$/.test(fields[5]), 'FEN字段无效');
  const rows = fields[0].split('/');
  invariant(rows.length === 10, 'FEN必须有10行');
  const pieces = [];
  rows.forEach((line, row) => {
    let col = 0;
    for (const char of line) {
      if (/^[1-9]$/.test(char)) col += Number(char);
      else {
        const lower = char.toLowerCase().replace('h', 'n').replace('e', 'b');
        invariant(TYPES[lower] && /^[a-zA-Z]$/.test(char), `FEN未知棋子 ${char}`);
        pieces.push({ id: pieces.length, type: TYPES[lower], color: char === char.toUpperCase() ? R.RED : R.BLACK, row, col });
        col++;
      }
      invariant(col <= 9, `FEN第${row + 1}行过宽`);
    }
    invariant(col === 9, `FEN第${row + 1}行不足9格`);
  });
  return { pieces, turn: fields[1] === 'w' ? R.RED : R.BLACK };
}

export function formatFen(position) {
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  invariant([R.RED, R.BLACK].includes(position.turn), '行棋方无效');
  for (const piece of position.pieces) {
    assertSquare(piece);
    invariant(LETTERS[piece.type] && [R.RED, R.BLACK].includes(piece.color), '棋子类型/阵营无效');
    invariant(!board[piece.row][piece.col], '棋子位置重叠');
    const letter = LETTERS[piece.type];
    board[piece.row][piece.col] = piece.color === R.RED ? letter.toUpperCase() : letter;
  }
  const rows = board.map(line => {
    let text = '', empty = 0;
    for (const letter of line) {
      if (!letter) empty++;
      else { if (empty) text += empty; empty = 0; text += letter; }
    }
    if (empty) text += empty;
    return text;
  });
  return `${rows.join('/')} ${position.turn === R.RED ? 'w' : 'b'} - - 0 1`;
}

/** 检查局面结构/静态落点，不声称可从标准开局到达。 */
export function assertPosition(position, { checkNonMovingSide = true } = {}) {
  invariant(position && Array.isArray(position.pieces) && position.pieces.length <= 32, '局面格式无效');
  invariant([R.RED, R.BLACK].includes(position.turn), '行棋方无效');
  const ids = new Set(), squares = new Set(), counts = {};
  const limits = { general: 1, advisor: 2, elephant: 2, horse: 2, chariot: 2, cannon: 2, soldier: 5 };
  for (const p of position.pieces) {
    assertSquare(p);
    invariant(Number.isInteger(p.id) && p.id >= 0 && !ids.has(p.id), '棋子ID无效或重复');
    invariant(LETTERS[p.type] && [R.RED, R.BLACK].includes(p.color), '棋子类型/阵营无效');
    ids.add(p.id);
    const square = `${p.row}:${p.col}`;
    invariant(!squares.has(square), '棋子位置重叠'); squares.add(square);
    const key = `${p.color}:${p.type}`;
    counts[key] = (counts[key] || 0) + 1;
    invariant(counts[key] <= limits[p.type], '子力数量超过规则上限');
    const r = p.color === R.RED ? 9 - p.row : p.row;
    if (p.type === 'general') invariant(r <= 2 && p.col >= 3 && p.col <= 5, '将帅必须在九宫内');
    if (p.type === 'advisor') invariant([[0, 3], [0, 5], [1, 4], [2, 3], [2, 5]].some(([a, b]) => a === r && b === p.col), '士落点无效');
    if (p.type === 'elephant') invariant([[0, 2], [0, 6], [2, 0], [2, 4], [2, 8], [4, 2], [4, 6]].some(([a, b]) => a === r && b === p.col), '象落点无效');
    if (p.type === 'soldier') invariant(r >= 3 && (r >= 5 || p.col % 2 === 0), '兵卒未过河落点无效');
  }
  invariant(counts['red:general'] === 1 && counts['black:general'] === 1, '双方必须各有一个将帅');
  const [a, b] = position.pieces.filter(p => p.type === 'general');
  invariant(a.col !== b.col || position.pieces.some(p => p.col === a.col && p.row > Math.min(a.row, b.row) && p.row < Math.max(a.row, b.row)), '初始局面将帅照面');
  if (checkNonMovingSide) invariant(!R.isInCheck(clone(position.pieces), opposite(position.turn)), '非行棋方不能处于被将军状态');
  return position;
}

/** 在独立数组上调用原规则，排除“吃将”终点；合法将死以对手无解将着判定。 */
export function allLegalMoves(position) {
  const pieces = clone(position.pieces);
  const result = [];
  for (const piece of pieces) {
    if (piece.color !== position.turn) continue;
    for (const to of R.legalMoves(pieces, piece)) {
      if (R.pieceAt(pieces, to.row, to.col)?.type === 'general') continue;
      result.push({ pieceId: piece.id, from: { row: piece.row, col: piece.col }, to });
    }
  }
  return result.sort((a, b) => a.from.row - b.from.row || a.from.col - b.from.col || a.to.row - b.to.row || a.to.col - b.to.col);
}
export function terminalStatus(position) {
  const check = R.isInCheck(clone(position.pieces), position.turn);
  const over = allLegalMoves(position).length === 0;
  return { check, over, terminalReason: !over ? 'none' : check ? 'checkmate' : 'stalemate', winner: over ? opposite(position.turn) : null };
}
export function nextPosition(position, move) {
  const state = { pieces: clone(position.pieces), turn: position.turn, history: [], lastMove: null };
  const piece = state.pieces.find(p => p.id === move.pieceId);
  R.applyMove(state, piece, move.to);
  return { pieces: state.pieces, turn: state.turn };
}
export const moveKey = move => `${move.from.row}${move.from.col}-${move.to.row}${move.to.col}`;
