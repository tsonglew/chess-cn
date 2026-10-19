/**
 * Keyboard acceptance for the Godot web build, using an existing Ego Page.
 * All game interactions use real keyboard/pointer input. The existing test
 * bridge is used only to inspect state and advance the deterministic clock.
 * Run with ?test=1; this module never opens or owns a browser TaskSpace.
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const board = state => state.pieces.map(({id,type,color,row,col}) => ({id,type,color,row,col})).sort((a,b) => a.id-b.id);
const cursor = state => state.keyboard;
const compact = state => ({phase:state.phase,turn:state.turn,selectedId:state.selectedId,historyLength:state.historyLength,
  keyboard:state.keyboard,camera:state.camera,labels:state.labels,cameraDistance:state.metrics.cameraDistance,
  keyboardCursor:state.metrics.keyboardCursor,pieces:board(state)});

export async function runGodotKeyboardQa(page, {
  url = 'http://127.0.0.1:8000/godot/?test=1',
  tag = 'local',
  output = resolve(root, 'output/godot-keyboard'),
  reportPath = resolve(root, `docs/reports/godot-keyboard-${tag}.json`),
} = {}) {
  assert.equal(new URL(url).searchParams.get('test'), '1', 'Keyboard acceptance uses the deterministic clock');
  await mkdir(output,{recursive:true});
  await mkdir(resolve(root,'docs/reports'),{recursive:true});
  const report = {schemaVersion:1,generatedAt:new Date().toISOString(),url,passed:false,
    scope:'Desktop real keyboard and pointer input; diagnostics and clock control use the test bridge. No mobile testing.',
    checks:[],screenshots:[],samples:{}};
  const state = () => page.evaluate(() => window.godotTest.state());
  const settle = async (ms=0) => {
    await page.evaluate(ms => window.godotTest.advanceTime(ms),ms);
    return state();
  };
  const press = async key => { await page.keyboard.press(key); return settle(); };
  const capture = async name => {
    const path = resolve(output,`${tag}-${name}.png`);
    await page.screenshot({path,fullPage:true}); report.screenshots.push(path);
  };
  const check = text => report.checks.push(text);
  const focus = () => page.focus('#canvas');
  const go = async (row,col) => {
    assert.equal((await state()).camera,'top','Board-coordinate navigation helper requires the top view');
    for (let attempts=0;attempts<24;attempts++) {
      const current=cursor(await state());
      if (current.row===row && current.col===col) return;
      await press(current.row!==row ? current.row>row?'ArrowUp':'ArrowDown' : current.col>col?'ArrowLeft':'ArrowRight');
    }
    assert.fail(`Cursor did not reach ${row},${col}`);
  };
  const clickProjected = async screen => {
    const point=await page.evaluate(screen => {
      const canvas=document.querySelector('#canvas'); const bounds=canvas.getBoundingClientRect();
      const viewport=window.godotTest.state().metrics.viewport;
      return {x:bounds.left+screen[0]/viewport[0]*bounds.width,y:bounds.top+screen[1]/viewport[1]*bounds.height};
    },screen);
    await page.mouse.click(point.x,point.y,{label:'选择棋子或落点'});
    return settle();
  };
  try {
    await page.cdp('Network.enable');
    await page.cdp('Network.setCacheDisabled',{cacheDisabled:true});
    await page.cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.__keyboardQaErrors=[];
      addEventListener('error',e=>window.__keyboardQaErrors.push(String(e.message||e.error)));
      addEventListener('unhandledrejection',e=>window.__keyboardQaErrors.push(String(e.reason?.stack||e.reason)));
    `});
    await page.goto(url);
    await page.waitForFunction(()=>Boolean(window.godotTest),undefined,{timeout:30000});
    if (!(await state()).runtimeReady) {
      await focus();
      for (const key of ['ArrowUp','Enter','r','u']) {
        if ((await state()).runtimeReady) break;
        await page.keyboard.press(key);
      }
      const loading=await state();
      assert.equal(loading.historyLength,0);
      report.samples.loading=compact(loading);
      if (!loading.runtimeReady) {
        assert.equal(loading.selectedId,null); assert.equal(loading.camera,'iso'); assert.equal(loading.labels,true);
        check('Loading keyboard actions do not alter the board or settings');
      } else report.loadingNote='Runtime became ready during native input; subsequent acceptance starts from the ready board.';
    }
    await page.waitForFunction(()=>window.godotTest.state().runtimeReady||window.godotTest.state().error,undefined,{timeout:120000});
    let current=await settle();
    assert.equal(current.runtimeReady,true,current.error||'Runtime not ready');
    assert.equal(current.pieces.length,32);
    const initial=board(current);
    report.build=await page.evaluate(async()=>{const response=await fetch('./build-manifest.json',{cache:'no-store'});return response.json();});
    report.browser=await page.evaluate(()=>({userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight},devicePixelRatio}));
    report.uiSnapshot=await page.snapshot();
    const help=await page.evaluate(()=>({text:document.querySelector('#keyboard-help')?.textContent,
      canvas:document.querySelector('#canvas')?.getAttribute('aria-describedby'),
      button:Boolean(document.querySelector('#keyboard-focus')),
      visible:Boolean(document.querySelector('#keyboard-help')?.getBoundingClientRect().height)}));
    assert.ok(help.visible && help.button && help.canvas?.includes('keyboard-help'),'Visible help and accessible board-focus entry');
    for (const label of ['WASD','Enter','Space','Esc','U','R','L','F']) assert.ok(help.text.includes(label),`Help includes ${label}`);
    check('Visible keyboard help, board-focus entry and canvas description');

    await page.click('#keyboard-focus');
    current=await settle();
    assert.equal(cursor(current).focused,true); assert.equal(cursor(current).visible,true);
    await press('r'); await press('2');
    await go(6,0); current=await press('Enter');
    assert.ok(current.pieces.some(piece=>piece.id===current.selectedId&&piece.type==='soldier'&&piece.color==='red'&&piece.row===6&&piece.col===0));
    assert.deepEqual(current.legalMoves.map(({row,col})=>({row,col})),[{row:5,col:0}]);
    await capture('selected-soldier');
    await press('d'); current=await press('Space');
    assert.deepEqual(board(current),initial); assert.equal(current.historyLength,0); assert.equal(current.phase,'ready');
    check('Enter selects a soldier and illegal sideways Space action cannot move it');
    await press('a'); await press('Space'); current=await press('Escape');
    assert.equal(current.selectedId,null); assert.equal(current.legalMoves.length,0);
    await press('Enter'); await press('w'); current=await press('Enter');
    assert.equal(current.phase,'moving'); assert.equal(current.historyLength,1);
    assert.ok(current.pieces.some(piece=>piece.type==='soldier'&&piece.color==='red'&&piece.row===5&&piece.col===0));
    const during=board(current);
    for (const key of ['r','u','Enter','Space','Escape']) await press(key);
    current=await state(); assert.equal(current.phase,'moving'); assert.equal(current.historyLength,1); assert.deepEqual(board(current),during);
    await settle(1400); current=await state(); assert.equal(current.phase,'ready'); assert.equal(current.turn,'black');
    check('Esc clears selection; WASD plus Enter makes a legal move; move/undo/restart are guarded during animation');

    await go(3,0); await press('Space'); await press('s'); await press('Space'); await settle(1400);
    assert.equal((await state()).historyLength,2);
    await page.keyboard.down('u'); await settle(); assert.equal((await state()).historyLength,1);
    await page.keyboard.down('u'); await settle(); assert.equal((await state()).historyLength,1,'Held U must not repeatedly undo');
    await page.keyboard.up('u'); current=await press('u'); assert.equal(current.historyLength,0); assert.deepEqual(board(current),initial);
    check('Both sides move by keyboard and held U undoes only once per key press');

    await go(6,0);
    const guarded=compact(await state());
    for (const key of ['Control+ArrowUp','Alt+ArrowUp','Meta+ArrowUp']) {
      await press(key);
    }
    current=await state(); assert.deepEqual(cursor(current),guarded.keyboard); assert.equal(current.labels,guarded.labels);
    // Native trusted CDP input covers repeat/IME key metadata without dispatching synthetic DOM events.
    await page.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Process',code:'KeyR',windowsVirtualKeyCode:229,nativeVirtualKeyCode:229});
    await page.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Process',code:'KeyR',windowsVirtualKeyCode:229,nativeVirtualKeyCode:229});
    current=await settle(); assert.deepEqual(board(current),initial); assert.equal(current.selectedId,null);
    check('Ctrl/Alt/Meta combinations and a trusted IME Process key leave game state unchanged');

    await go(9,0); await press('ArrowDown'); current=await press('ArrowLeft');
    assert.equal(cursor(current).row,9); assert.equal(cursor(current).col,0);
    await go(0,8); await press('ArrowUp'); current=await press('ArrowRight');
    assert.equal(cursor(current).row,0); assert.equal(cursor(current).col,8);
    check('Board edges clamp without wrapping');

    await go(5,4); await press('4');
    const sideBefore=await state(); current=await press('ArrowRight');
    assert.ok(current.metrics.keyboardCursor.screen[0]>sideBefore.metrics.keyboardCursor.screen[0]+1,'Side-view ArrowRight moves the cursor right on screen');
    const sideRight=current; current=await press('ArrowUp');
    assert.ok(current.metrics.keyboardCursor.screen[1]<sideRight.metrics.keyboardCursor.screen[1]-1,'Side-view ArrowUp moves the cursor up on screen');
    assert.equal(Math.abs(cursor(current).row-cursor(sideRight).row)+Math.abs(cursor(current).col-cursor(sideRight).col),1);
    await capture('side-cursor');
    for (const [key,name] of [['1','iso'],['2','top'],['3','front'],['4','side']]) {
      current=await press(key); assert.equal(current.camera,name); assert.deepEqual(board(current),initial);
    }
    await press('2'); await press('l'); assert.equal((await state()).labels,false);
    await press('l'); assert.equal((await state()).labels,true);
    const beforeZoom=(await state()).metrics.cameraDistance;
    await press('='); const afterZoom=(await state()).metrics.cameraDistance;
    assert.ok(afterZoom<beforeZoom,'Plus/equal zooms in');
    await press('-'); assert.ok(Math.abs((await state()).metrics.cameraDistance-beforeZoom)<.001);
    check('Four view shortcuts, screen-relative side movement, label toggle and zoom');

    await press('r'); await press('2'); await settle();
    let soldier=(await state()).metrics.visualPieces.find(piece=>piece.type==='soldier'&&piece.color==='red'&&piece.row===6&&piece.col===0);
    if (!soldier) {
      const id=(await state()).pieces.find(piece=>piece.type==='soldier'&&piece.color==='red'&&piece.row===6&&piece.col===0).id;
      soldier=(await state()).metrics.visualPieces.find(piece=>piece.id===id);
    }
    assert.ok(soldier,'Soldier visual exists');
    current=await clickProjected(soldier.headScreen||soldier.screen);
    assert.equal(current.selectedId,soldier.id); assert.equal(cursor(current).row,6); assert.equal(cursor(current).col,0);
    await press('ArrowUp'); await press('Enter'); await settle(1400);
    assert.equal((await state()).historyLength,1); await press('u');
    await go(6,0); await press('Enter'); current=await press('ArrowUp');
    await clickProjected(current.metrics.keyboardCursor.screen); await settle(1400);
    assert.equal((await state()).historyLength,1);
    check('Mouse-selected piece can move with the keyboard; keyboard-selected piece can move with the mouse');

    await focus(); await press('r'); await press('2');
    await page.keyboard.press('Tab');
    const afterTab=await page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id}));
    assert.notEqual(afterTab.id,'canvas','Tab exits the board rather than being trapped');
    await page.focus('[data-view="side"]'); current=await press('Enter');
    assert.equal(current.camera,'side'); assert.equal(current.selectedId,null);
    await page.focus('#labels-toggle'); await press('Space'); assert.equal((await state()).labels,false);
    await page.keyboard.press('l'); await settle(); assert.equal((await state()).labels,false,'L does not hijack focused checkbox');
    await page.keyboard.press('Space'); await settle(); assert.equal((await state()).labels,true);
    await focus(); await press('2');
    const scroll=await page.evaluate(()=>scrollY); await press('Space');
    assert.equal(await page.evaluate(()=>scrollY),scroll,'Board Space does not scroll the page');
    check('Tab leaves canvas; native button Enter and checkbox Space work; canvas Space prevents scrolling');

    await press('Escape'); await page.keyboard.press('f');
    await page.waitForFunction(()=>Boolean(document.fullscreenElement),undefined,{timeout:10000});
    assert.equal(await page.evaluate(()=>document.fullscreenElement?.id),'canvas-wrap');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.fullscreenElement,undefined,{timeout:10000});
    check('F enters board fullscreen and Escape exits it');
    await focus(); await press('r'); await press('1'); await press('ArrowUp');
    await capture('complete-help');
    report.samples.final=compact(await state());
    report.errors=await page.evaluate(()=>[...new Set([...(window.__keyboardQaErrors||[]),...(window.godotTest.state().errors||[])])]);
    assert.deepEqual(report.errors,[]); assert.deepEqual(board(await state()),initial);
    report.passed=true;
  } catch(error) {
    report.failure=error.stack||error.message;
    report.samples.failure=await state().then(compact).catch(()=>null);
    report.errors=await page.evaluate(()=>window.__keyboardQaErrors||[]).catch(()=>[]);
    await capture('failure').catch(()=>{});
  } finally {
    await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`);
  }
  return {passed:report.passed,checks:report.checks,failure:report.failure,reportPath,screenshots:report.screenshots};
}

/** Check that the promised controls are discoverable in common desktop viewports. */
export async function inspectGodotKeyboardLayout(page, {
  tag='local', output=resolve(root,'output/godot-keyboard'),
  reportPath=resolve(root,`docs/reports/godot-keyboard-layout-${tag}.json`),
}={}) {
  const report={generatedAt:new Date().toISOString(),passed:false,viewports:[],screenshots:[]};
  await mkdir(output,{recursive:true});
  try {
    for(const [width,height] of [[1368,781],[1100,800]]) {
      await page.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await page.evaluate(()=>scrollTo(0,0));
      await page.evaluate(()=>window.godotTest.advanceTime(0));
      const item=await page.evaluate(()=>{
        const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
        return{width:innerWidth,height:innerHeight,help:rect('#keyboard-help'),panel:rect('.board-panel'),footer:rect('.board-footer'),caption:rect('.canvas-caption'),canvas:rect('#canvas')};
      });
      assert.ok(item.help.y>=0&&item.help.bottom<=height,'All keyboard instructions should fit in the first desktop viewport');
      assert.ok(item.help.right<=width,'Keyboard instructions should not overflow horizontally');
      assert.ok(Math.abs(item.panel.bottom-item.footer.bottom)<3,'Board panel ends at its footer without a stretched blank area');
      assert.ok(item.caption.bottom<=item.canvas.bottom&&item.caption.y>=item.canvas.y,'Short keyboard hint stays inside the canvas');
      const path=resolve(output,`${tag}-viewport-${width}.png`);
      await page.screenshot({path}); report.screenshots.push(path); report.viewports.push(item);
    }
    report.passed=true;
  }catch(error){report.failure=error.stack||error.message;}
  finally{
    await page.cdp('Emulation.clearDeviceMetricsOverride');
    await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`);
  }
  return{passed:report.passed,failure:report.failure,reportPath,screenshots:report.screenshots};
}
