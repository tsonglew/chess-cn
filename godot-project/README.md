# Godot 网页对照版

独立部署在 https://tsonglew.github.io/chess-cn/godot/ 。仓库根目录继续提供原 Three.js 游戏。

本版用 Godot 4.7.2 的 Compatibility 渲染器绘制棋盘、七种棋子及兵的骨骼突刺；网页控制层复用现有 JavaScript 象棋规则。它是浏览器对照原型，不代表原游戏全部演出、音效、关卡或原生平台已迁移。

## 开发与构建

1. 安装 Godot **4.7.2 stable** 和相同版本的 Web 导出模板。
2. 在 Godot 中打开本目录的 `project.godot`，或在仓库根目录运行 `node tools/build-godot.mjs`。可用 `GODOT_BIN` 指定编辑器可执行文件。
3. 在仓库根目录运行 `python3 -m http.server 8000`，打开 `http://localhost:8000/godot/`。

源码在本目录，生成的静态站点在 `../godot/`。`web/shell.html` 是自定义 HTML 模板；不要手改导出的 `index.html`。构建脚本不会修改 Three.js 的 HTML、JavaScript 或资产。

单线程导出关闭 GDExtension 和 PWA，不需要 COOP/COEP 响应头或 Service Worker。运行需要浏览器支持 WebAssembly 与 WebGL 2。导出产物 `index.html/js/wasm/pck` 必须一起部署，并保留文件名和相对路径。

## 资产复用

`asset-manifest.json` 记录复制来源及 SHA-256。`models/` 中七个文件与当前 Three.js 的 standard 档 GLB 完全相同；兵使用 `assets/models/animated/soldier-standard.glb`，其余使用 `assets/models/readable/*-standard.glb`。Godot 导入后在 PCK 内保存引擎资源。

兵的原动画为 `SoldierThrust`，时长 1.2 秒，命中时刻 0.58 秒。棋盘位移与朝向由运行时控制，关节运动来自 GLB 动画。字体沿用本项目的中文子集，许可见 `fonts/`；引擎及第三方许可见 `licenses/`。

## 发布与回滚

现有 GitHub Pages 使用 `master` 分支根目录。发布只需更新 `godot/` 及对应源码/构建脚本，保持根目录 Three.js 文件不变。浏览器入口为 `/chess-cn/godot/`，返回链接为 `../`。

回滚时撤销仅增加/修改 Godot 子目录的发布提交即可；原首页无需切换。不要将本地其他未完成的 Three.js 修改一并提交。

## 验收入口

页面提供正常棋局、红兵/黑卒突刺演示、重播、悔棋、重开、四个视角和名字标签开关。`?test=1` 使用可控时间供自动化验收；普通用户使用不带该参数的网址。

运行 `node tools/godot-assets.mjs` 检查模型哈希、骨骼与动画和 Web 导出配置。原 Three.js 源模型不在当前检出中时，此脚本仍校验复制模型与资产清单的一致性，并明确标注没有执行源文件比对。

运行 `Godot --headless --path godot-project --script tests/runtime_smoke.gd` 验证模型切换、真实骨骼前刺、命中时序、落点和32枚棋子恢复（将 `Godot` 替换为本机可执行文件）。浏览器验收使用 `tools/godot-browser-acceptance.mjs` 导出的 `runGodotAcceptance(page, options)`；`page` 为 ego-browser 当前任务空间中的页面，不另启动浏览器。

编辑器原生运行可预览棋盘；本轮交互规则通过 Web JavaScriptBridge 接入。Godot 导入器保留默认网格 LOD，桌面采样因此不能直接与旧 Three.js 数据做同条件性能比较。浏览器验收与实测结论见 `docs/reports/godot-*`。移动端真机验证不在此次范围内。
