import {createInitialState, pieceAt, legalMoves, applyMove, undo as undoRules, gameStatus, GLYPH} from './rules.js';

const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const views = {iso:'斜俯视角',top:'俯视视角',front:'正面视角',side:'侧面视角'};
const testMode = new URLSearchParams(location.search).get('test') === '1';
const beganAt = performance.now();
let state = createInitialState();
let callback = null;
let runtimeReady = false;
let phase = 'loading';
let mode = 'game';
let selectedId = null;
let selectedMoves = [];
let camera = 'iso';
let focus = null;
let labels = true;
let metrics = {};
let runtime = {};
let error = null;
let errors = [];
let animation = {phase:'idle',clip:null,time:0,trace:[]};
let lastDemo = 'red';
let hint = '点击棋子，再选择高亮落点。';
let engine = null;
let completedMoves = 0;
let nextRequestId = 1;
const pendingInspections = new Map();

function result(ok, reason) { return {ok, ...(reason ? {reason} : {})}; }
function send(command) {
  if (!callback) return false;
  try { callback(JSON.stringify(command)); return true; }
  catch (err) { fail(err); return false; }
}
function sync() {
  return send({type:'sync',state:clone(state),selectedId,legalMoves:clone(selectedMoves),testMode,config:{testMode}});
}
function clearSelection() { selectedId = null; selectedMoves = []; }
function status() { return gameStatus(state); }
function snapshot() {
  return clone({runtimeReady,phase,testMode,mode,turn:state.turn,pieces:state.pieces,selectedId,
    legalMoves:selectedMoves,lastMove:state.lastMove,historyLength:state.history.length,
    completedMoves,status:status(),animation,camera,focus,labels,metrics,runtime,error,errors,
    coordinates:'row 0..9 (black home to red home); col 0..8 (red left to right)',
  });
}
function render() {
  const busy = !runtimeReady || phase === 'moving' || phase === 'error';
  const currentStatus = status();
  const red = state.turn === 'red';
  $('turn-seal').textContent = red ? '红' : '黑';
  $('turn-seal').className = `turn-seal ${red ? 'red' : 'black'}`;
  $('turn-text').textContent = phase === 'moving' ? '行棋演出中' : currentStatus.over
    ? `${currentStatus.winner === 'red' ? '红' : '黑'}方胜出`
    : `${red ? '红' : '黑'}方${currentStatus.check ? '被将军' : state.history.length ? '行棋' : '先行'}`;
  $('game-hint').textContent = hint;
  $('mode-label').textContent = mode === 'game' ? '自由对弈' : `${lastDemo === 'red' ? '红兵' : '黑卒'}演示`;
  $('undo-button').disabled = busy || !state.history.length;
  $('restart-button').disabled = busy;
  $('demo-red').disabled = busy;
  $('demo-black').disabled = busy;
  $('replay-button').disabled = busy || !mode.startsWith('demo-');
  $('labels-toggle').disabled = !runtimeReady || phase === 'error';
  $('labels-toggle').checked = labels;
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.disabled = !runtimeReady || phase === 'error';
    button.setAttribute('aria-pressed', String(button.dataset.view === camera));
  });
  $('view-caption').textContent = `${focus ? '近景 · ' : ''}${views[camera] || views.iso}`;
  $('ready-dot').className = `ready-dot ${error ? 'error' : runtimeReady ? 'active' : ''}`;
  $('runtime-state').textContent = error ? '引擎发生错误' : runtimeReady ? 'Godot 已就绪' : '引擎加载中';
  const fps = Number(metrics.fps ?? metrics.frames_per_second);
  $('performance').textContent = runtimeReady && !(Number(metrics.elapsed) >= 2)
    ? '采样中' : Number.isFinite(fps) ? `${Math.round(fps)} FPS` : '— FPS';
  const elapsed = Math.max(0, Math.min(1.2, Number(animation.time) || 0));
  $('motion-progress').style.width = `${elapsed / 1.2 * 100}%`;
  $('motion-time').textContent = `${elapsed.toFixed(2)} / 1.20 s`;
  $('motion-phase').textContent = {idle:'等待演示',start:'起势 · 突刺',impact:'命中',end:'收势完成'}[animation.phase] || '动作播放中';
}
function canPlay() { return runtimeReady && phase === 'ready'; }
function selectedPiece() { return state.pieces.find((piece) => piece.id === selectedId); }
function select(row, col) {
  if (!canPlay()) return result(false, 'runtime_busy');
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 9 || col < 0 || col > 8) return result(false, 'out_of_board');
  const piece = pieceAt(state.pieces,row,col);
  if (!piece || piece.color !== state.turn) return result(false,'not_current_side');
  if (status().over) return result(false,'game_over');
  selectedId = piece.id;
  selectedMoves = legalMoves(state.pieces,piece);
  hint = `已选${piece.color === 'red' ? '红' : '黑'}${GLYPH[piece.color][piece.type]}，${selectedMoves.length ? '点击高亮落点行棋。' : '目前没有合法落点。'}`;
  sync(); render();
  return result(true);
}
function move(...args) {
  if (!canPlay()) return result(false,'runtime_busy');
  let piece, row, col;
  if (args.length === 3) { piece = state.pieces.find((entry) => entry.id === args[0]); [,row,col] = args; }
  else { piece = selectedPiece(); [row,col] = args; }
  if (!piece || piece.color !== state.turn) return result(false,'not_current_side');
  if (status().over) return result(false,'game_over');
  if (!legalMoves(state.pieces,piece).some((square) => square.row === row && square.col === col)) return result(false,'illegal_move');
  const before = clone(state);
  const from = {row:piece.row,col:piece.col};
  const to = {row,col};
  const captured = applyMove(state,piece,to);
  const receipt = {pieceId:piece.id,from,to,capturedId:captured?.id ?? null};
  clearSelection();
  phase = 'moving';
  animation = {phase:'idle',clip:null,time:0,trace:[]};
  hint = `${piece.color === 'red' ? '红' : '黑'}${GLYPH[piece.color][piece.type]}${captured ? '进击' : '行棋'}中…`;
  const sent = send({type:'move',before,after:clone(state),move:receipt});
  render();
  return result(sent,sent ? undefined : 'runtime_unavailable');
}
function square(row,col) {
  if (!canPlay()) return result(false,'runtime_busy');
  if (selectedId !== null && selectedMoves.some((entry) => entry.row === row && entry.col === col)) return move(row,col);
  const piece = pieceAt(state.pieces,row,col);
  if (piece?.color === state.turn) return select(row,col);
  clearSelection(); hint = '点击己方棋子，查看合法落点。'; sync(); render();
  return result(false,'not_current_side');
}
function reset(nextState, nextMode) {
  state = nextState; mode = nextMode; clearSelection();
  animation = {phase:'idle',clip:null,time:0,trace:[]};
  hint = '点击棋子，再选择高亮落点。';
  phase = 'ready'; sync(); render();
}
function restart() {
  if (!canPlay()) return result(false,'runtime_busy');
  focus = null; send({type:'focus',active:false});
  reset(createInitialState(),'game');
  return result(true);
}
function undo() {
  if (!canPlay()) return result(false,'runtime_busy');
  if (!undoRules(state)) return result(false,'no_history');
  clearSelection(); animation = {phase:'idle',clip:null,time:0,trace:[]};
  hint = '已撤回一步。'; sync(); render();
  return result(true);
}
function demo(color = 'red') {
  if (!canPlay()) return result(false,'runtime_busy');
  if (!['red','black'].includes(color)) return result(false,'invalid_color');
  const pieces = [
    {id:1,type:'general',color:'red',row:9,col:4},
    {id:2,type:'general',color:'black',row:0,col:3},
    {id:3,type:'soldier',color:'red',row:6,col:0},
    {id:4,type:'soldier',color:'black',row:5,col:0},
  ];
  if (color === 'black') for (const piece of pieces) {
    piece.row = 9-piece.row; piece.col = 8-piece.col;
    piece.color = piece.color === 'red' ? 'black' : 'red';
  }
  lastDemo = color;
  reset({pieces,turn:color,history:[],lastMove:null},`demo-${color}`);
  focus = {row:color === 'red' ? 5.5 : 3.5,col:color === 'red' ? 0 : 8};
  send({type:'focus',active:true,...focus});
  return move(3,color === 'red' ? 5 : 4,color === 'red' ? 0 : 8);
}
function view(name) {
  if (!runtimeReady || phase === 'error') return result(false,'runtime_unavailable');
  if (!Object.hasOwn(views,name)) return result(false,'invalid_view');
  camera = name; send({type:'camera',view:name}); render(); return result(true);
}
function showLabels(visible) {
  if (!runtimeReady || phase === 'error') return result(false,'runtime_unavailable');
  labels = Boolean(visible); send({type:'labels',visible:labels}); render(); return result(true);
}
function inspect() { send({type:'inspect'}); return snapshot(); }
function awaitInspection() {
  const requestId = nextRequestId++;
  return new Promise((resolve,reject) => {
    const timeout = setTimeout(() => {
      pendingInspections.delete(requestId);
      reject(new Error('Godot inspection timed out.'));
    },5000);
    pendingInspections.set(requestId,() => { clearTimeout(timeout); resolve(); });
    if (!send({type:'inspect',requestId})) {
      clearTimeout(timeout); pendingInspections.delete(requestId);
      reject(new Error('Godot runtime is unavailable.'));
    }
  });
}
async function advanceTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('advanceTime(ms) requires a non-negative finite duration.');
  if (runtimeReady) { send({type:'advance',ms}); await awaitInspection(); }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return snapshot();
}
function fail(reason) {
  error = reason instanceof Error ? reason.message : String(reason);
  errors.push(error); phase = 'error';
  $('loading').hidden = false; $('loading').classList.add('failed');
  $('loading-title').textContent = '棋局未能启动';
  $('loading-detail').textContent = error;
  $('reload-button').hidden = false; render();
  console.error('[Godot host]',error);
}

