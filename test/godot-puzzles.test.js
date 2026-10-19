import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadPuzzleCatalog } from '../godot-project/web/puzzle/loader.js';
import { createPuzzleController } from '../godot-project/web/puzzle/game/puzzle-controller.js';
import { createSession } from '../godot-project/web/puzzle/game/session.js';
import { lookupSolution } from '../godot-project/web/puzzle/game/solution-tree.js';
import { solvePuzzle } from '../godot-project/web/puzzle/game/solver.js';
import { defaultProgress, loadProgress, saveProgress, PROGRESS_KEY } from '../godot-project/web/puzzle/game/progress.js';

const base = new URL('../godot-project/web/puzzle/', import.meta.url);
const fetcher = async url => { try { return new Response(await readFile(url)); } catch { return new Response(null, {status:404}); } };
const catalog = await loadPuzzleCatalog({fetcher});
const make = (level = catalog.levels[0], ports = {}) => createPuzzleController({ ...level, developmentPreview:true, ...ports });
const winning = (controller, level) => {
  const state = controller.getViewState().snapshot;
  return lookupSolution(level.solution, state, level.puzzle.goal.maxRedTurns - state.redTurnsUsed).winningMoves[0];
};
const memory = () => {
  const values = new Map();
  return {values, async read(key) {return values.get(key) ?? null;}, async write(key,value) {values.set(key,value);}, async remove(key) {values.delete(key);}};
};

test('same eight candidate teaching previews; official publication approval is not fabricated', async () => {
  const manifest = JSON.parse(await readFile(new URL('source-manifest.json',base)));
  assert.equal(catalog.preview,true);
  assert.equal(catalog.levels.length,8);
  for (const {puzzle} of catalog.levels) {
    assert.equal(puzzle.status,'candidate');
    assert.equal(puzzle.verification.status,'passed');
    assert.match(puzzle.verification.verifiedBy,/独立复核待完成/);
    assert.throws(()=>createSession(puzzle),/显式启用/);
  }
  for (const entry of manifest.sourceFiles.filter(file=>!manifest.adaptedModules.includes(file.packaged))) {
    assert.equal(createHash('sha256').update(await readFile(new URL(entry.packaged,base))).digest('hex'),entry.sourceSha256,entry.packaged);
  }
  const sourceCatalog = JSON.parse(await readFile(new URL('data/previews/catalog.json',base)));
  assert.deepEqual(sourceCatalog.releaseIds,[]);
  assert.equal(await readFile(new URL('rules.js',base),'utf8'),await readFile(new URL('../rules.js',base),'utf8'));
});

for (const level of catalog.levels) test(`${level.puzzle.id}: recompute full proof and play actual red/black controller sequence`, async () => {
  const recomputed = solvePuzzle(level.puzzle);
  assert.equal(recomputed.status,'complete');
  assert.equal(recomputed.proofStatus,'proven');
  assert.deepEqual(recomputed.nodes,level.solution.nodes);
  assert.equal(recomputed.minRedTurnsToMate,level.puzzle.goal.maxRedTurns);
  const receipts = [], awards = [];
  const controller = make(level,{presentation:{async play(receipt){receipts.push(receipt);}},onComplete:award=>awards.push(award)});
  await controller.start();
  for (let count=0;count<10 && controller.getViewState().phase==='playerTurn';count++) await controller.playMove(winning(controller,level));
  const view = controller.getViewState();
  assert.equal(view.phase,'success');
  assert.equal(view.snapshot.redTurnsUsed,level.puzzle.goal.maxRedTurns);
  assert.equal(awards.length,1);
  assert.equal(receipts.length,2*level.puzzle.goal.maxRedTurns-1);
  for (const receipt of receipts) {
    assert.equal(receipt.after.moves.length,receipt.before.moves.length+1);
    assert.notEqual(receipt.before.turn,receipt.after.turn);
    assert.equal(receipt.after.revision,receipt.before.revision+1);
  }
  const beforeUndo=view.snapshot.moves.length;
  controller.undoRound();
  assert.equal(controller.getViewState().phase,'playerTurn');
  assert.equal(controller.getViewState().snapshot.moves.length,beforeUndo-1);
  controller.dispose();
});

test('digest, missing files, directory traversal, and unproved preview failures are surfaced', async () => {
  await assert.rejects(loadPuzzleCatalog({fetcher:async()=>new Response(null,{status:404})}),/加载失败/);
  const mutate = edit => async url => {
    const response=await fetcher(url);
    if (!String(url).endsWith('previews/preview-01.json')) return response;
    const puzzle=await response.json();edit(puzzle);return new Response(JSON.stringify(puzzle));
  };
  await assert.rejects(loadPuzzleCatalog({fetcher:mutate(p=>{p.solution.sha256='0'.repeat(64);})}),/摘要不匹配/);
  await assert.rejects(loadPuzzleCatalog({fetcher:mutate(p=>{p.solution.path='../secret.json';})}),/路径非法/);
  await assert.rejects(loadPuzzleCatalog({fetcher:mutate(p=>{p.verification.status='unverified';})}),/未通过/);
});

