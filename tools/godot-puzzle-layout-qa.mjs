/** Layout acceptance on an existing ready Ego Page. Never opens or navigates a browser. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const selectors=['#mode-game','#mode-puzzle','#puzzle-select','#puzzle-goal',
  '#puzzle-hint','#puzzle-demo','#puzzle-previous','#puzzle-next','#keyboard-focus'];

export async function runGodotPuzzleLayoutQa(page,{
  output=resolve(root,'output/godot-puzzles'),
  reportPath=resolve(root,'docs/reports/godot-puzzles-layout.json'),
}={}){
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),passed:false,
    scope:'Two desktop viewports at DPR 1. Layout and discoverability only; no mobile or performance claim.',
    checks:[],viewports:[],screenshots:[]};
  await mkdir(output,{recursive:true});
  const state=()=>page.evaluate(()=>window.godotTest.state());
  const advance=()=>page.evaluate(()=>window.godotTest.advanceTime(0));
  const storage=()=>page.evaluate(()=>localStorage.getItem('chess-cn.progress.v1'));
  const capture=async name=>{const path=resolve(output,`layout-${name}.png`);await page.screenshot({path});report.screenshots.push(path);};
  let productionBefore,storageRead=false;
  try{
    const initial=await page.evaluate(()=>({url:location.href,state:window.godotTest?.state()}));
    report.url=initial.url;
    assert.equal(new URL(initial.url).searchParams.get('test'),'1','Layout QA requires isolated ?test=1 storage');
    assert.equal(initial.state?.testMode,true);
    assert.equal(initial.state?.runtimeReady,true,'Pass a page whose Godot runtime is already ready');
    productionBefore=await storage();storageRead=true;
    if(!initial.state.puzzle?.active){
      const result=await page.evaluate(()=>window.godotTest.puzzle('mode',true));
      assert.equal(result?.ok,true,result?.reason||'Could not enter puzzle mode');
    }
    await page.waitForFunction(()=>{const s=window.godotTest.state().puzzle;return !s.loading&&(s.view||s.warning);},undefined,{timeout:30000});
    assert.ok((await state()).puzzle.view,(await state()).puzzle.warning||'Puzzle view unavailable');
    const chosen=await page.evaluate(()=>window.godotTest.puzzle('choose','preview-01'));
    assert.equal(chosen?.ok,true,chosen?.reason||'Could not choose first preview');
    await page.waitForFunction(()=>{const s=window.godotTest.state().puzzle;return s.view?.puzzle.id==='preview-01'&&s.view.phase==='playerTurn';},undefined,{timeout:30000});
    await advance();

    for(const [width,height] of [[1368,781],[1100,800]]){
      await page.cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      if(await page.evaluate(()=>document.querySelector('#keyboard-details').open))await page.click('#keyboard-details>summary');
      await page.evaluate(()=>scrollTo(0,0));
      await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
      await advance();
      const layout=await page.evaluate(selectors=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
        documentWidth:document.documentElement.scrollWidth,
        controls:Object.fromEntries(selectors.map(selector=>{
          const element=document.querySelector(selector),r=element.getBoundingClientRect(),css=getComputedStyle(element);
          const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return[selector,{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,
            visible:r.width>0&&r.height>0&&css.visibility!=='hidden'&&css.display!=='none',
            unobscured:hit===element||element.contains(hit)}];
        })),
      }),selectors);
      report.viewports.push(layout);
      assert.equal(layout.width,width);assert.equal(layout.height,height);assert.equal(layout.dpr,1);
      assert.ok(layout.documentWidth<=width+1,`${width}: page has horizontal overflow`);
      for(const [selector,r] of Object.entries(layout.controls)){
        assert.ok(r.visible&&r.unobscured,`${width}: ${selector} must be visible and unobscured`);
        assert.ok(r.x>=-1&&r.y>=-1&&r.right<=width+1&&r.bottom<=height+1,`${width}: ${selector} must fit in the first viewport`);
      }
      const entries=Object.entries(layout.controls);
      for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
        const [aLabel,a]=entries[i],[bLabel,b]=entries[j];
        const overlapX=Math.min(a.right,b.right)-Math.max(a.x,b.x);
        const overlapY=Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y);
        assert.ok(overlapX<=1||overlapY<=1,`${width}: ${aLabel} overlaps ${bLabel}`);
      }
      await capture(`${width}x${height}`);
      report.checks.push(`${width}×${height} DPR 1: modes, level selection, goal, hint, demo, previous/next and keyboard entry fit without overlap or horizontal overflow`);

      await page.click('#keyboard-details>summary');
      const help=await page.evaluate(()=>{
        const details=document.querySelector('#keyboard-details'),container=document.querySelector('#keyboard-help');
        return{open:details.open,text:container.innerText,
          keys:[...details.querySelectorAll('kbd')].filter(element=>['U','R'].includes(element.textContent.trim())).map(element=>({key:element.textContent.trim(),visible:element.getBoundingClientRect().height>0&&getComputedStyle(element).visibility!=='hidden'}))};
      });
      assert.equal(help.open,true,'Keyboard instructions expand');
      for(const key of ['U','R'])assert.ok(help.keys.some(item=>item.key===key&&item.visible),`${width}: visible ${key} shortcut`);
      assert.match(help.text,/悔棋/);assert.match(help.text,/重新开局/);assert.match(help.text,/Tab/,'Visible instructions explain Tab navigation');
      layout.expandedKeyboard={undo:true,restart:true,tab:true};
      await page.click('#keyboard-details>summary');
      await page.evaluate(()=>scrollTo(0,0));
    }
    assert.equal(await storage(),productionBefore,'Production progress must remain untouched');
    report.checks.push('Expanded keyboard instructions expose U/R and Tab; production progress is unchanged');
    report.passed=true;
  }catch(error){report.failure=error.stack||error.message;await capture('failure').catch(()=>{});}
  finally{
    try{await page.cdp('Emulation.clearDeviceMetricsOverride');}
    catch(error){report.passed=false;report.cleanupFailure=error.message;}
    if(storageRead&&await storage().catch(()=>undefined)!==productionBefore){report.passed=false;report.storageFailure='Production progress changed during layout acceptance';}
    await mkdir(dirname(reportPath),{recursive:true});
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  }
  return{passed:report.passed,checks:report.checks,failure:report.failure||report.cleanupFailure||report.storageFailure,reportPath,screenshots:report.screenshots};
}