window.GodotHost = {
  registerCallback(value) { callback = value; },
  receive(raw) {
    let event;
    try { event = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (err) { fail(`Godot 事件解析失败：${err.message}`); return; }
    if (!event || typeof event !== 'object') return;
    const type = event.type ?? event.event;
    if (type === 'ready') {
      if (error) return;
      runtimeReady = true; phase = 'ready'; runtime = {...runtime,...event};
      metrics.startupMs = Math.round(performance.now()-beganAt);
      $('loading').hidden = true;
      const version = typeof event.engine === 'string' ? event.engine : event.engine?.version ?? event.version;
      if (version) $('engine-version').textContent = `${version.toLowerCase().startsWith('godot') ? '' : 'Godot '}${version} · WebGL 2`;
      queueMicrotask(() => { sync(); send({type:'camera',view:camera}); send({type:'labels',visible:labels}); send({type:'inspect'}); });
    } else if (type === 'square') {
      square(Number(event.row),Number(event.col));
    } else if (type === 'move_done') {
      phase = 'ready'; completedMoves++;
      hint = mode.startsWith('demo-') ? '可切换视角、再次演示，或重新开局。' : '点击棋子，再选择高亮落点。';
      // The scene owns the completed placement. Sync only clears highlights and
      // reconciles the rule state; it must not trigger a second animation.
      queueMicrotask(sync);
    } else if (type === 'animation') {
      const point = {phase:event.phase,clip:event.clip ?? 'SoldierThrust',time:Number(event.time) || 0};
      animation = {...animation,...point,trace:[...animation.trace,point].slice(-30)};
    } else if (type === 'metrics') {
      metrics = {...metrics,...(event.metrics ?? event)};
      // Runtime metrics retain the last completed clip for diagnostics. Only
      // animation events change the UI phase; otherwise undo/reset would revive
      // an old completion state. Metrics provide time within the active clip.
      if (metrics.animating && animation.clip && Number.isFinite(metrics.animationTime)) animation.time = metrics.animationTime;
    } else if (type === 'camera') {
      if (Object.hasOwn(views,event.view)) camera = event.view;
    } else if (type === 'inspect' || type === 'snapshot' || type === 'state') {
      runtime = {...runtime,...(event.snapshot ?? event.state ?? event)};
    } else if (type === 'error') {
      fail(event.message ?? event.error ?? 'Godot 运行错误');
    }
    render();
    const resolveInspection = pendingInspections.get(event.requestId);
    if (resolveInspection) { pendingInspections.delete(event.requestId); resolveInspection(); }
  },
};
window.render_game_to_text = () => JSON.stringify(snapshot());
window.advanceTime = advanceTime;
window.godotTest = {state:snapshot,select,move,square,demo,view,labels:showLabels,advanceTime,undo,restart,inspect};

$('undo-button').addEventListener('click',undo);
$('restart-button').addEventListener('click',restart);
$('demo-red').addEventListener('click',() => demo('red'));
$('demo-black').addEventListener('click',() => demo('black'));
$('replay-button').addEventListener('click',() => demo(lastDemo));
$('labels-toggle').addEventListener('change',(event) => showLabels(event.target.checked));
$('reload-button').addEventListener('click',() => location.reload());
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click',() => view(button.dataset.view)));
document.addEventListener('keydown',(event) => {
  if (event.key.toLowerCase() !== 'f' || event.altKey || event.ctrlKey || event.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  event.preventDefault();
  const request = document.fullscreenElement ? document.exitFullscreen?.() : $('canvas-wrap').requestFullscreen?.();
  request?.catch(() => {});
});
render();

async function start() {
  if (typeof window.Engine !== 'function') throw new Error('引擎脚本加载失败，请检查网络后重试。');
  const missing = window.Engine.getMissingFeatures({threads:false});
  if (missing.length) throw new Error(`浏览器缺少 ${missing.join('、')}。请使用支持 WebGL 2 与 WebAssembly 的浏览器。`);
  engine = new window.Engine(window.GODOT_EXPORT_CONFIG);
  const canvas = $('canvas');
  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1,1.5);
    canvas.width = Math.max(1,Math.round(bounds.width*ratio));
    canvas.height = Math.max(1,Math.round(bounds.height*ratio));
  };
  resize();
  new ResizeObserver(resize).observe($('canvas-wrap'));
  await engine.startGame({canvas,canvasResizePolicy:0,focusCanvas:false,
    onProgress(current,total) {
      if (total > 0) {
        $('loading-progress').value = current; $('loading-progress').max = total;
        $('loading-detail').textContent = current < total ? `正在载入资源 · ${Math.min(100,Math.round(current/total*100))}%` : '正在准备三维棋盘…';
      } else $('loading-progress').removeAttribute('value');
    },
    onPrintError(...lines) {
      const line = lines.join(' ');
      if (/^\s*(?:ERROR|SCRIPT ERROR|FATAL(?: ERROR)?|Parse Error):/i.test(line)) fail(line);
      else { errors.push(line); console.warn('[Godot]',line); }
    },
    onExit(code) { if (code !== 0 || runtimeReady) fail(`Godot 已退出（${code}）。请重新加载。`); },
  });
}
start().catch(fail);
