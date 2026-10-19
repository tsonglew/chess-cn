/**
 * Run inside the goal's existing ego-browser TaskSpace; never starts a browser.
 * Example (an agent-created p2 must already exist):
 *   const page = (await taskSpace(SPACE_ID)).page('p2');
 *   const {runGodotAcceptance} = await import('file:///absolute/repo/tools/godot-browser-acceptance.mjs');
 *   console.log(await runGodotAcceptance(page, {url:'http://127.0.0.1:8000/godot/?test=1'}));
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clone = value => JSON.parse(JSON.stringify(value));
const board = state => state.pieces.map(({id, type, color, row, col}) => ({id, type, color, row, col})).sort((a, b) => a.id - b.id);
const types = ['advisor', 'cannon', 'chariot', 'elephant', 'general', 'horse', 'soldier'];

export async function runGodotAcceptance(page, {
  url = 'http://127.0.0.1:8000/godot/?test=1',
  tag = 'local',
  output = resolve(root, 'output/godot-validation'),
  reportPath = resolve(root, `docs/reports/godot-browser-${tag}.json`),
} = {}) {
  assert.ok(new URL(url).searchParams.get('test') === '1', 'deterministic acceptance requires ?test=1');
  await mkdir(output, {recursive: true});
  await mkdir(resolve(root, 'docs/reports'), {recursive: true});
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), url,
    scope: 'Desktop browser functionality and imported skeletal animation. Not mobile/device acceptance or a cross-engine performance claim.',
    checks: [], screenshots: [], samples: {}, passed: false,
  };
  const capture = async name => {
    const path = resolve(output, `${tag}-${name}.png`);
    await page.screenshot({path});
    report.screenshots.push(path);
  };
  const state = () => page.evaluate(() => window.godotTest.state());
  const call = (method, ...args) => page.evaluate(({method, args}) => window.godotTest[method](...args), {method, args});
  const advance = async ms => {
    await call('advanceTime', ms);
    return state();
  };
  try {
    await page.cdp('Network.enable');
    await page.cdp('Network.setCacheDisabled', {cacheDisabled: true});
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', {source: `
      window.__godotQaErrors = [];
      const record = message => { const text = String(message); if (!window.__godotQaErrors.includes(text)) window.__godotQaErrors.push(text); };
      addEventListener('error', event => record(event.message || event.error));
      addEventListener('unhandledrejection', event => record(event.reason?.stack || event.reason));
      const originalError = console.error;
      console.error = (...args) => { record(args.map(value => String(value)).join(' ')); originalError.apply(console, args); };
    `});
    const started = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => window.godotTest?.state().runtimeReady || window.godotTest?.state().error, undefined, {timeout: 120000});
    report.readyElapsedMs = Date.now() - started;
    await call('inspect');
    await advance(0);
    const initial = await state();
    assert.ok(initial.runtimeReady, initial.error || 'runtime did not become ready');
    assert.equal(initial.testMode, true);
    assert.equal(initial.pieces.length, 32);
    assert.deepEqual([...new Set(initial.pieces.map(piece => piece.type))].sort(), types);
    assert.equal(initial.turn, 'red');
    assert.equal(initial.historyLength, 0);
    assert.equal(initial.phase, 'ready');
    assert.equal(initial.metrics.pieces, 32, 'Godot has instantiated all 32 visual pieces');
    assert.equal(initial.metrics.visualPieces.length, 32);
    assert.deepEqual([...initial.metrics.imports.types].sort(), types);
    assert.equal(initial.metrics.imports.soldier.bones, 20);
    assert.match(initial.metrics.imports.soldier.clip, /SoldierThrust/);
    assert.ok(Math.abs(initial.metrics.imports.soldier.duration - 1.2) < 1e-5);
    assert.ok(initial.metrics.imports.soldier.trackCount >= 4, 'imported AnimationPlayer retains multiple skeletal tracks (Godot removes constant channels)');
    report.samples.initial = initial;
    report.build = await page.evaluate(async () => {
      const response = await fetch('./build-manifest.json', {cache: 'no-store'});
      if (!response.ok) throw new Error(`Build manifest HTTP ${response.status}`);
      return response.json();
    });
    assert.equal(report.build.renderer, 'gl_compatibility');
    assert.equal(report.build.variant, 'web_nothreads_release');
    report.checks.push('32 pieces, seven piece types, initial red turn');

    report.browser = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        crossOriginIsolated,
        webAssembly: typeof WebAssembly === 'object',
        webgl2: Boolean(gl),
        renderer: gl?.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        vendor: gl?.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
        canvas: canvas && {width: canvas.width, height: canvas.height},
        resources: performance.getEntriesByType('resource')
          .filter(entry => /\.(?:wasm|pck)(?:\?|$)/.test(entry.name))
          .map(entry => ({url: entry.name, durationMs: entry.duration, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize})),
      };
    });
    assert.equal(report.browser.webAssembly, true);
    assert.equal(report.browser.webgl2, true, 'Godot must have acquired WebGL2 on its visible canvas');
    const base = new URL('.', url).href;
    assert.ok(report.browser.resources.some(resource => /\.wasm(?:\?|$)/.test(resource.url)), 'loaded WASM resource');
    assert.ok(report.browser.resources.some(resource => /\.pck(?:\?|$)/.test(resource.url)), 'loaded Godot PCK resource');
    assert.ok(report.browser.resources.every(resource => resource.url.startsWith(base)), 'export resources resolve inside the /godot/ subdirectory');
    report.checks.push('real WebAssembly and WebGL2 canvas; PCK/WASM resolve under /godot/');

    for (const view of ['iso', 'top', 'front', 'side']) {
      await call('view', view);
      await advance(0);
      const current = await state();
      assert.equal(current.camera, view);
      assert.deepEqual(board(current), board(initial), 'camera control must not change the position');
      await capture(`board-${view}`);
    }
    await call('labels', false);
    await call('view', 'top');
    await advance(0);
    await capture('board-top-no-labels');
    await call('labels', true);
    report.checks.push('four camera views and label-free top-view screenshots captured for visual review');

    await call('select', 6, 0);
    const selected = await state();
    assert.deepEqual(selected.legalMoves.map(({row, col}) => ({row, col})), [{row: 5, col: 0}], 'uncrossed soldier only advances');
    await call('move', 6, 1);
    const illegal = await state();
    assert.deepEqual(board(illegal), board(initial), 'illegal sideways soldier move is rejected');
    assert.equal(illegal.historyLength, 0);
    await call('select', 6, 0);
    await call('move', 5, 0);
    await advance(1400);
    const moved = await state();
    assert.equal(moved.phase, 'ready');
    assert.equal(moved.turn, 'black');
    assert.equal(moved.historyLength, 1);
    assert.ok(moved.pieces.some(piece => piece.type === 'soldier' && piece.color === 'red' && piece.row === 5 && piece.col === 0));
    await call('undo');
    await advance(0);
    assert.deepEqual(board(await state()), board(initial), 'undo restores the opening position');
    await call('restart');
    await advance(0);
    assert.equal((await state()).historyLength, 0);
    report.checks.push('legal move, illegal move rejection, turn change, undo and restart');

    for (const color of ['red', 'black']) {
      await call('demo', color);
      await advance(0);
      const start = await state();
      const windup = await advance(566.6667);
      const impact = await advance(16.6667);
      for (const view of ['iso', 'top', 'front', 'side']) {
        await call('view', view);
        await advance(0);
        await capture(`${color}-${view}-impact`);
      }
      const complete = await advance(1000);
      report.samples[color] = {start: clone(start), windup: clone(windup), impact: clone(impact), complete: clone(complete)};
      assert.match(start.animation.clip, /SoldierThrust/);
      assert.ok(windup.animation.time > .55 && windup.animation.time < .58, 'windup sample immediately before impact');
      assert.ok(impact.animation.time >= .58 && impact.animation.time < .60, 'impact sample immediately after threshold');
      assert.equal(windup.metrics.targetVisualAlive, true, 'victim remains before 0.58 seconds');
      assert.equal(impact.metrics.targetVisualAlive, false, 'victim is hidden after 0.58 seconds');
      assert.equal(impact.metrics.bones.count, 20);
      const restPoses = new Map(start.metrics.bones.poses.map(pose => [pose.name, pose.rotation]));
      const changedBones = impact.metrics.bones.poses.filter(pose => pose.rotation.some((value, i) => Math.abs(value - restPoses.get(pose.name)[i]) > .001));
      assert.ok(changedBones.length >= 3, 'imported clip must change multiple Skeleton3D joints');
      report.samples[color].changedBonesAtImpact = changedBones.map(pose => pose.name);
      assert.equal(complete.phase, 'ready');
      assert.equal(complete.historyLength, 1);
      assert.equal(complete.pieces.length, 3);
      await call('undo');
      await advance(0);
      const undone = await state();
      assert.equal(undone.pieces.length, 4);
      assert.equal(undone.historyLength, 0);
      assert.equal(undone.animation.phase, 'idle', 'undo clears the completed animation display');
      assert.equal(undone.animation.time, 0);
      assert.equal(undone.metrics.visualPieces.filter(piece => piece.visible).length, 4, 'undo visually restores the captured piece');
      report.samples[color].undone = undone;
      report.checks.push(`${color}: soldier demo completes and undo restores the victim`);
    }

    await call('restart');
    await call('view', 'iso');
    await advance(0);
    const end = await state();
    assert.deepEqual(board(end), board(initial));
    report.errors = await page.evaluate(() => [...new Set([...(window.__godotQaErrors || []), ...(window.godotTest.state().errors || [])])]);
    assert.deepEqual(report.errors, [], 'no browser or engine errors');
    report.checks.push('reset to initial board; no captured browser/engine errors');
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || error.message;
    report.samples.failure = await state().catch(() => null);
    report.errors = await page.evaluate(() => window.__godotQaErrors || []).catch(() => []);
    await capture('failure').catch(() => {});
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return {passed: report.passed, checks: report.checks, failure: report.failure, reportPath, screenshots: report.screenshots};
}

/** A bounded real-time sample, deliberately separate from deterministic tests. */
export async function sampleGodotRealtime(page, {
  url = 'http://127.0.0.1:8000/godot/',
  tag = 'local',
  durationMs = 10000,
  warmupFrames = 0,
  reportPath = resolve(root, `docs/reports/godot-performance-${tag}.json`),
} = {}) {
  const target = new URL(url);
  target.searchParams.delete('test');
  await page.goto(target.href);
  await page.waitForFunction(() => window.godotTest?.state().runtimeReady, undefined, {timeout: 120000});
  if (warmupFrames > 0) await page.waitForFunction(frames => window.godotTest.state().metrics.frames > frames, warmupFrames, {timeout: 30000});
  await page.evaluate(() => window.godotTest.inspect());
  const before = await page.evaluate(() => window.godotTest.state());
  assert.equal(before.testMode, false, 'performance must use the ordinary real-time clock');
  assert.equal(before.metrics.manualClock, false);
  assert.equal(before.pieces.length, 32);
  const sample = await page.evaluate(durationMs => new Promise((resolve, reject) => {
    const intervals = [];
    const metrics = [];
    const visibilityStates = new Set([document.visibilityState]);
    let first, last, lastMetricFrame, lastState;
    let nextMetricAt = 0;
    const timeout = setTimeout(() => reject(new Error('Real-time sample exceeded its bound; tab may be inactive.')), durationMs + 12000);
    const step = time => {
      if (first === undefined) first = time;
      if (last !== undefined) intervals.push(time - last);
      last = time;
      visibilityStates.add(document.visibilityState);
      // Do not serialize game state every display frame: it would add work to
      // the quantity being measured. Engine metrics are sampled once a second.
      if (time - first >= nextMetricAt) {
        lastState = window.godotTest.state();
        nextMetricAt += 1000;
        if (lastState.metrics.frames !== lastMetricFrame) {
          lastMetricFrame = lastState.metrics.frames;
          metrics.push({elapsedMs: time - first, fps: lastState.metrics.fps, frames: lastState.metrics.frames, drawCalls: lastState.metrics.drawCalls, primitives: lastState.metrics.primitives, objects: lastState.metrics.objects});
        }
      }
      if (time - first >= durationMs) {
        clearTimeout(timeout);
        const gl = document.querySelector('canvas').getContext('webgl2');
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        resolve({
          durationMs: time - first, intervals, metrics, visibilityStates: [...visibilityStates],
          userAgent: navigator.userAgent, platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio},
          renderer: gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
          vendor: gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
          manualClock: lastState.metrics.manualClock, pieces: lastState.pieces.length,
        });
      } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), durationMs);
  assert.deepEqual(sample.visibilityStates, ['visible'], 'background tabs cannot establish visible rendering performance');
  assert.equal(sample.manualClock, false);
  const ordered = [...sample.intervals].sort((a, b) => a - b);
  const percentile = p => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))];
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), url: target.href,
    scope: 'One visible desktop Chromium tab, 32-piece idle board, ordinary real-time rendering. RequestAnimationFrame intervals describe observed display delivery; not GPU timings, mobile validation, sustained stress, or evidence that Godot is faster than Three.js.',
    passed: true,
    warmup: {frameThreshold: warmupFrames, observedFramesBeforeSample: before.metrics.frames},
    ...sample,
    summary: {
      frames: sample.intervals.length,
      observedFrameRate: sample.intervals.length / (sample.durationMs / 1000),
      medianFrameMs: percentile(.5), p95FrameMs: percentile(.95), p99FrameMs: percentile(.99),
      longestFrameMs: ordered.at(-1),
      intervalsOver20ms: sample.intervals.filter(value => value > 20).length,
      intervalsOver50ms: sample.intervals.filter(value => value > 50).length,
      note: '20 ms threshold is a 60 Hz frame budget plus 20% tolerance; it is not a hardware refresh-rate measurement.',
    },
  };
  report.build = await page.evaluate(async () => {
    const response = await fetch('./build-manifest.json', {cache: 'no-store'});
    if (!response.ok) throw new Error(`Build manifest HTTP ${response.status}`);
    return response.json();
  });
  await mkdir(resolve(root, 'docs/reports'), {recursive: true});
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {reportPath, ...report.summary, renderer: report.renderer};
}

