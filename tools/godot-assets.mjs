/** Verify that the Godot comparison uses the current, unmodified standard GLBs. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, relative} from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const project = resolve(root, 'godot-project');
const reportPath = resolve(root, 'docs/reports/godot-assets.json');
const assetsOnly = process.argv.includes('--assets-only');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = ['general', 'advisor', 'elephant', 'horse', 'chariot', 'cannon', 'soldier'];
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'Project model hashes must match the provenance manifest; compare original source bytes additionally when available. Browser import/animation is checked separately.',
  assetsOnly,
  models: [],
  passed: false,
};

try {
  const manifest = JSON.parse(await readFile(resolve(project, 'asset-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.models.map(model => model.type).sort(), [...types].sort());
  for (const type of types) {
    const entry = manifest.models.find(model => model.type === type);
    const expectedSource = type === 'soldier'
      ? 'assets/models/animated/soldier-standard.glb'
      : `assets/models/readable/${type}-standard.glb`;
    assert.equal(entry.source, expectedSource, `${type} must use the current standard model`);
    assert.equal(entry.tier, 'standard');
    const source = await readFile(resolve(root, expectedSource)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const copiedPath = resolve(project, entry.godotResource);
    const copied = await readFile(copiedPath);
    if (source) assert.ok(copied.equals(source), `${type} was changed during copying`);
    assert.equal(hash(copied), entry.sha256);
    assert.equal(copied.length, entry.bytes);
    assert.equal(copied.readUInt32LE(0), 0x46546c67, 'GLB signature');
    assert.equal(copied.readUInt32LE(4), 2);
    assert.equal(copied.readUInt32LE(8), copied.length);
    assert.equal(copied.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk');
    const jsonLength = copied.readUInt32LE(12);
    const gltf = JSON.parse(copied.subarray(20, 20 + jsonLength).toString('utf8'));
    const binStart = 20 + jsonLength + 8;
    let triangles = 0;
    for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
      assert.equal(primitive.mode ?? 4, 4, `${type} has a non-triangle primitive`);
      triangles += gltf.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3;
    }
    assert.ok(triangles > 9000 && triangles <= 10000, `${type} standard tier triangle budget`);
    const record = {type, resource: relative(project, copiedPath), sha256: hash(copied), bytes: copied.length, triangles, sourceAvailable: Boolean(source), sourceBytesCompared: Boolean(source)};
    if (type === 'soldier') {
      assert.equal(gltf.skins.length, 1);
      const skin = gltf.skins[0];
      assert.equal(skin.joints.length, 20);
      const clip = gltf.animations.find(animation => animation.name === 'SoldierThrust');
      assert.ok(clip, 'SoldierThrust must remain in the imported GLB');
      const channels = clip.channels;
      const durations = channels.map(channel => {
        const accessor = gltf.accessors[clip.samplers[channel.sampler].input];
        assert.equal(accessor.componentType, 5126);
        assert.equal(accessor.type, 'SCALAR');
        const view = gltf.bufferViews[accessor.bufferView];
        return copied.readFloatLE(binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + (accessor.count - 1) * (view.byteStride ?? 4));
      });
      const duration = Math.max(...durations);
      assert.ok(Math.abs(duration - 1.2) < 1e-5);
      assert.ok(channels.length >= 20);
      const joints = new Set(skin.joints);
      assert.ok(channels.every(channel => joints.has(channel.target.node)), 'animation must drive skin joints');
      let weightedMeshes = 0;
      for (const node of gltf.nodes.filter(node => node.skin !== undefined)) {
        for (const primitive of gltf.meshes[node.mesh].primitives) {
          assert.ok(primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined);
          weightedMeshes++;
        }
      }
      assert.ok(weightedMeshes > 0);
      Object.assign(record, {skins: 1, bones: 20, animation: clip.name, duration, channels: channels.length, weightedMeshes});
    }
    report.models.push(record);
  }
  if (!assetsOnly) {
    const config = await readFile(resolve(project, 'project.godot'), 'utf8');
    const presets = await readFile(resolve(project, 'export_presets.cfg'), 'utf8');
    assert.match(config, /renderer\/rendering_method\s*=\s*"gl_compatibility"/);
    assert.match(presets, /platform\s*=\s*"Web"/);
    assert.match(presets, /variant\/thread_support\s*=\s*false/);
    const wasm = await readFile(resolve(root, 'godot/index.wasm'));
    assert.deepEqual([...wasm.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0], 'valid WebAssembly header');
    const pck = await readFile(resolve(root, 'godot/index.pck'));
    assert.equal(pck.subarray(0, 4).toString(), 'GDPC', 'actual Godot resource package');
    const script = await readFile(resolve(root, 'godot/index.js'), 'utf8');
    assert.match(script, /Godot/);
    const html = await readFile(resolve(root, 'godot/index.html'), 'utf8');
    assert.match(html, /index\.js/);
    report.export = {wasmBytes: wasm.length, pckBytes: pck.length, wasmSha256: hash(wasm), pckSha256: hash(pck), singleThreaded: true, renderingMethod: 'gl_compatibility'};
  }
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  await mkdir(resolve(root, 'docs/reports'), {recursive: true});
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
