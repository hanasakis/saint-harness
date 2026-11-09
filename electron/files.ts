import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeEntry, Changes, FileEntry } from '../shared/types';
const run = promisify(execFile);
export async function within(root: string, relative: string) {
  const base = await fs.realpath(root); const target = await fs.realpath(path.resolve(base, relative)); const delta = path.relative(base, target);
  if (delta === '..' || delta.startsWith('..' + path.sep) || path.isAbsolute(delta)) throw new Error('只能查看当前工作空间内的文件');
  return target;
}
export async function listFiles(root: string, relative = ''): Promise<FileEntry[]> {
  const directory = await within(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter(e => !['node_modules','.git','.DS_Store'].includes(e.name) && !e.isSymbolicLink()).map(e => ({ name: e.name, path: path.relative(root, path.join(directory, e.name)).replaceAll('\\','/'), directory: e.isDirectory() })).sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).slice(0, 1000);
}
export async function readFile(root: string, relative: string) {
  const file = await within(root, relative); const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('请选择文件'); if (stat.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请在系统编辑器中打开');
  const content = await fs.readFile(file); if (content.includes(0)) throw new Error('二进制文件无法作为文本预览');
  return { path: relative, content: content.toString('utf8') };
}
async function git(root: string, args: string[]) { const { stdout } = await run('git', ['-c','core.quotepath=false', ...args], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }); return stdout; }
export async function changes(root: string): Promise<Changes> {
  try {
    const [status, branch, prefix] = await Promise.all([git(root, ['status','--porcelain=v1','-z','--untracked-files=all','--','.']), git(root, ['branch','--show-current']), git(root,['rev-parse','--show-prefix'])]);
    const chunks = status.split('\0'); const files: ChangeEntry[] = [];
    for (let i = 0; i < chunks.length; i++) { if (!chunks[i]) continue; const state = chunks[i].slice(0, 2); const raw = chunks[i].slice(3); const file = prefix.trim() && raw.startsWith(prefix.trim()) ? raw.slice(prefix.trim().length) : raw; if (state.includes('R') || state.includes('C')) i++; files.push({ path: file, status: state.trim(), additions: 0, deletions: 0, untracked: state === '??' }); }
    let numbers = ''; try { numbers = await git(root, ['diff','--relative','--no-ext-diff','--no-textconv','--numstat','HEAD','--','.']); } catch { numbers = await git(root, ['diff','--relative','--no-ext-diff','--no-textconv','--numstat','--','.']); }
    for (const line of numbers.split('\n')) { const [add, del, ...rest] = line.split('\t'); const match = files.find(f => f.path === rest.join('\t')); if (match) { match.additions = Number(add) || 0; match.deletions = Number(del) || 0; } }
    return { git: true, branch: branch.trim() || 'HEAD', files: files.slice(0, 500) };
  } catch (error) { return { git: false, files: [], error: (error as Error).message.includes('not a git repository') ? undefined : '无法读取 Git 状态，请检查 Git 安装与项目访问权限。' }; }
}
export async function diff(root: string, relative: string) {
  const listing = await changes(root); const entry = listing.files.find(f => f.path === relative);
  if (!entry) throw new Error('文件已无待审阅改动');
  if (entry.untracked) { const file = await readFile(root, relative); return `新文件：${relative}\n` + file.content.split('\n').map(l => '+' + l).join('\n'); }
  // Git status supplies the exact path; arguments never pass through a shell.
  try { return await git(root, ['diff','--no-ext-diff','--no-textconv','HEAD','--',relative]); }
  catch { return await git(root, ['diff','--no-ext-diff','--no-textconv','--',relative]) + await git(root, ['diff','--no-ext-diff','--no-textconv','--cached','--',relative]); }
}
