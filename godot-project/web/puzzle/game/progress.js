import { clone, invariant } from './position.js';
import { restoreSession } from './session.js';
export const PROGRESS_KEY = 'chess-cn.progress.v1';
const queues = new WeakMap();
const protectedStores = new WeakSet();
export const defaultProgress = () => ({ schemaVersion: 1, records: {}, resume: null,
  settings: { audioEnabled: true, quality: 'auto', animationSpeed: 1 } });
const levelsOf = catalog => Array.isArray(catalog) ? catalog : catalog.levels || [];

export function migrateProgress(raw, targetVersion = 1, catalog = [], options = {}) {
  invariant(targetVersion === 1, '不支持的目标存档版本');
  invariant(raw && Number.isInteger(raw.schemaVersion), '存档版本缺失');
  if (raw.schemaVersion > targetVersion) { const error = new Error('存档来自更新版本，已保留原数据'); error.name = 'FutureVersionError'; throw error; }
  invariant(raw.schemaVersion === 1, '没有此旧版本的迁移规则');
  const result = defaultProgress();
  const levels = levelsOf(catalog), current = new Map(levels.map(p => [p.id, p]));
  for (const [id, record] of Object.entries(raw.records || {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !record || typeof record.completed !== 'boolean' ||
      !Number.isInteger(record.contentVersion) || record.contentVersion < 1 || !Number.isInteger(record.hintsUsed) || record.hintsUsed < 0 ||
      !(record.bestRedTurns === null || Number.isInteger(record.bestRedTurns) && record.bestRedTurns > 0)) continue;
    // 保留旧完成记录；只有当前版本匹配时才能解锁当前关卡。
    result.records[id] = clone(record);
  }
  const settings = raw.settings || {};
  if (typeof settings.audioEnabled === 'boolean') result.settings.audioEnabled = settings.audioEnabled;
  if (['auto', 'low', 'standard'].includes(settings.quality)) result.settings.quality = settings.quality;
  if ([0.5, 1, 1.5, 2].includes(settings.animationSpeed)) result.settings.animationSpeed = settings.animationSpeed;
  if (raw.resume) {
    const saved = raw.resume, puzzle = current.get(saved.snapshot?.puzzleId);
    try {
      invariant(puzzle && saved.snapshot.puzzleVersion === puzzle.contentVersion, '关卡已升级或删除');
      invariant(['playerTurn', 'opponentTurn', 'wrongMove', 'success', 'failure'].includes(saved.phaseAfterRestore) &&
        typeof saved.continuationAccepted === 'boolean' && Number.isInteger(saved.hintLevel) && saved.hintLevel >= 0 && saved.hintLevel <= 3 &&
        Number.isInteger(saved.hintsUsed) && saved.hintsUsed >= saved.hintLevel, '恢复意图损坏');
      restoreSession(puzzle, saved.snapshot, options);
      invariant(saved.phaseAfterRestore !== 'wrongMove' || saved.snapshot.turn === 'black' && !saved.continuationAccepted, '等待状态损坏');
      result.resume = clone(saved);
    } catch { result.resume = null; }
  }
  return result;
}

export async function loadProgress(storage, catalog, options = {}) {
  const warnings = [];
  let raw;
  try { raw = await storage.read(PROGRESS_KEY); }
  catch (error) { return { progress: defaultProgress(), warnings: [`读取失败：${error.message}`], readOnly: false }; }
  if (raw == null) return { progress: defaultProgress(), warnings, readOnly: false };
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const progress = migrateProgress(value, 1, catalog, options);
    protectedStores.delete(storage);
    if (value.resume && !progress.resume) warnings.push('旧棋局不兼容，已保留通关记录并重置该局');
    return { progress, warnings, readOnly: false };
  } catch (error) {
    if (error.name === 'FutureVersionError') {
      protectedStores.add(storage);
      return { progress: defaultProgress(), warnings: [error.message], readOnly: true };
    }
    warnings.push(`存档损坏：${error.message}`);
    try { await storage.write(`${PROGRESS_KEY}.corrupt`, typeof raw === 'string' ? raw : JSON.stringify(raw)); }
    catch (failure) { warnings.push(`备份失败：${failure.message}`); }
    try {
      const backup = await storage.read(`${PROGRESS_KEY}.backup`);
      if (backup != null) return { progress: migrateProgress(typeof backup === 'string' ? JSON.parse(backup) : backup, 1, catalog, options), warnings, readOnly: false };
    } catch (failure) { warnings.push(`备份不可读：${failure.message}`); }
    return { progress: defaultProgress(), warnings, readOnly: false };
  }
}

/** 按调用顺序持久化；未来版本保护；失败不阻断当前游戏。 */
export async function saveProgress(storage, progress) {
  if (protectedStores.has(storage)) return { saved: false, error: '较新版本存档受到保护，未覆盖' };
  const encoded = JSON.stringify(clone(progress));
  const previousTask = queues.get(storage) || Promise.resolve();
  const pending = previousTask.catch(() => {}).then(async () => {
    if (protectedStores.has(storage)) return { saved: false, error: '存档受到保护' };
    try {
      const old = await storage.read(PROGRESS_KEY);
      if (old != null) {
        try {
          const decoded = typeof old === 'string' ? JSON.parse(old) : old;
          if (decoded.schemaVersion > 1) { protectedStores.add(storage); return { saved: false, error: '较新版本存档受到保护' }; }
          if (decoded.schemaVersion === 1) await storage.write(`${PROGRESS_KEY}.backup`, typeof old === 'string' ? old : JSON.stringify(old));
        } catch (error) { if (error instanceof SyntaxError) { /* 原始坏数据留给load隔离 */ } else throw error; }
      }
      await storage.write(PROGRESS_KEY, encoded); return { saved: true, error: null };
    } catch (error) { return { saved: false, error: error.message }; }
  });
  queues.set(storage, pending); return pending;
}
// TODO[DEV-07] 平台集成与真实存储失败恢复验收尚待完成。

/** 用户主动清除时解除未来版本保护，并等待已发起的写入完成。 */
export async function clearProgress(storage) {
  await (queues.get(storage)||Promise.resolve()).catch(()=>{});
  for(const suffix of ['', '.backup', '.corrupt'])await storage.remove(PROGRESS_KEY+suffix);
  protectedStores.delete(storage);queues.delete(storage);
}
