import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Store } from './store';

const key = (file: string) => path.resolve(file).toLowerCase();
function inside(root: string, file: string) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function managedFile(root: string, file: string) {
  if (!inside(root, file)) throw new Error('会话文件超出应用数据目录，已停止删除');
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(fs.realpathSync(root), fs.realpathSync(file))) throw new Error('会话文件指向应用数据目录之外，已停止删除');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function sessionFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [], pending = [root];
  while (pending.length) {
    for (const entry of fs.readdirSync(pending.pop()!, { withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(file);
    }
  }
  return result;
}
async function inspectSession(file: string) {
  const attachments = new Set<string>(); let id: string | undefined, readable = true;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session' && typeof entry.id === 'string') id = entry.id;
        if (entry.message?.role !== 'user') continue;
        const content = entry.message.content;
        const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text) : [];
        for (const text of texts) for (const match of String(text).matchAll(/<attachment>\r?\n([^\r\n]+)/g)) {
          try { const metadata = JSON.parse(match[1]); if (typeof metadata.localPath === 'string') attachments.add(metadata.localPath); } catch { /* Not an app-generated attachment record. */ }
        }
      } catch { readable = false; }
    }
  } catch { readable = false; }
  finally { lines.close(); input.destroy(); }
  return { id, attachments, readable };
}

export async function permanentlyDelete(store: Store, kind: 'project' | 'thread', id: string) {
  const item = kind === 'project' ? store.project(id) : store.thread(id);
  const archived = item.archivedAt || (kind === 'thread' && store.projectFor(store.thread(id)).archivedAt);
  if (!archived) throw new Error('只能永久删除已归档的项目或会话，请先归档');
  const targets = store.data.threads.filter(t => kind === 'project' ? t.projectId === id : t.id === id);
  const targetIds = new Set(targets.map(t => t.id));
  if (store.data.activeThreadId && targetIds.has(store.data.activeThreadId)) throw new Error('此会话仍在使用中，请先切换会话');
  const remaining = store.data.threads.filter(t => !targetIds.has(t.id));
  const sessionRoot = path.join(store.directory, 'sessions'), attachmentRoot = path.join(store.directory, 'attachments');
  for (const root of [sessionRoot, attachmentRoot]) if (fs.existsSync(root) && (fs.lstatSync(root).isSymbolicLink() || !inside(fs.realpathSync(store.directory), fs.realpathSync(root)))) throw new Error('应用数据目录被重定向，已停止删除');
  const files = new Set(sessionFiles(sessionRoot));
  const targetPaths = new Set<string>();
  for (const thread of targets) if (thread.sessionFile) {
    if (managedFile(sessionRoot, thread.sessionFile)) files.add(thread.sessionFile);
    targetPaths.add(key(thread.sessionFile));
  }
  const records = new Map<string, Awaited<ReturnType<typeof inspectSession>>>();
  for (const file of files) records.set(key(file), await inspectSession(file));
  const targetPiIds = new Set(targets.map(t => t.sessionFile && records.get(key(t.sessionFile))?.id).filter(Boolean));
  const protectedPaths = new Set(remaining.flatMap(t => t.sessionFile ? [key(t.sessionFile)] : []));
  const protectedPiIds = new Set(remaining.map(t => t.sessionFile && records.get(key(t.sessionFile))?.id).filter(Boolean));
  const deletingFiles = [...files].filter(file => {
    const piId = records.get(key(file))?.id;
    return !protectedPaths.has(key(file)) && !(piId && protectedPiIds.has(piId)) && (targetPaths.has(key(file)) || !!piId && targetPiIds.has(piId));
  }).sort((a, b) => Number(targetPaths.has(key(a))) - Number(targetPaths.has(key(b))));
  const deletingPaths = new Set(deletingFiles.map(key));
  const attachments = new Set(targets.flatMap(t => t.attachmentPaths || []));
  const protectedAttachments = new Set(remaining.flatMap(t => (t.attachmentPaths || []).map(key)));
  // A corrupt or externally stored retained session may contain unknown references.
  // In that case preserve caches rather than risk removing another session's input.
  let cleanupAttachments = !remaining.some(t => t.sessionFile && fs.existsSync(t.sessionFile) && !records.has(key(t.sessionFile)));
  for (const [file, record] of records) {
    if (deletingPaths.has(file)) record.attachments.forEach(p => attachments.add(p));
    else { if (!record.readable) cleanupAttachments = false; record.attachments.forEach(p => protectedAttachments.add(key(p))); }
  }
  const attachmentFiles = cleanupAttachments ? [...attachments].filter(file => {
    if (protectedAttachments.has(key(file)) || !inside(attachmentRoot, file)) return false;
    // Cache files live exactly one generated directory below attachments/.
    return key(path.dirname(path.dirname(file))) === key(attachmentRoot) && managedFile(attachmentRoot, file);
  }) : [];
  // Validate all paths before the first irreversible unlink. Never remove a project
  // directory recursively: migrated sessions can still have files in that directory.
  for (const file of deletingFiles) managedFile(sessionRoot, file);
  try {
    for (const file of [...attachmentFiles, ...deletingFiles]) {
      const root = deletingPaths.has(key(file)) ? sessionRoot : attachmentRoot;
      if (managedFile(root, file)) await fs.promises.unlink(file);
    }
  } catch (error) { throw new Error(`删除未完成，归档条目已保留，请重试。部分文件可能已删除：${(error as Error).message}`); }
  const previous = { projects: store.data.projects, threads: store.data.threads };
  store.data.threads = remaining;
  if (kind === 'project') store.data.projects = store.data.projects.filter(p => p.id !== id);
  try { store.save(); }
  catch (error) { Object.assign(store.data, previous); throw new Error(`文件已清理，但索引保存失败，请重试：${(error as Error).message}`); }
  for (const directory of new Set(attachmentFiles.map(file => path.dirname(file)))) {
    try { await fs.promises.rmdir(directory); } catch { /* Only remove empty cache directories. */ }
  }
}
