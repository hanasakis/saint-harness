import fs from 'node:fs';
import path from 'node:path';
import type { EngineCandidate } from '../shared/types';

const packages = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'];
const isFile = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

export function packageEngine(directory: string): EngineCandidate | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (!packages.includes(pkg.name)) return;
    const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
    if (typeof entry !== 'string') return;
    const cli = path.resolve(directory, entry);
    const relative = path.relative(directory, cli);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !isFile(cli)) return;
    return { cli: fs.realpathSync(cli), version: typeof pkg.version === 'string' ? pkg.version : '未知版本', source: '本地安装' };
  } catch { return; }
}

export function resolveEngine(input: string): EngineCandidate {
  const target = path.resolve(input);
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch { throw new Error('所选位置不存在，请重新选择 Pi 安装文件夹或入口文件。'); }
  if (stat.isDirectory()) {
    const locations = [target, ...packages.flatMap(p => [path.join(target,'node_modules',p), path.join(target,p), path.join(target,'lib/node_modules',p)]), path.join(target,'packages/coding-agent')];
    for (const location of locations) { const result = packageEngine(location); if (result) return result; }
    if (isFile(path.join(target,'pi.exe'))) return resolveEngine(path.join(target,'pi.exe'));
    throw new Error('此文件夹内没有找到可运行的 Pi。请选择安装目录（包含 node_modules）或 pi-coding-agent 包目录；压缩包需先解压，源码需先构建。');
  }
  if (/\.(cmd|bat|ps1)$/i.test(target)) {
    // Resolve npm launchers to JS; never execute an arbitrary shell wrapper.
    if (!/^pi\.(cmd|bat|ps1)$/i.test(path.basename(target))) throw new Error('请选择 Pi 的入口文件。');
    return resolveEngine(path.dirname(target));
  }
  if (!/\.(?:[cm]?js|exe)$/i.test(target)) throw new Error('请选择 Pi 的 cli.js、pi.exe，或 npm 安装产生的 pi.cmd 文件。');
  let parent = path.dirname(target);
  for (let i = 0; i < 5; i++) {
    const candidate = packageEngine(parent);
    if (candidate && candidate.cli.toLowerCase() === fs.realpathSync(target).toLowerCase()) return candidate;
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  return { cli: fs.realpathSync(target), version: '版本待验证', source: '本地入口' };
}

export function discoverEngines(locations: { path: string; source: string; managedRoot?: string }[]): EngineCandidate[] {
  const found = new Map<string, EngineCandidate>();
  for (const location of locations) {
    try {
      const candidate = resolveEngine(location.path); const key = candidate.cli.toLowerCase();
      if (!found.has(key)) found.set(key, { ...candidate, source: location.source, managedRoot: location.managedRoot });
    } catch { /* Missing locations are ordinary during detection. */ }
  }
  return [...found.values()];
}

export function localSearchPaths(env = process.env) {
  const prefixes = [env.APPDATA && path.join(env.APPDATA,'npm'), env.npm_config_prefix, ...((env.PATH || env.Path || '').split(path.delimiter))];
  return [...new Set(prefixes.filter((p): p is string => !!p && path.isAbsolute(p)))];
}
