/**
 * Visual/framing evidence for the battlefield pass. Runs in an existing ego
 * TaskSpace page; the caller owns browser lifecycle and visible performance QA.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function runBattlefieldFraming(page, {
  url = 'http://127.0.0.1:8000/godot/?test=1',
  tag = 'local',
  output = resolve(root, 'output/godot-battlefield'),
  reportPath = resolve(root, `docs/reports/godot-battlefield-framing-${tag}.json`),
  viewports = [{width:1440, height:960}, {width:1100, height:800}],
} = {}) {
  assert.equal(new URL(url).searchParams.get('test'), '1');
  await mkdir(output, {recursive:true});
  const report = {
    schemaVersion:1, generatedAt:new Date().toISOString(), url,
    scope:'Desktop framing and screenshots for human visual review. Projected piece feet and head positions test framing, not full silhouette occlusion or mobile compatibility.',
    samples:[], assetChecks:[], passed:false,
  };
  try {
    const manifest = JSON.parse(await readFile(resolve(root, 'godot-project/asset-manifest.json'), 'utf8'));
    for (const model of manifest.models) {
      const bytes = await readFile(resolve(root, 'godot-project', model.godotResource));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, model.sha256, `${model.type} GLB still matches the existing Three.js model`);
      report.assetChecks.push({type:model.type, sha256, unchanged:true});
    }
    await page.cdp('Network.enable');
    await page.cdp('Network.setCacheDisabled', {cacheDisabled:true});
    for (const viewport of viewports) {
      await page.cdp('Emulation.setDeviceMetricsOverride', {...viewport, deviceScaleFactor:1, mobile:false});
      await page.goto(url);
      await page.waitForFunction(() => window.godotTest?.state().runtimeReady || window.godotTest?.state().error, undefined, {timeout:120000});
      assert.ok(await page.evaluate(() => window.godotTest.state().runtimeReady));
      for (const view of ['iso', 'top', 'front', 'side']) {
        const sample = await page.evaluate(async view => {
          window.godotTest.restart();
          window.godotTest.view(view);
          window.godotTest.labels(view !== 'top');
          await window.advanceTime(0);
          const state = window.godotTest.state();
          const canvas = document.querySelector('canvas');
          const rect = canvas.getBoundingClientRect();
          const {viewport, drawCalls, primitives, objects, focused, cameraTarget, battlefield} = state.metrics;
          const visualPieces = state.metrics.visualPieces.map(({id, type, color, visible, screen, headScreen}) => ({id, type, color, visible, screen, headScreen}));
          return {view, metrics:{viewport, drawCalls, primitives, objects, focused, cameraTarget, battlefield, visualPieces}, errors:state.errors, canvas:{width:canvas.width,height:canvas.height,cssWidth:rect.width,cssHeight:rect.height}, body:{scrollWidth:document.body.scrollWidth,viewportWidth:innerWidth}};
        }, view);
        assert.equal(sample.metrics.visualPieces.length, 32);
        assert.deepEqual(sample.errors, []);
        assert.ok(sample.body.scrollWidth <= sample.body.viewportWidth + 1, 'no horizontal page overflow');
        const [width, height] = sample.metrics.viewport;
        sample.minimumFrameMarginPx = Math.min(...sample.metrics.visualPieces.flatMap(piece => [piece.screen, piece.headScreen]).flatMap(([x,y]) => [x,y,width-x,height-y]));
        assert.ok(sample.minimumFrameMarginPx >= 4, `${view} at ${viewport.width}x${viewport.height}: piece feet/head clipped by viewport`);
        const screenshot = resolve(output, `${tag}-${viewport.width}x${viewport.height}-${view}.png`);
        await page.screenshot({path:screenshot});
        report.samples.push({...sample, viewport, screenshot});
      }
    }
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
  } finally {
    await page.cdp('Emulation.clearDeviceMetricsOverride');
    await mkdir(resolve(reportPath, '..'), {recursive:true});
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return {passed:report.passed, reportPath, failure:report.failure, assetsUnchanged:report.assetChecks.length, samples:report.samples.map(({view,viewport,minimumFrameMarginPx,screenshot}) => ({view,viewport,minimumFrameMarginPx,screenshot}))};
}

/** Re-sample an already warm scene without navigation or WebAssembly startup. */
export async function sampleLoadedBattlefield(page, {
  tag = 'warm', durationMs = 10000,
  reportPath = resolve(root, `docs/reports/godot-battlefield-performance-${tag}.json`),
} = {}) {
  const sample = await page.evaluate(durationMs => new Promise((resolve, reject) => {
    const current = window.godotTest.state();
    if (!current.runtimeReady || current.testMode || current.metrics.manualClock || current.pieces.length !== 32) {
      reject(new Error('A ready ordinary-clock 32-piece board is required.')); return;
    }
    const activeElementBefore = document.activeElement?.tagName;
    let first, last, nextMetricAt = 0;
    const intervals = [], metrics = [], visibility = new Set([document.visibilityState]), focus = new Set([document.hasFocus()]);
    const observeVisibility = () => visibility.add(document.visibilityState);
    const observeFocus = () => focus.add(document.hasFocus());
    document.addEventListener('visibilitychange', observeVisibility);
    window.addEventListener('focus', observeFocus);
    window.addEventListener('blur', observeFocus);
    const cleanup = () => {
      document.removeEventListener('visibilitychange', observeVisibility);
      window.removeEventListener('focus', observeFocus);
      window.removeEventListener('blur', observeFocus);
    };
    const timer = setTimeout(() => {cleanup();reject(new Error('Warm frame sample timed out.'));}, durationMs + 12000);
    const step = time => {
      first ??= time;
      if (last !== undefined) intervals.push(time - last);
      last = time;
      visibility.add(document.visibilityState);
      if (time - first >= nextMetricAt) {
        const {fps, frames, drawCalls, primitives} = window.godotTest.state().metrics;
        metrics.push({elapsedMs:time-first,fps,frames,drawCalls,primitives});
        nextMetricAt += 1000;
      }
      if (time - first < durationMs) { requestAnimationFrame(step); return; }
      clearTimeout(timer);
      cleanup();
      const canvas = document.querySelector('canvas'), rect = canvas.getBoundingClientRect();
      resolve({durationMs:time-first,intervals,metrics,visibility:[...visibility],focus:[...focus],activeElementBefore,activeElementAfter:document.activeElement?.tagName,url:location.href,
        viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
        canvas:{renderWidth:canvas.width,renderHeight:canvas.height,cssWidth:rect.width,cssHeight:rect.height},
        errors:[...new Set([...(window.__godotQaErrors||[]),...(window.godotTest.state().errors||[])])]});
    };
    requestAnimationFrame(step);
  }), durationMs);
  assert.deepEqual(sample.visibility, ['visible']);
  assert.deepEqual(sample.errors, []);
  const ordered = [...sample.intervals].sort((a,b) => a-b);
  const percentile = p => ordered[Math.floor((ordered.length-1)*p)];
  const report = {schemaVersion:1,generatedAt:new Date().toISOString(),tag,
    scope:'Already loaded visible desktop scene, ordinary real-time clock, no navigation or Wasm startup inside this sample. One short sample; not mobile or cross-engine validation.',
    ...sample,summary:{frames:sample.intervals.length,observedFrameRate:sample.intervals.length/(sample.durationMs/1000),medianFrameMs:percentile(.5),p95FrameMs:percentile(.95),p99FrameMs:percentile(.99),longestFrameMs:ordered.at(-1),intervalsOver50ms:sample.intervals.filter(value => value>50).length},passed:true};
  await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`);
  return {reportPath,...report.summary};
}
