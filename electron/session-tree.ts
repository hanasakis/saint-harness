import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveEngine, packageEngine } from './engine-location';
import type { RuntimeManager } from './runtime';
import type { TreeEntry } from '../shared/selection';

function sdkEntry(runtime: RuntimeManager) {
  const cli = resolveEngine(runtime.info().path).cli;
  let directory = path.dirname(cli);
  for (let i = 0; i < 6; i++) {
    if (packageEngine(directory)?.cli === cli) {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const entry = path.resolve(directory, pkg.main || 'dist/index.js');
      if (fs.existsSync(entry)) return entry;
    }
    const next = path.dirname(directory); if (next === directory) break; directory = next;
  }
  throw new Error('当前 Pi 未提供会话树 SDK，请连接应用内置 Pi 后重试');
}

// The worker imports the selected Pi installation, so its session version and
// compaction projection track Pi updates. It never opens the live parent file:
// opening a legacy file can migrate/rewrite it. Only an RPC snapshot is read.
const worker = String.raw`
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
let input='';for await(const part of process.stdin)input+=part;
try {
 const p=JSON.parse(input),{SessionManager}=await import(pathToFileURL(p.sdk).href);
 const source=SessionManager.inMemory(p.cwd,undefined,p.entries);
 const branch=source.getBranch(p.entryId);
 if(!branch.length||branch.at(-1).id!==p.entryId)throw Error('找不到所选消息的树节点');
 // Exclude the entire selected message. Only the exact selection is quoted by
 // the composer when the user sends their follow-up.
 const ancestors=branch.slice(0,-1);
 const child=SessionManager.create(p.cwd,p.directory,{parentSession:p.sourceFile});
 const header=child.getHeader(),file=child.getSessionFile();
 if(!header||!file)throw Error('Pi 未返回可保存的分支');
 const inherited=SessionManager.inMemory(p.cwd,undefined,[header,...ancestors]).buildSessionContext().messages.length;
 fs.writeFileSync(file,[header,...ancestors].map(e=>JSON.stringify(e)).join('\n')+'\n',{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({file,inherited}));
} catch(error){process.stderr.write(error.message);process.exitCode=1;}
`;

export function createSelectionBranch(runtime: RuntimeManager, sourceFile: string, cwd: string, directory: string, entries: TreeEntry[], entryId: string): Promise<{ file: string; inherited: number }> {
  const sdk = sdkEntry(runtime);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'pipe' });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('创建侧边分支超时，请重试')); }, 30_000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error = (error + data).slice(-2000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(error || 'Pi 无法创建会话分支')); return; }
      try {
        const result = JSON.parse(output);
        if (path.dirname(path.resolve(result.file)) !== path.resolve(directory) || !fs.existsSync(result.file)) throw new Error('分支保存位置无效');
        resolve(result);
      } catch (e) { reject(e); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ sdk, sourceFile, cwd, directory, entries, entryId }));
  });
}
