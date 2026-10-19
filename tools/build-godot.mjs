#!/usr/bin/env node
// Build the parallel /godot/ site without touching the Three.js application.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'godot-project');
const output = path.join(root, 'godot');
const godot = process.env.GODOT_BIN || (existsSync('/Applications/Godot.app/Contents/MacOS/Godot') ? '/Applications/Godot.app/Contents/MacOS/Godot' : 'godot');
function run(args) {
  const result = spawnSync(godot, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  // Godot can return 0 despite GDScript/import errors; reject those builds too.
  if (result.error || result.status !== 0 || /(?:SCRIPT ERROR:|ERROR:)/.test(`${result.stdout}\n${result.stderr}`)) {
    throw result.error || new Error(`Godot failed: ${args.join(' ')}`);
  }
  return result.stdout.trim();
}
mkdirSync(output, { recursive: true });
const version = run(['--version']);
run(['--headless', '--path', project, '--import']);
run(['--headless', '--path', project, '--export-release', 'Web', path.join(output, 'index.html')]);
const htmlPath = path.join(output, 'index.html');
writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace(/[\t ]+$/gm, '').trimEnd() + '\n');
for (const name of ['host.js', 'puzzle-mode.js', 'puzzle-ui.js', 'style.css', 'rules.js']) copyFileSync(path.join(project, 'web', name), path.join(output, name));
// These are browser ES modules/data, deliberately outside the Godot PCK.
// Replace generated contents so a removed level cannot survive a later build.
rmSync(path.join(output, 'puzzle'), { recursive: true, force: true });
cpSync(path.join(project, 'web', 'puzzle'), path.join(output, 'puzzle'), { recursive: true });
copyFileSync(path.join(project, 'asset-manifest.json'), path.join(output, 'asset-manifest.json'));
copyFileSync(path.join(project, 'fonts', 'OFL.txt'), path.join(output, 'FONT-LICENSE.txt'));
copyFileSync(path.join(project, 'fonts', 'NOTICE.txt'), path.join(output, 'FONT-NOTICE.txt'));
for (const name of ['GODOT-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']) copyFileSync(path.join(project, 'licenses', name), path.join(output, name));
function listFiles(directory, prefix = '') {
  return readdirSync(directory).filter(name => !name.startsWith('.') && !(prefix === '' && name === 'build-manifest.json')).sort().flatMap(name => {
    const full = path.join(directory, name), relative = prefix + name;
    return statSync(full).isDirectory() ? listFiles(full, relative + '/') : statSync(full).isFile() ? [relative] : [];
  });
}
const files = listFiles(output).map(name => {
  const data = readFileSync(path.join(output, name));
  return { name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
});
const manifest = { engine: version, variant: 'web_nothreads_release', renderer: 'gl_compatibility', generatedAt: new Date().toISOString(), files };
writeFileSync(path.join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, engine: version, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0) }, null, 2));