/** Control measurement to distinguish browser scheduling from scene workload. */
export async function sampleBrowserRafBaseline(page, {
  durationMs = 3000,
  reportPath = resolve(root, 'docs/reports/godot-browser-raf-baseline.json'),
} = {}) {
  await page.goto('about:blank');
  const sample = await page.evaluate(durationMs => new Promise((resolve, reject) => {
    const intervals = [];
    const visibility = new Set([document.visibilityState]);
    let first, last;
    const timer = setTimeout(() => reject(new Error('Blank-page frame baseline timed out.')), durationMs + 10000);
    const step = time => {
      if (first === undefined) first = time;
      if (last !== undefined) intervals.push(time - last);
      last = time;
      visibility.add(document.visibilityState);
      if (time - first >= durationMs) {
        clearTimeout(timer);
        resolve({durationMs: time - first, intervals, visibility: [...visibility], userAgent: navigator.userAgent, viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio}});
      } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), durationMs);
  assert.deepEqual(sample.visibility, ['visible']);
  const sorted = [...sample.intervals].sort((a, b) => a - b);
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), passed: true,
    scope: 'Visible about:blank requestAnimationFrame baseline in the same browser page after the Godot sample. This only measures scheduling and does not isolate other system workloads.',
    ...sample,
    summary: {frames: sample.intervals.length, observedFrameRate: sample.intervals.length / (sample.durationMs / 1000), medianFrameMs: sorted[Math.floor(sorted.length * .5)], p95FrameMs: sorted[Math.floor(sorted.length * .95)], longestFrameMs: sorted.at(-1)},
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {reportPath, ...report.summary};
}
