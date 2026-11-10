import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { Sessions } from './session';

export function threadLink(id: string) { return `saint-harness://threads/${encodeURIComponent(id)}`; }
export function threadIdFromLink(input: string) {
  const match = /^saint-harness:\/\/threads\/([a-zA-Z0-9-]{1,200})$/.exec(input.trim());
  if (!match) throw new Error('这不是有效的 Saint Harness 会话链接');
  return match[1];
}

export class WorkspaceActions {
  constructor(private store: Store, private sessions: Pick<Sessions, 'connect' | 'detach'>, private changed: () => void) {}
  async archive(kind: 'project' | 'thread', id: string) {
    const item = kind === 'project' ? this.store.project(id) : this.store.thread(id);
    const active = this.store.data.threads.find(t => t.id === this.store.data.activeThreadId);
    if (active && (kind === 'thread' ? active.id === id : active.projectId === id)) await this.sessions.detach();
    item.archivedAt = Date.now(); this.store.save(); this.changed();
  }
  restore(kind: 'project' | 'thread', id: string) {
    const item = kind === 'project' ? this.store.project(id) : this.store.thread(id);
    delete item.archivedAt;
    if (kind === 'thread') delete this.store.projectFor(this.store.thread(id)).archivedAt;
    this.store.save(); this.changed();
  }
  async move(id: string, projectId: string) {
    const thread = this.store.thread(id), target = this.store.project(projectId);
    if (thread.archivedAt || target.archivedAt) throw new Error('请先从归档中恢复会话和目标项目');
    if (thread.projectId === projectId) return;
    if (!fs.statSync(target.path).isDirectory()) throw new Error('目标项目目录不可访问');
    const original = { projectId: thread.projectId, sessionFile: thread.sessionFile, updatedAt: thread.updatedAt };
    // Pi resumes the cwd in the JSONL header. Preserve the source and all history,
    // and give the moved session a header pointing at its new workspace.
    if (thread.sessionFile && fs.existsSync(thread.sessionFile)) {
      const text = fs.readFileSync(thread.sessionFile, 'utf8');
      const end = text.indexOf('\n');
      const header = JSON.parse(end < 0 ? text : text.slice(0, end));
      if (header.type !== 'session') throw new Error('会话文件格式无法识别，原会话已保留');
      const directory = path.join(this.store.directory, 'sessions', target.id);
      fs.mkdirSync(directory, { recursive: true });
      const destination = path.join(directory, `${thread.id}-${randomUUID()}.jsonl`);
      fs.writeFileSync(destination, JSON.stringify({ ...header, cwd: target.path }) + (end < 0 ? '\n' : text.slice(end)), { flag: 'wx', mode: 0o600 });
      thread.sessionFile = destination;
    }
    thread.projectId = projectId; thread.updatedAt = Date.now();
    try {
      this.store.save();
      if (this.store.data.activeThreadId === id) await this.sessions.connect(id);
    } catch (error) {
      Object.assign(thread, original); this.store.save();
      if (this.store.data.activeThreadId === id) await this.sessions.connect(id).catch(() => {});
      throw error;
    } finally { this.changed(); }
  }
}
