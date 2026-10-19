/** RES-08: initial editorial hints never describe a different continuation branch. */
export const HINT_COPY={continuation:'观察当前黑将的逃路，以及己方棋子的控制范围。',unknown:'当前局面没有已验证的续胜提示，可悔棋或重试。',piece:'考虑移动高亮的{piece}。',destination:'将高亮的{piece}走到标记落点。'};
export function hintTexts(puzzle,snapshot,pieceName){
 return [snapshot.moves.length===0?(puzzle.hints[0]?.text||HINT_COPY.continuation):HINT_COPY.continuation,HINT_COPY.piece.replace('{piece}',pieceName),HINT_COPY.destination.replace('{piece}',pieceName)];
}
