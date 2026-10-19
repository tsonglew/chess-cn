/** Deterministic combat visuals and gameplay checks in an existing Ego Page. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const board=s=>s.pieces.map(({id,type,color,row,col})=>({id,type,color,row,col})).sort((a,b)=>a.id-b.id);
const sample=s=>({phase:s.phase,turn:s.turn,historyLength:s.historyLength,selectedId:s.selectedId,effects:s.effects,battleNotice:s.battleNotice,
  motion:s.metrics.motion,fx:s.metrics.effects,drawCalls:s.metrics.drawCalls,visuals:s.metrics.visualPieces.map(({id,type,position,facing,visible})=>({id,type,position,facing,visible})),targetVisualAlive:s.metrics.targetVisualAlive});
export async function runGodotCombatQa(page,{
 url='http://127.0.0.1:8000/godot/?test=1',tag='local',output=resolve(root,'output/godot-combat'),reportPath=resolve(root,`docs/reports/godot-combat-${tag}.json`),
}={}) {
 await mkdir(output,{recursive:true});
 const report={generatedAt:new Date().toISOString(),url,scope:'Desktop deterministic effects and motion; screenshots require visual review. No mobile or long-duration performance claim.',passed:false,checks:[],samples:{},screenshots:[]};
 const state=()=>page.evaluate(()=>window.godotTest.state());
 const call=(method,...args)=>page.evaluate(({method,args})=>window.godotTest[method](...args),{method,args});
 const advance=async ms=>{await call('advanceTime',ms);return state();};
 const capture=async name=>{const path=resolve(output,`${tag}-${name}.png`);await page.screenshot({path});report.screenshots.push(path);};
 const reset=async()=>{assert.equal((await call('restart')).ok,true);await call('view','iso');return advance(0);};
 const selectedMove=async(from,to)=>{assert.equal((await call('select',...from)).ok,true);assert.equal((await call('move',...to)).ok,true);return advance(0);};
 try {
  assert.equal(new URL(url).searchParams.get('test'),'1');
  await page.cdp('Network.enable');await page.cdp('Network.setCacheDisabled',{cacheDisabled:true});
  await page.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await page.cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__combatErrors=[];const record=x=>window.__combatErrors.push(String(x));addEventListener('error',e=>record(e.message));addEventListener('unhandledrejection',e=>record(e.reason));const old=console.error;console.error=(...a)=>{record(a.join(' '));old(...a)};`});
  await page.goto(url);await page.waitForFunction(()=>window.godotTest?.state().runtimeReady||window.godotTest?.state().error,undefined,{timeout:120000});
  let s=await advance(0);assert.ok(s.runtimeReady,s.error);const initial=board(s);
  report.build=await page.evaluate(async()=>{const response=await fetch('./build-manifest.json',{cache:'no-store'});return response.json();});
  assert.equal(s.metrics.effects.enabled,true);assert.equal(s.metrics.effects.activeParticles,0);
  await page.snapshot();
  await call('select',6,0);s=await advance(150);
  assert.equal(s.metrics.effects.selectionActive,true);await capture('selection');
  report.checks.push('Selected piece has an animated ring and retains legal move markers');
  const cases=[['soldier',[6,0],[5,0]],['horse',[9,1],[7,2]],['chariot',[9,0],[8,0]],['cannon',[7,1],[7,2]],['advisor',[9,3],[8,4]],['elephant',[9,2],[7,4]],['general',[9,4],[8,4]]];
  for(const [kind,from,to] of cases){
   await reset();const begun=await selectedMove(from,to);const duration=begun.metrics.motion.duration;
   assert.ok(duration>0&&duration<=1.2,`${kind} finite move duration`);
   const id=begun.metrics.motion.pieceId??begun.pieces.find(p=>p.color==='red'&&p.type===kind&&p.row===to[0]&&p.col===to[1]).id;
   const midway=await advance(duration*500);assert.equal(midway.phase,'moving');
   const visual=midway.metrics.visualPieces.find(p=>p.id===id);assert.ok(visual.visible);
   const origin=[(from[1]-4)*2.6,.62,(from[0]-4.5)*2.6],destination=[(to[1]-4)*2.6,.62,(to[0]-4.5)*2.6];
   assert.ok(Math.hypot(visual.position[0]-origin[0],visual.position[2]-origin[2])>.05,`${kind} advances along its path`);
   if(kind==='horse') assert.ok(visual.position[1]>.95,'horse visibly leaps');
   if(kind==='chariot') assert.ok(visual.position[1]<.75,'chariot stays close to ground');
   if(['horse','chariot'].includes(kind)) await capture(`${kind}-motion`);
   const landed=await advance(duration*500+1);assert.equal(landed.phase,'ready');
   const end=landed.metrics.visualPieces.find(p=>p.id===id);
   assert.ok(end.position.every((v,i)=>Math.abs(v-destination[i])<.001),`${kind} ends exactly on its square`);
   assert.ok(Math.abs(Math.sin(end.facing))<.001,`${kind} restores facing`);
   report.samples[kind]={midway:sample(midway),landed:sample(landed)};
   await call('undo');const undone=await advance(0);assert.deepEqual(board(undone),initial);assert.equal(undone.metrics.effects.activeParticles,0);
  }
  report.checks.push('Seven piece types move with distinct poses, land exactly, restore facing and undo cleanly');
  await reset();
  for(const [from,to] of [[[6,0],[5,0]],[[3,0],[4,0]],[[5,0],[4,0]],[[0,1],[2,2]],[[4,0],[4,1]],[[0,4],[1,4]]]){await selectedMove(from,to);await advance(1500);}
  await selectedMove([9,0],[0,0]);const distant=await advance(432);assert.equal(distant.metrics.targetVisualAlive,true,'long chariot capture must not hit from several squares away');
  const contact=await advance(120);assert.equal(contact.metrics.targetVisualAlive,false);assert.ok(contact.metrics.effects.activeParticles>0);
  report.samples.chariotContact={distant:sample(distant),contact:sample(contact)};await capture('chariot-contact');await advance(1500);
  report.checks.push('Legal long-line chariot capture waits for physical contact rather than a fixed early impact fraction');
  await reset();await selectedMove([7,1],[0,1]);
  const flying=await advance(400);assert.equal(flying.metrics.effects.projectileVisible,true);assert.equal(flying.metrics.targetVisualAlive,true);
  await capture('cannon-projectile');const beforeImpact=await advance(240);assert.equal(beforeImpact.metrics.targetVisualAlive,true);
  const impact=await advance(20);assert.equal(impact.metrics.targetVisualAlive,false);assert.ok(impact.metrics.effects.activeParticles>0);await advance(80);await capture('cannon-impact');
  const cannonEnd=await advance(300);assert.equal(cannonEnd.phase,'ready');assert.equal(cannonEnd.pieces.length,31);assert.equal(cannonEnd.turn,'black');
  report.samples.cannonCapture={flying:sample(flying),impact:sample(impact),end:sample(cannonEnd)};
  await call('undo');s=await advance(0);assert.deepEqual(board(s),initial);assert.equal(s.metrics.effects.projectileVisible,false);assert.equal(s.metrics.effects.activeParticles,0);
  report.checks.push('Cannon projectile flies over its screen; impact removes target at 0.648 s; undo restores victim and clears effects');
  for(const color of ['red','black']){
   await call('demo',color);await advance(566.6667);const before=await state();assert.equal(before.metrics.targetVisualAlive,true);
   const hit=await advance(16.6667);assert.equal(hit.metrics.targetVisualAlive,false);assert.equal(hit.metrics.bones.count,20);assert.ok(hit.metrics.effects.activeParticles>0);
   await advance(80);
   for(const view of color==='red'?['iso','top','front','side']:['iso']){await call('view',view);await advance(0);await capture(`${color}-thrust-${view}`);}
   report.samples[`${color}Impact`]=sample(hit);
   await advance(800);s=await state();assert.equal(s.phase,'ready');assert.equal(s.pieces.length,3);
   s=await advance(1600);assert.equal(s.metrics.effects.activeParticles,0);assert.equal(s.metrics.effects.activeRings,0);assert.equal(s.metrics.effects.projectileVisible,false);
   await call('undo');s=await advance(0);assert.equal(s.pieces.length,4);assert.equal(s.metrics.effects.activeParticles,0);
  }
  report.checks.push('Both original soldier skeletal thrusts keep 0.58 s impact, show bounded sparks/rings, then expire without residue');
  await reset();await page.click('#effects-toggle');s=await advance(0);assert.equal(s.effects.enabled,false);assert.equal(s.metrics.effects.enabled,false);
  await call('demo','red');s=await advance(600);assert.equal(s.metrics.targetVisualAlive,false);assert.equal(s.metrics.effects.activeParticles,0);assert.equal(s.metrics.effects.activeRings,0);await capture('effects-disabled');
  await advance(700);await reset();await page.click('#effects-toggle');await advance(0);
  await page.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await page.waitForFunction(()=>window.godotTest.state().effects.reducedMotion,undefined,{timeout:5000});
  await selectedMove([9,1],[7,2]);s=await advance(330);const horse=s.metrics.visualPieces.find(p=>p.type==='horse'&&p.color==='red'&&p.id===3);
  assert.ok(horse&&Math.abs(horse.position[1]-.62)<.01,'reduced motion removes horse leap');assert.equal(s.metrics.effects.reducedMotion,true);
  await advance(500);await reset();await page.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await page.waitForFunction(()=>!window.godotTest.state().effects.reducedMotion,undefined,{timeout:5000});
  report.checks.push('Real effects checkbox disables/reenables visuals without changing rules; live reduced-motion preference removes secondary motion');
  s=await advance(1800);assert.deepEqual(board(s),initial);assert.equal(s.metrics.effects.activeParticles,0);assert.ok(s.metrics.effects.capacity<=128);
  report.errors=await page.evaluate(()=>[...window.__combatErrors,...window.godotTest.state().errors]);assert.deepEqual(report.errors,[]);
  await capture('final-board');report.samples.final=sample(s);report.passed=true;
 }catch(error){report.failure=error.stack;report.samples.failure=await state().catch(()=>null);await capture('failure').catch(()=>{});}
 await mkdir(resolve(reportPath,'..'),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
 return {passed:report.passed,checks:report.checks,failure:report.failure,reportPath,screenshots:report.screenshots};
}