test('network and body interruptions name the resource; validation errors are not rewritten', async () => {
  const networkError = new TypeError('Failed to fetch');
  const broken = async url => {
    if (String(url).endsWith('previews/preview-07.json')) throw networkError;
    return fetcher(url);
  };
  await assert.rejects(loadPuzzleCatalog({fetcher:broken}),error => {
    assert.match(error.message,/网络连接失败：previews\/preview-07\.json，请重试/);
    assert.equal(error.cause,networkError);
    return true;
  });
  await assert.rejects(loadPuzzleCatalog({fetcher:async()=>({ok:true,arrayBuffer:async()=>{throw networkError;}})}),/读取中断：previews\/catalog\.json，请重试/);
});

test('catalog loading never exceeds three simultaneous connections and preserves all level ordering', async () => {
  let active=0,peak=0;
  const slow = async url => {
    active++;peak=Math.max(peak,active);
    try {await new Promise(resolve=>setTimeout(resolve,2));return await fetcher(url);}
    finally {active--;}
  };
  const loaded=await loadPuzzleCatalog({fetcher:slow});
  assert.equal(peak,3);assert.equal(active,0);
  assert.deepEqual(loaded.levels.map(entry=>entry.puzzle.id),catalog.levels.map(entry=>entry.puzzle.id));
});

test('three hints, demonstration, round undo, and preview save restore preserve stable state', async () => {
  const level=catalog.levels[2], awards=[], controller=make(level,{onComplete:a=>awards.push(a)});
  await controller.start();
  assert.equal(controller.requestHint().move,null);
  assert.ok(controller.requestHint().move);
  assert.equal(controller.requestHint().showDestination,true);
  const before=controller.getResumeEnvelope();
  await controller.startDemo();
  assert.equal(controller.getViewState().phase,'demonstrating');
  assert.equal(awards.length,0);
  controller.stopDemo();
  assert.deepEqual(controller.getViewState().snapshot.pieces,before.snapshot.pieces);
  assert.equal(controller.getViewState().hintsUsed,3);
  await controller.playMove(winning(controller,level));
  assert.equal(controller.getViewState().snapshot.moves.length,2);
  const storage=memory(), progress=defaultProgress();progress.resume=controller.getResumeEnvelope();
  assert.equal((await saveProgress(storage,progress)).saved,true);
  const loaded=await loadProgress(storage,catalog.levels.map(l=>l.puzzle),{developmentPreview:true});
  assert.equal(loaded.warnings.length,0);
  assert.ok(loaded.progress.resume);
  const restored=make(level);await restored.start(level.puzzle,level.solution,loaded.progress.resume);
  assert.deepEqual(restored.getViewState().snapshot.pieces,controller.getViewState().snapshot.pieces);
  restored.undoRound();assert.equal(restored.getViewState().snapshot.moves.length,0);
  controller.dispose();restored.dispose();
});

test('cancel during a final winning animation: refresh and resume each settle the real result', async () => {
  const level=catalog.levels[0], awards=[], resumedAwards=[];
  let release;
  const controller=make(level,{presentation:{play:()=>new Promise(resolve=>{release=resolve;})},onComplete:a=>awards.push(a)});
  await controller.start();const pending=controller.playMove(winning(controller,level));
  assert.equal(controller.getViewState().phase,'animating');
  const saved=controller.getResumeEnvelope();
  assert.equal(saved.phaseAfterRestore,'success');
  assert.equal(awards.length,0);
  controller.pause();release();await pending;
  await controller.resume();await controller.resume();
  assert.equal(controller.getViewState().phase,'success');assert.equal(awards.length,1);
  const restored=make(level,{onComplete:a=>resumedAwards.push(a)});
  await restored.start(level.puzzle,level.solution,saved);
  assert.equal(restored.getViewState().phase,'success');assert.equal(resumedAwards.length,1);
  restored.pause();await restored.resume();assert.equal(resumedAwards.length,1);
  await restored.startDemo();restored.stopDemo();assert.equal(resumedAwards.length,1);
  controller.dispose();restored.dispose();
});

test('late animation completion after retry cannot overwrite the new puzzle', async () => {
  const level=catalog.levels[0];let release;
  const controller=make(level,{presentation:{play:()=>new Promise(resolve=>{release=resolve;})}});
  await controller.start();const pending=controller.playMove(winning(controller,level));
  await assert.rejects(controller.playMove(level.puzzle.recommendedLine[0]),/不能落子/);
  await controller.retry();release();await pending;
  assert.equal(controller.getViewState().phase,'playerTurn');assert.equal(controller.getViewState().snapshot.moves.length,0);
  controller.dispose();
});

test('future progress stays protected, corrupt progress falls back to backup, saves serialize', async () => {
  const storage=memory(),first=defaultProgress(),second=defaultProgress();second.settings.audioEnabled=false;
  await Promise.all([saveProgress(storage,first),saveProgress(storage,second)]);
  assert.equal((await loadProgress(storage,[])).progress.settings.audioEnabled,false);
  storage.values.set(PROGRESS_KEY,'{broken');
  assert.equal((await loadProgress(storage,[])).progress.settings.audioEnabled,true);
  assert.ok(storage.values.has(PROGRESS_KEY+'.corrupt'));
  storage.values.set(PROGRESS_KEY,JSON.stringify({schemaVersion:99}));
  assert.equal((await loadProgress(storage,[])).readOnly,true);
  assert.equal((await saveProgress(storage,first)).saved,false);
  assert.equal(JSON.parse(storage.values.get(PROGRESS_KEY)).schemaVersion,99);
});
