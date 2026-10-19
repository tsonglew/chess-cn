/**
 * Endgame acceptance in an existing Ego Page. Never launches a browser.
 * Native buttons/keyboard cover the player flow; the bridge inspects state,
 * advances one animation at a time, and repeats all eight authored solutions.
 * Storage mutations are restricted to the ?test=1 namespace.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const productionKey='chess-cn.progress.v1';
const testPrefix='chess-cn.godot-test.';
const testKey=testPrefix+productionKey;
const board=state=>(state.pieces||[]).map(({id,type,color,row,col})=>({id,type,color,row,col})).sort((a,b)=>a.id-b.id);
const compactPuzzle=puzzle=>puzzle?{...puzzle,levels:(puzzle.levels||[]).map(({id,title,status,locked,completed})=>({id,title,status,locked,completed}))}:puzzle;
const compact=state=>({mode:state.mode,phase:state.phase,turn:state.turn,pieces:board(state),selectedId:state.selectedId,
  legalMoves:state.legalMoves,puzzle:compactPuzzle(state.puzzle),motion:state.metrics?.motion,effects:state.metrics?.effects,
  targetVisualAlive:state.metrics?.targetVisualAlive,battleNotice:state.battleNotice,error:state.error});

export async function runGodotPuzzleQa(page,{
  url='http://127.0.0.1:8000/godot/?test=1',tag='local',
  output=resolve(root,'output/godot-puzzles'),reportPath=resolve(root,`docs/reports/godot-puzzles-${tag}.json`),
}={}){
  assert.equal(new URL(url).searchParams.get('test'),'1','Puzzle QA must use the isolated test storage namespace');
  await mkdir(output,{recursive:true});
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),url,passed:false,
    scope:'Desktop Godot puzzle integration: eight existing teaching previews, controller lifecycle, native input, storage and visual effects. Screenshots require visual review; not independent puzzle-content or mobile validation.',
    checks:[],samples:{},screenshots:[],errors:[]};
  let pageLoaded=false;
  const accumulatedErrors=new Set();
  const collectErrors=async()=>{
    if(!pageLoaded)return;
    const current=await page.evaluate(()=>[...(window.__puzzleQaErrors||[]),...(window.godotTest?.state().errors||[])]).catch(()=>[]);
    for(const error of current)accumulatedErrors.add(error);
    report.errors=[...accumulatedErrors];
  };
  const state=()=>page.evaluate(()=>window.godotTest.state());
  const call=(method,...args)=>page.evaluate(({method,args})=>window.godotTest[method](...args),{method,args});
  const command=async(action,arg)=>{const result=await call('puzzle',action,arg);assert.equal(result?.ok,true,`${action}: ${result?.reason||'rejected'}`);return result;};
  const advance=async(ms=0)=>{assert.ok(ms>=0&&ms<=1200,'Advance at most one animation per call');await call('advanceTime',ms);return state();};
  const check=text=>report.checks.push(text);
  const capture=async name=>{const path=resolve(output,`${tag}-${name}.png`);await page.screenshot({path});report.screenshots.push(path);};
  const puzzleView=async()=>(await state()).puzzle.view;
  const waitPuzzle=async()=>{
    await page.waitForFunction(()=>{const s=window.godotTest?.state();return s?.error||s?.puzzle?.active&&!s.puzzle.loading&&(s.puzzle.view||s.puzzle.warning);},undefined,{timeout:30000});
    const s=await advance();assert.equal(s.error,null);assert.ok(s.puzzle.active&&!s.puzzle.loading,s.puzzle.warning);assert.ok(s.puzzle.view,s.puzzle.warning||'Puzzle loaded without a controller view');assert.notEqual(s.puzzle.view.phase,'error',s.puzzle.view.error);return s;
  };
  const load=async({enter=true}={})=>{
    await collectErrors();
    await page.goto(url);
    pageLoaded=true;
    await page.waitForFunction(()=>window.godotTest?.state().runtimeReady||window.godotTest?.state().error,undefined,{timeout:120000});
    const s=await advance();assert.ok(s.runtimeReady,s.error);assert.equal(s.testMode,true);
    if(enter){await page.click('#mode-puzzle');return waitPuzzle();}return s;
  };
  const settle=async(expected,limit=100)=>{
    for(let step=0;step<limit;step++){
      const s=await advance(step===0?0:100),v=s.puzzle.view;
      assert.equal(s.error,null);assert.notEqual(v?.phase,'error',v?.error);
      if(typeof expected==='function'?expected(s):v?.phase===expected)return s;
    }
    assert.fail(`Puzzle did not settle: ${JSON.stringify(compact(await state()))}`);
  };
  const choose=async id=>{await command('choose',id);const s=await settle(s=>s.puzzle.view?.puzzle.id===id&&s.puzzle.view.phase==='playerTurn');assert.equal(s.puzzle.view.snapshot.moves.length,0);return s;};
  const makeMove=async move=>{
    assert.equal((await call('select',move.from.row,move.from.col)).ok,true);
    assert.equal((await call('move',move.to.row,move.to.col)).ok,true);
    return advance();
  };
  const press=async key=>{await page.keyboard.press(key);return advance();};
  const go=async(row,col)=>{
    assert.equal((await state()).camera,'top');
    for(let i=0;i<24;i++){
      const cursor=(await state()).keyboard;if(cursor.row===row&&cursor.col===col)return;
      await press(cursor.row!==row?(cursor.row>row?'ArrowUp':'ArrowDown'):(cursor.col>col?'ArrowLeft':'ArrowRight'));
    }assert.fail(`Keyboard cursor did not reach ${row},${col}`);
  };
  const readTest=()=>page.evaluate(key=>localStorage.getItem(key),testKey);
  const writeTest=async(value,{clearBackup=false}={})=>{
    // Deactivation cancels presentations and lets outstanding save microtasks finish.
    if((await state()).puzzle.active){await page.click('#mode-game');await advance();}
    await page.evaluate(({key,prefix,value,clearBackup})=>{
      if(!key.startsWith(prefix)||new URLSearchParams(location.search).get('test')!=='1')throw new Error('Unsafe storage fixture');
      if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,typeof value==='string'?value:JSON.stringify(value));
      if(clearBackup){localStorage.removeItem(key+'.backup');localStorage.removeItem(key+'.corrupt');}
    },{key:testKey,prefix:testPrefix,value,clearBackup});
  };
  const assertVisibleBoard=async()=>{
    const s=await advance();assert.deepEqual(s.metrics.visualPieces.filter(p=>p.visible).map(p=>p.id).sort((a,b)=>a-b),s.pieces.map(p=>p.id).sort((a,b)=>a-b));
    for(const piece of s.pieces){const visual=s.metrics.visualPieces.find(p=>p.id===piece.id),point=[(piece.col-4)*2.6,.62,(piece.row-4.5)*2.6];assert.ok(visual.position.every((v,i)=>Math.abs(v-point[i])<.001),`piece ${piece.id} ends at its rule square`);}
  };
  let realStorageBefore;
  try{
    await page.cdp('Network.enable');await page.cdp('Network.setCacheDisabled',{cacheDisabled:true});
    await page.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await page.cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__puzzleQaErrors=[];const record=x=>window.__puzzleQaErrors.push(String(x));addEventListener('error',e=>record(e.message||e.error));addEventListener('unhandledrejection',e=>record(e.reason?.stack||e.reason));const old=console.error;console.error=(...a)=>{record(a.join(' '));old(...a)};`});
    await load({enter:false});
    realStorageBefore=await page.evaluate(key=>localStorage.getItem(key),productionKey);
    await page.evaluate(()=>{window.__realPuzzleFetch=window.fetch;window.fetch=(input,...args)=>String(input).includes('/puzzle/data/previews/catalog.json')?Promise.reject(new TypeError('QA simulated offline')):window.__realPuzzleFetch(input,...args);});
    await page.click('#mode-puzzle');
    await page.waitForFunction(()=>!!window.godotTest.state().puzzle.warning&&!window.godotTest.state().puzzle.loading,undefined,{timeout:10000});
    assert.equal((await state()).puzzle.view,null);assert.match((await state()).puzzle.warning,/catalog\.json/);
    assert.equal(await page.evaluate(()=>document.querySelector('#puzzle-reload').hidden),false);
    await page.evaluate(()=>{window.fetch=window.__realPuzzleFetch;delete window.__realPuzzleFetch;});
    await page.click('#puzzle-reload');await waitPuzzle();
    check('A failed catalog request shows its resource path and a real reload button recovers without restarting the engine');
    await writeTest(null,{clearBackup:true});let s=await load();
    const catalog=JSON.parse(await readFile(resolve(root,'godot-project/web/puzzle/data/previews/catalog.json'),'utf8'));
    const puzzles=await Promise.all(catalog.previewIds.map(async id=>JSON.parse(await readFile(resolve(root,`godot-project/web/puzzle/data/previews/${id}.json`),'utf8'))));
    assert.equal(s.puzzle.preview,true);assert.equal(s.puzzle.levels.length,8);assert.equal(s.puzzle.view.puzzle.id,puzzles[0].id);
    assert.equal(s.puzzle.levels[0].locked,false);assert.ok(s.puzzle.levels.slice(1).every(p=>p.locked));assert.deepEqual(s.puzzle.records,{});
    report.build=await page.evaluate(async()=>{const response=await fetch('./build-manifest.json',{cache:'no-store'});return response.json();});
    report.browser=await page.evaluate(()=>({userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}}));
    report.samples.initial=compact(s);await capture('initial');
    check('Native mode button loads eight explicitly labeled teaching previews with sequential unlocks');

    await page.click('#puzzle-demo');await settle(s=>s.puzzle.view.demonstrating&&s.puzzle.view.outcome.status==='success'&&!s.metrics.animating);
    assert.deepEqual((await state()).puzzle.records,{},'Watching an answer cannot award completion');
    await page.click('#puzzle-stop-demo');s=await settle('playerTurn');assert.equal(s.puzzle.view.snapshot.moves.length,0);
    for(let level=1;level<=3;level++){await page.click('#puzzle-hint');s=await advance();assert.equal(s.puzzle.view.hintLevel,level);if(level>=2)assert.equal(s.selectedId,1);if(level===3)assert.ok(s.legalMoves.some(m=>m.row===3&&m.col===3));}
    await capture('hint-destination');check('Real hint/demo buttons expose three hint levels; answer demonstration restores the untouched board without a completion award');

    await page.focus('#canvas');await press('2');await go(3,2);await press('Enter');await go(3,3);s=await press('Enter');assert.equal(s.puzzle.view.phase,'animating');
    const duplicate=await call('move',3,3);assert.equal(duplicate.ok,false,'Repeated move is rejected during animation');
    s=await settle('success');assert.equal(s.puzzle.records['preview-01'].completed,true);assert.equal(await page.evaluate(()=>document.querySelector('#turn-seal').textContent),'红');assert.equal(s.puzzle.records['preview-01'].hintsUsed,3);assert.equal(s.puzzle.levels[1].locked,false);
    await assertVisibleBoard();await capture('keyboard-success');check('Native keyboard completes first puzzle; success waits for the animation and unlocks the next level');

    // Reuse authored solutions rather than duplicating the chess/controller logic.
    for(let index=1;index<puzzles.length;index++){
      await page.click('#puzzle-next');s=await settle('playerTurn');const puzzle=puzzles[index];assert.equal(s.puzzle.view.puzzle.id,puzzle.id);
      for(let ply=0;ply<puzzle.recommendedLine.length;ply+=2){
        const move=puzzle.recommendedLine[ply],before=await state();
        const victim=before.pieces.find(p=>p.row===move.to.row&&p.col===move.to.col);
        await makeMove(move);
        if(victim){
          s=await advance(500);assert.equal(s.metrics.targetVisualAlive,false);assert.ok(s.metrics.effects.activeParticles>0);assert.ok(s.metrics.effects.activeRings>0);
          report.samples.capture=compact(s);
          for(const view of ['iso','top','side']){await call('view',view);await advance();await capture(`capture-${view}`);}
        }
        const expected=ply+2>=puzzle.recommendedLine.length?'success':'playerTurn';s=await settle(expected);
        assert.equal(s.puzzle.view.snapshot.moves.length,Math.min(ply+2,puzzle.recommendedLine.length),'Black replies exactly once after red animation');
        if(expected==='playerTurn')assert.equal(s.turn,'red');await assertVisibleBoard();
      }
      assert.equal(s.puzzle.records[puzzle.id].completed,true);assert.equal(s.puzzle.records[puzzle.id].bestRedTurns,puzzle.goal.maxRedTurns);
      report.samples[puzzle.id]=compact(s);
    }
    assert.equal(Object.keys((await state()).puzzle.records).length,8);await capture('all-complete');
    check('All eight existing recommended lines complete through the real controller; black auto-replies animate once, and preview-07 capture produces visible impact particles/rings from three views');

    const p3=puzzles[2],first=p3.recommendedLine[0];await choose(p3.id);const p3Initial=board(await state());await makeMove(first);s=await settle('playerTurn');assert.equal(s.puzzle.view.snapshot.moves.length,2);
    await page.focus('#canvas');await press('u');s=await advance();assert.deepEqual(board(s),p3Initial);assert.equal(s.puzzle.view.snapshot.moves.length,0);assert.equal(s.metrics.effects.activeParticles,0);
    await makeMove(first);await advance(100);assert.equal((await call('restart')).ok,true);s=await advance(1000);assert.deepEqual(board(s),p3Initial);assert.equal(s.puzzle.view.snapshot.moves.length,0);
    await makeMove(first);s=await advance(610);assert.equal(s.puzzle.view.phase,'animating');assert.equal(s.puzzle.view.snapshot.moves.length,2,'Black animation started');
    assert.equal((await call('restart')).ok,true);s=await advance(1000);assert.deepEqual(board(s),p3Initial);assert.equal(s.puzzle.view.snapshot.moves.length,0);
    check('Keyboard U undoes a full red/black round; retry during red or black animation cancels stale completion without a second reply');

    const wrong={pieceId:1,from:{row:3,col:0},to:{row:0,col:0}};await makeMove(wrong);s=await settle('wrongMove');assert.equal(s.puzzle.view.outcome.status,'unproven');assert.equal(s.puzzle.view.snapshot.moves.length,1);
    await capture('unproven-branch');await command('pause');assert.equal((await puzzleView()).phase,'paused');await page.click('#puzzle-resume');assert.equal((await puzzleView()).phase,'wrongMove');
    s=await load();assert.equal(s.puzzle.view.phase,'wrongMove');assert.equal(s.puzzle.view.continuationAccepted,false);assert.equal(s.puzzle.view.snapshot.moves.length,1);
    await page.click('#puzzle-continue');s=await settle('playerTurn');assert.equal(s.puzzle.view.snapshot.moves.length,2);assert.ok(s.pieces.some(p=>p.id===0&&p.row===1&&p.col===4));
    await page.click('#puzzle-hint');s=await advance();assert.equal(s.puzzle.view.hint.move,null);assert.match(s.puzzle.view.hint.text,/没有已验证/);
    await page.click('#undo-button');s=await advance();assert.deepEqual(board(s),p3Initial);check('Unproven move is not declared failure; pause/reload preserve the continue gate, bounded defense responds, and unavailable hint stays explicit');

    await makeMove(first);await settle('playerTurn');await page.click('#puzzle-hint');const saved=await state(),savedBoard=board(saved),savedHints=saved.puzzle.view.hintsUsed,savedRecords=JSON.stringify(saved.puzzle.records);
    await page.click('#puzzle-demo');await advance(200);await command('pause');assert.equal((await puzzleView()).phase,'paused');await page.click('#puzzle-resume');await advance(100);await page.click('#puzzle-stop-demo');s=await settle('playerTurn');
    assert.deepEqual(board(s),savedBoard);assert.equal(s.puzzle.view.hintsUsed,savedHints);assert.equal(JSON.stringify(s.puzzle.records),savedRecords);
    await page.click('#puzzle-demo');await settle(s=>s.puzzle.view.demonstrating&&s.puzzle.view.outcome.status==='success'&&!s.metrics.animating);await page.click('#puzzle-stop-demo');s=await settle('playerTurn');assert.deepEqual(board(s),savedBoard);assert.equal(JSON.stringify(s.puzzle.records),savedRecords);
    check('Demo interrupted by pause and demo played to the end both restore the original player position, hints and progress');

    await choose('preview-01');await makeMove({pieceId:1,from:{row:3,col:2},to:{row:0,col:2}});s=await settle('failure');assert.equal(s.puzzle.view.outcome.reason,'turnLimit');await page.click('#keyboard-focus');await press('r');await settle('playerTurn');
    await choose('preview-04');await makeMove({pieceId:0,from:{row:1,col:7},to:{row:0,col:5}});s=await settle('failure');assert.equal(s.puzzle.view.outcome.reason,'stalemate');check('Turn-budget exhaustion and stalemate fail the checkmate goal and remain retryable');

    await choose('preview-07');await page.click('#effects-toggle');assert.equal((await state()).effects.enabled,false);await makeMove({pieceId:2,from:{row:2,col:6},to:{row:2,col:5}});s=await advance(500);assert.equal(s.metrics.targetVisualAlive,false);assert.equal(s.metrics.effects.activeParticles,0);await settle('playerTurn');await page.click('#effects-toggle');
    await page.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await page.waitForFunction(()=>window.godotTest.state().effects.reducedMotion,undefined,{timeout:5000});
    await choose('preview-04');await makeMove(puzzles[3].recommendedLine[0]);s=await advance(330);assert.ok(Math.abs(s.metrics.visualPieces.find(p=>p.id===0).position[1]-.62)<.01);await settle('playerTurn');
    await page.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await page.waitForFunction(()=>!window.godotTest.state().effects.reducedMotion,undefined,{timeout:5000});
    check('Puzzle captures obey the effects checkbox; live reduced-motion preference removes horse leap without changing chess results');

    await choose('preview-01');await call('view','top');await advance();await page.click('#keyboard-focus');await go(3,3);
    const mouseState=await advance(),destination=mouseState.metrics.keyboardCursor.screen;
    const rook=mouseState.metrics.visualPieces.find(p=>p.id===1);
    const clickScreen=async screen=>{const point=await page.evaluate(screen=>{const rect=document.querySelector('#canvas').getBoundingClientRect(),viewport=godotTest.state().metrics.viewport;return {x:rect.left+screen[0]/viewport[0]*rect.width,y:rect.top+screen[1]/viewport[1]*rect.height};},screen);await page.mouse.click(point.x,point.y,{label:'残局选子与落点'});await advance();};
    await clickScreen(rook.headScreen||rook.screen);assert.equal((await state()).selectedId,1);
    await clickScreen(destination);await settle('success');await capture('mouse-success');
    check('Real canvas mouse picking selects the puzzle rook and confirms its destination; keyboard focus and R remain available after failure');

    // Terminal action restoration must award success even when its animation was interrupted.
    await choose('preview-01');await advance();const baseline=JSON.parse(await readTest());const terminalFixture=structuredClone(baseline);delete terminalFixture.records['preview-01'];terminalFixture.resume=null;
    await writeTest(terminalFixture,{clearBackup:true});await load();await makeMove(puzzles[0].recommendedLine[0]);await advance(200);
    const savedTerminal=JSON.parse(await readTest());assert.equal(savedTerminal.resume.phaseAfterRestore,'success');assert.equal(savedTerminal.records['preview-01'],undefined);
    s=await load();assert.equal(s.puzzle.view.phase,'success');assert.equal(s.puzzle.records['preview-01'].completed,true);assert.equal(s.puzzle.levels[1].locked,false);
    check('Reload during final animation restores the stable winning position and awards completion instead of leaving the next level locked');

    await writeTest('{invalid-json',{clearBackup:true});s=await load();assert.equal(s.puzzle.view.phase,'playerTurn');assert.match(s.puzzle.warning,/损坏/);assert.equal(await page.evaluate(key=>localStorage.getItem(key+'.corrupt'),testKey),'{invalid-json');
    await writeTest({schemaVersion:99},{clearBackup:true});s=await load();assert.match(s.puzzle.warning,/较新|更新/);await makeMove(puzzles[0].recommendedLine[0]);await settle('success');assert.equal(JSON.parse(await readTest()).schemaVersion,99);
    await writeTest(baseline,{clearBackup:true});s=await load();assert.equal(Object.keys(s.puzzle.records).length,8);
    check('Corrupt test save is quarantined with a visible warning; future-version save remains protected even after winning; valid completed progress reloads');

    await choose('preview-03');await makeMove(first);await advance(200);await page.click('#mode-game');s=await advance(1000);assert.equal(s.puzzle.active,false);assert.equal(s.mode,'game');assert.equal(s.pieces.length,32);assert.equal(s.historyLength,0);assert.equal(s.metrics.effects.activeParticles,0);
    await page.click('#mode-puzzle');s=await waitPuzzle();await settle('playerTurn');assert.equal((await puzzleView()).snapshot.moves.length,2,'Returning resumes the stable puzzle and completes pending black response once');
    await page.click('#mode-game');await call('demo','red');s=await advance(600);assert.equal(s.metrics.targetVisualAlive,false);assert.equal(s.metrics.bones.count,20);await advance(600);await page.click('#restart-button');s=await advance();assert.equal(s.pieces.length,32);
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),productionKey),realStorageBefore,'Production player progress was never mutated by test fixtures');
    report.samples.final=compact(s);await capture('free-game-regression');check('Switching modes cancels transient visuals, preserves puzzle continuation, and retains the original 32-piece game and soldier thrust demo; production storage untouched');
    await collectErrors();assert.deepEqual(report.errors,[]);
    report.passed=true;
  }catch(error){report.failure=error.stack||error.message;report.samples.failure=await state().then(compact).catch(()=>null);await collectErrors();await capture('failure').catch(()=>{});}
  finally{await page.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]}).catch(()=>{});await collectErrors();await mkdir(resolve(reportPath,'..'),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');}
  return {passed:report.passed,checks:report.checks,failure:report.failure,reportPath,screenshots:report.screenshots};
}
