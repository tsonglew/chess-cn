import { loadSolution } from './game/solution-tree.js';
import { assertPosition, formatFen, invariant, RULES_VERSION } from './game/position.js';
import { sha256 } from './game/sha256.js';

/** Same self-authored teaching previews as the Three.js entry, with unchanged content status. */
export async function loadPuzzleCatalog({ fetcher = globalThis.fetch, baseUrl = new URL('./data/', import.meta.url) } = {}) {
  async function read(relative) {
    let response;
    try { response = await fetcher(new URL(relative, baseUrl)); }
    catch (cause) { throw new Error(`残局资源网络连接失败：${relative}，请重试`, {cause}); }
    if (!response.ok) throw new Error(`残局资源加载失败：${relative} (${response.status})`);
    try { return new Uint8Array(await response.arrayBuffer()); }
    catch (cause) { throw new Error(`残局资源读取中断：${relative}，请重试`, {cause}); }
  }
  const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));
  const catalog = decode(await read('previews/catalog.json'));
  invariant(catalog.schemaVersion === 1 && catalog.status === 'development-preview' &&
    Array.isArray(catalog.previewIds) && catalog.previewIds.length > 0 &&
    Array.isArray(catalog.releaseIds) && catalog.releaseIds.length === 0, '教学预览目录无效');
  invariant(new Set(catalog.previewIds).size === catalog.previewIds.length, '残局目录 ID 重复');
  async function loadLevel(id) {
    invariant(/^[a-z][a-z0-9-]*$/.test(id), '关卡 ID 非法');
    const puzzle = decode(await read(`previews/${id}.json`));
    invariant(puzzle.id === id && puzzle.status === 'candidate' && puzzle.verification?.status === 'passed' &&
      puzzle.verification.rulesVersion === RULES_VERSION && puzzle.verification.allDefensesCovered === true &&
      puzzle.verification.allWinningMovesCovered === true && puzzle.verification.shortestMateVerified === true &&
      puzzle.sources?.some(source => source.reviewStatus === 'selfAuthored'), '关卡未通过教学预览自动验证');
    invariant(puzzle.goal?.kind === 'checkmate' && Number.isInteger(puzzle.goal.maxRedTurns) &&
      puzzle.goal.maxRedTurns > 0 && puzzle.verification.minRedTurnsToMate === puzzle.goal.maxRedTurns, '残局目标无效');
    assertPosition(puzzle.initialPosition);
    invariant(formatFen(puzzle.initialPosition) === puzzle.initialFen, '残局 FEN 与棋子局面不一致');
    invariant(puzzle.solution?.path === `puzzles/solutions/${id}.json`, '解法路径非法');
    const bytes = await read(`solutions/${id}.json`);
    invariant(sha256(bytes) === puzzle.solution.sha256, `解法摘要不匹配：${id}`);
    const solution = loadSolution(decode(bytes), puzzle);
    invariant(solution.rootKey === puzzle.solution.rootKey, '解法根摘要不匹配');
    return { puzzle, solution };
  }
  // Bound outstanding connections on simple static servers; preserve catalog order.
  // Failed resources/data remain errors rather than being skipped or silently retried.
  const levels = [];
  for (let index = 0; index < catalog.previewIds.length; index += 3) {
    levels.push(...await Promise.all(catalog.previewIds.slice(index, index + 3).map(loadLevel)));
  }
  return { levels, preview: true };
}
