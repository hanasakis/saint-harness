import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, Thread, Settings, ProviderConfig } from '../shared/types';
export interface Data { projects: Project[]; threads: Thread[]; activeThreadId?: string; activeSideThreadId?: string; settings: Settings; skillPaths: string[]; runtimePath?: string; runtimeInstallDirectory?: string; previousRuntime?: string; externalCli?: string; secrets: Record<string, string> }
export class Store {
  data: Data;
  readonly agentDir: string;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.agentDir = path.join(directory, 'pi-agent'); fs.mkdirSync(this.agentDir, { recursive: true });
    const file = path.join(directory, 'workspace.json');
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { projects: [], threads: [], settings: { access: 'auto', autoCheck: true, autoUpdate: false, providers: [] }, skillPaths: [], secrets: {} };
    for (const thread of this.data.threads) if (thread.titleStatus === 'generating') thread.titleStatus = 'failed';
  }
  save() { const target = path.join(this.directory, 'workspace.json'); fs.writeFileSync(target + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(target + '.tmp', target); }
  addProject(directory: string): Project { const canonical = fs.realpathSync(directory); const existing = this.data.projects.find(p => p.path.toLowerCase() === canonical.toLowerCase()); if (existing) { delete existing.archivedAt; this.save(); return existing; } const project = { id: randomUUID(), name: path.basename(canonical), path: canonical, trusted: false }; this.data.projects.push(project); this.save(); return project; }
  project(id: string) { const project = this.data.projects.find(p => p.id === id); if (!project) throw new Error('工作空间不存在'); return project; }
  addThread(projectId: string, activate = true) { if (this.project(projectId).archivedAt) throw new Error('请先恢复已归档的项目'); const thread: Thread = { id: randomUUID(), projectId, title: '新建会话', titleStatus: 'pending', createdAt: Date.now(), updatedAt: Date.now() }; this.data.threads.unshift(thread); if (activate) this.data.activeThreadId = thread.id; this.save(); return thread; }
  projectFor(thread: Thread) { const project = this.data.projects.find(p => p.id === thread.projectId); if (!project) throw new Error('找不到工作空间'); return project; }
  thread(id?: string) { const thread = this.data.threads.find(t => t.id === (id ?? this.data.activeThreadId)); if (!thread) throw new Error('请先新建会话'); return thread; }
  publicSettings(): Settings { return { ...this.data.settings, providers: this.data.settings.providers.map((p: ProviderConfig) => ({ ...p, hasKey: !!this.data.secrets[p.id] })) }; }
}
