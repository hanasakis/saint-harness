import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { RuntimeManager } from './runtime';
import { Sessions } from './sessions';
import type { SessionChannel } from './session';
import { testProviderConnection } from './provider-test';
import { WorkspaceActions, threadLink, threadIdFromLink } from './workspace-actions';
import { prepareAttachments, discardAttachment, type AttachmentSource } from './attachments';
import { readComposerClipboard } from './composer-clipboard';
import * as files from './files';
import type { DesktopEvent, Bootstrap, AccessMode } from '../shared/types';

app.setName('Saint Harness');
if (process.env.SAINT_DATA_DIR) app.setPath('userData', path.resolve(process.env.SAINT_DATA_DIR));
const gotLock = app.requestSingleInstanceLock(); if (!gotLock) app.quit();
let window: BrowserWindow | undefined;
let store: Store;
let runtime: RuntimeManager;
let sessions: Sessions;
let workspace: WorkspaceActions;
let accessConfirmation: { id: string; resolve: (confirmed: boolean) => void } | undefined;
let pendingLink = process.argv.find(arg => arg.startsWith('saint-harness:'));
let ready = false;
let shuttingDown = false;
const send = (event: DesktopEvent) => { if (window && !window.isDestroyed()) window.webContents.send('saint:event', event); };
const requireIdle = () => { if (sessions.busy || runtime.info().updating || workspace?.deleting) throw new Error('请等待当前任务、更新或删除结束'); };
const requireNavigation = () => { if (sessions.navigating || runtime.info().updating || workspace?.deleting) throw new Error('正在切换会话、更新或删除，请稍候'); };
const requireCurrentIdle = () => { requireNavigation(); if (sessions.currentBusy) throw new Error('请等待当前会话任务结束'); };
const currentProject = () => store.projectFor(store.thread());
const idSchema = z.object({ id: z.string().min(1).max(200) });
const pathSchema = z.object({ path: z.string().max(4000) });
const providerSchema = z.object({ id: z.enum(['anthropic','openai','deepseek','custom']), name: z.string().max(100), apiKey: z.string().trim().max(12000).optional(), baseUrl: z.string().trim().max(2000).optional(), modelId: z.string().trim().max(250).optional(), contextWindow: z.number().int().min(1024).max(4_000_000).optional(), reasoning: z.boolean().optional(), supportsImages: z.boolean().optional() });

async function bootstrap(): Promise<Bootstrap> { return { activities: sessions.activities, navigating: sessions.navigating, projects: store.data.projects, threads: store.data.threads, activeThreadId: store.data.activeThreadId, settings: store.publicSettings(), engine: runtime.info(), version: app.getVersion(), snapshot: sessions.snapshot, side: sessions.sideSnapshot }; }
async function reconnect() { await sessions.reconnect(); send({ kind: 'data' }); }
function validWebUrl(input: string) { const url = new URL(input); if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('地址必须是有效的 HTTP 或 HTTPS URL'); return url; }
function confirmFullAccess() {
  if (accessConfirmation) throw new Error('请先处理当前的权限确认');
  return new Promise<boolean>(resolve => { const id = randomUUID(); accessConfirmation = { id, resolve }; send({ kind: 'confirm-access', request: { id } }); });
}
function cancelAccessConfirmation() { accessConfirmation?.resolve(false); accessConfirmation = undefined; }
const addingAttachments = new Set<SessionChannel>();
function attachmentChannel(id?: string) {
  requireNavigation(); const channel = sessions.visibleChannel(id);
  if (!channel.snapshot.threadId) throw new Error('请先打开一个工作空间，再添加附件');
  if (channel.busy) throw new Error('请等待当前会话任务结束');
  return channel;
}
async function registerAttachments(paths: AttachmentSource[], channel = attachmentChannel()) {
  if (addingAttachments.has(channel)) throw new Error('正在添加附件，请稍候');
  addingAttachments.add(channel);
  try {
    const threadId = channel.snapshot.threadId, rpc = channel.rpc;
    const cache = path.join(store.directory, 'attachments');
    const added = await prepareAttachments(paths, [...channel.attachments.values()], cache);
    let visible = false; try { visible = sessions.visibleChannel(threadId) === channel; } catch {}
    if (!visible || rpc !== channel.rpc || channel.busy || sessions.navigating) { added.forEach(item => discardAttachment(item, cache)); throw new Error('会话状态已变化，请在当前会话重新添加附件'); }
    for (const item of added) channel.attachments.set(item.info.id, item);
    return added.map(item => item.info);
  } finally { addingAttachments.delete(channel); }
}
async function openLink(link: string) {
  requireNavigation(); const id = threadIdFromLink(link);
  if (!store.data.threads.some(t => t.id === id)) throw new Error('此设备没有这条会话。会话链接只定位本机记录，不会上传或分享聊天内容。');
  await sessions.connect(id);
}
function receiveLink(link?: string) {
  if (!link) return;
  if (!ready) { pendingLink = link; return; }
  void openLink(link).catch(error => send({ kind: 'notice', message: error.message, error: true }));
}
async function handle(action: string, payload: unknown) {
  switch (action) {
    case 'bootstrap': return bootstrap();
    case 'project.add': {
      requireNavigation(); const result = await dialog.showOpenDialog(window!, { title: '选择工作空间', properties: ['openDirectory'] }); if (result.canceled) return null;
      requireNavigation(); const project = store.addProject(result.filePaths[0]); const thread = store.addThread(project.id); send({ kind: 'data' }); await sessions.connect(thread.id); return project;
    }
    case 'project.trust': {
      requireIdle(); const project = currentProject();
      const result = await dialog.showMessageBox(window!, { type: 'warning', title: '信任项目配置', message: `允许加载 ${project.name} 的项目配置与扩展？`, detail: 'Pi 的项目扩展、MCP 和配置可以执行本机代码。仅对你信任的项目启用；这不会创建系统沙箱。', buttons: ['取消','信任此项目'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return false; project.trusted = true; store.save(); await reconnect(); return true;
    }
    case 'project.rename': { requireIdle(); const { id, title } = idSchema.extend({ title: z.string().trim().min(1).max(100) }).parse(payload); store.project(id).name = title; store.save(); send({ kind: 'data' }); return true; }
    case 'project.reveal': { const { id } = idSchema.parse(payload); const error = await shell.openPath(store.project(id).path); if (error) throw new Error(error); return true; }
    case 'project.copyPath': { const { id } = idSchema.parse(payload); clipboard.writeText(store.project(id).path); return true; }
    case 'project.archive': case 'thread.archive': { requireIdle(); const { id } = idSchema.parse(payload); const kind = action === 'project.archive' ? 'project' : 'thread'; await sessions.closeSideFor(kind, id); await workspace.archive(kind, id); return true; }
    case 'project.delete': case 'thread.delete': { requireIdle(); const { id } = idSchema.extend({ confirmed: z.literal(true) }).parse(payload); const kind = action === 'project.delete' ? 'project' : 'thread'; await sessions.closeSideFor(kind, id); await workspace.delete(kind, id); return true; }
    case 'project.restore': case 'thread.restore': { requireIdle(); const { id } = idSchema.parse(payload); workspace.restore(action === 'project.restore' ? 'project' : 'thread', id); return true; }
    case 'thread.move': { requireIdle(); const { id, projectId } = idSchema.extend({ projectId: z.string() }).parse(payload); await sessions.closeSideFor('thread', id); await workspace.move(id, projectId); return true; }
    case 'thread.copyLink': { const { id } = idSchema.parse(payload); store.thread(id); const link = threadLink(id); clipboard.writeText(link); return link; }
    case 'thread.openLink': { const { link } = z.object({ link: z.string().max(500) }).parse(payload); await openLink(link); return true; }
    case 'thread.new': { requireNavigation(); const { projectId } = z.object({ projectId: z.string() }).parse(payload); const thread = store.addThread(projectId); send({ kind: 'data' }); await sessions.connect(thread.id); return thread; }
    case 'thread.open': { requireNavigation(); const { id } = idSchema.parse(payload); return sessions.connect(id); }
    case 'thread.rename': { requireNavigation(); const { id, title } = idSchema.extend({ title: z.string().trim().min(1).max(100) }).parse(payload); const thread = store.thread(id); thread.title = title; thread.titleSource = 'manual'; thread.titleStatus = 'done'; store.save(); send({ kind: 'data' }); return true; }
    case 'selection.copy': { const { text } = z.object({ text: z.string().max(200000) }).parse(payload); await clipboard.writeText(text); return true; }
    case 'side.create': {
      requireNavigation();
      const quote = z.object({ threadId: z.string().min(1), entryId: z.string().min(1), text: z.string().min(1).max(20000), title: z.string().max(100) }).parse(payload);
      if (!quote.text.trim()) throw new Error('请先选择文字');
      return sessions.branchSelection(quote);
    }
    case 'side.open': { requireNavigation(); return sessions.openSide(idSchema.parse(payload).id); }
    case 'side.close': { requireNavigation(); await sessions.closeSide(); return true; }
    case 'side.send': {
      requireNavigation(); const p = z.object({ threadId: z.string(), text: z.string().trim().min(1).max(200000), attachments: z.array(z.string()).max(10).default([]) }).parse(payload);
      const channel = sessions.visibleChannel(p.threadId); if (addingAttachments.has(channel)) throw new Error('请等待附件添加完成');
      return channel.prompt(p.text, [], p.attachments);
    }
    case 'side.stop': { const { id } = idSchema.parse(payload); return sessions.visibleChannel(id).stop(); }
    case 'side.model': { requireNavigation(); const p = z.object({ threadId: z.string(), provider: z.string(), modelId: z.string() }).parse(payload); return sessions.visibleChannel(p.threadId).setModel(p.provider, p.modelId); }
    case 'side.thinking': { requireNavigation(); const p = z.object({ threadId: z.string(), level: z.string() }).parse(payload); return sessions.visibleChannel(p.threadId).setThinking(p.level); }
    case 'side.respond': {
      const p = z.object({ threadId: z.string(), id: z.string(), confirmed: z.boolean().optional(), value: z.string().max(100000).optional(), cancelled: z.boolean().optional() }).parse(payload);
      sessions.visibleChannel(p.threadId).respond(p.id, p); return true;
    }
    case 'session.refresh': return sessions.refresh();
    case 'session.send': { requireCurrentIdle(); const p = z.object({ text: z.string().trim().min(1).max(200000), skills: z.array(z.string()).max(20).default([]), attachments: z.array(z.string()).max(10).default([]) }).parse(payload); return sessions.prompt(p.text, p.skills, p.attachments); }
    case 'session.stop': return sessions.stop();
    case 'session.model': { const p = z.object({ provider: z.string(), modelId: z.string() }).parse(payload); return sessions.setModel(p.provider, p.modelId); }
    case 'session.thinking': return sessions.setThinking(z.object({ level: z.string() }).parse(payload).level);
    case 'session.access': {
      const { mode } = z.object({ mode: z.enum(['ask','auto','full']) }).parse(payload); requireIdle();
      if (mode === 'full' && store.data.settings.access !== 'full' && !await confirmFullAccess()) return store.data.settings.access;
      requireIdle();
      await sessions.setAccess(mode as AccessMode); send({ kind: 'data' }); return mode;
    }
    case 'confirmation.respond': {
      const { id, confirmed } = idSchema.extend({ confirmed: z.boolean() }).parse(payload);
      if (!accessConfirmation || accessConfirmation.id !== id) throw new Error('权限确认已结束');
      const pending = accessConfirmation; accessConfirmation = undefined; pending.resolve(confirmed); return true;
    }
    case 'session.compact': { requireIdle(); if (!sessions.rpc?.alive) throw new Error('引擎未连接'); await sessions.rpc.request('compact', {}, 300000); return sessions.refresh(); }
    case 'session.export': {
      requireIdle(); const thread = store.thread(); if (!sessions.rpc?.alive) throw new Error('引擎未连接'); const target = await dialog.showSaveDialog(window!, { title: '导出当前会话', defaultPath: `${thread.title.replace(/[<>:"/\\|?*]/g,'-')}.html`, filters: [{ name: '会话 HTML', extensions: ['html'] }] });
      if (target.canceled || !target.filePath) return null; await sessions.rpc.request('export_html', { outputPath: target.filePath }); shell.showItemInFolder(target.filePath); return target.filePath;
    }
    case 'ui.respond': { const p = z.object({ id: z.string(), confirmed: z.boolean().optional(), value: z.string().max(100000).optional(), cancelled: z.boolean().optional() }).parse(payload); sessions.respond(p.id, p); return true; }
    case 'files.list': return files.listFiles(currentProject().path, pathSchema.parse(payload).path);
    case 'files.read': return files.readFile(currentProject().path, pathSchema.parse(payload).path);
    case 'files.reveal': { const target = await files.within(currentProject().path, pathSchema.parse(payload).path); shell.showItemInFolder(target); return true; }
    case 'changes.list': return files.changes(currentProject().path);
    case 'changes.diff': return files.diff(currentProject().path, pathSchema.parse(payload).path);
    case 'attachments.pick': {
      const { threadId } = z.object({ threadId: z.string().optional() }).parse(payload || {}); const channel = attachmentChannel(threadId);
      const result = await dialog.showOpenDialog(window!, { title: '添加文件', properties: ['openFile','multiSelections'], filters: [{ name: '所有文件', extensions: ['*'] }] });
      if (result.canceled) return []; if (attachmentChannel(channel.snapshot.threadId) !== channel) throw new Error('会话已切换，请重新添加');
      return registerAttachments(result.filePaths, channel);
    }
    case 'attachments.add': { const { paths, threadId } = z.object({ paths: z.array(z.string().min(1).max(4000)).min(1).max(10), threadId: z.string().optional() }).parse(payload); return registerAttachments(paths, attachmentChannel(threadId)); }
    case 'composer.paste': {
      const { threadId, textOnly } = z.object({ threadId: z.string().optional(), textOnly: z.boolean().optional() }).parse(payload);
      const channel = sessions.visibleChannel(threadId), rpc = channel.rpc;
      const value = await readComposerClipboard(textOnly);
      if (sessions.visibleChannel(threadId) !== channel || rpc !== channel.rpc) throw new Error('会话已切换，请重新粘贴');
      if (!value.sources.length) return { text: value.text, attachments: [] };
      attachmentChannel(threadId);
      if (!threadId) throw new Error('请先打开一个工作空间，再添加附件');
      return { text: '', attachments: await registerAttachments(value.sources, channel) };
    }
    case 'composer.edit': {
      const { command } = z.object({ command: z.enum(['undo','redo','cut','copy','selectAll']) }).parse(payload);
      window!.webContents[command](); return true;
    }
    case 'attachments.remove': { const { id, threadId } = idSchema.extend({ threadId: z.string().optional() }).parse(payload); sessions.visibleChannel(threadId).removeAttachment(id); return true; }
    case 'skills.add': {
      requireIdle(); const result = await dialog.showOpenDialog(window!, { title: '选择技能的 SKILL.md 文件', properties: ['openFile'], filters: [{ name: 'Skill', extensions: ['md'] }] }); if (result.canceled) return false;
      const file = result.filePaths[0]; if (path.basename(file).toLowerCase() !== 'skill.md') throw new Error('请选择技能目录中的 SKILL.md'); if (fs.statSync(file).size > 128000) throw new Error('技能文件不能超过 128 KB');
      if (!store.data.skillPaths.includes(file)) store.data.skillPaths.push(file); store.save(); await reconnect(); return true;
    }
    case 'settings.testProvider': {
      const p = providerSchema.parse(payload);
      const encrypted = store.data.secrets[p.id];
      const key = p.apiKey?.trim() || (encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '');
      return testProviderConnection(p, key);
    }
    case 'settings.saveProvider': {
      requireIdle(); const p = providerSchema.parse(payload); if (p.baseUrl) validWebUrl(p.baseUrl);
      if (p.id === 'custom' && (!p.baseUrl || !p.modelId)) throw new Error('请填写 API 地址和模型 ID');
      if (p.apiKey) { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存密钥'); store.data.secrets[p.id] = safeStorage.encryptString(p.apiKey).toString('base64'); }
      const { apiKey: _, ...config } = p; store.data.settings.providers = [...store.data.settings.providers.filter(x => x.id !== p.id), config]; store.save(); await reconnect(); send({ kind: 'data' }); return store.publicSettings();
    }
    case 'settings.removeProvider': { requireIdle(); const { id } = idSchema.parse(payload); store.data.settings.providers = store.data.settings.providers.filter(p => p.id !== id); delete store.data.secrets[id]; store.data.settings.defaultModel = undefined; store.save(); await reconnect(); return store.publicSettings(); }
    case 'settings.save': { const p = z.object({ autoCheck: z.boolean().optional(), autoUpdate: z.boolean().optional() }).parse(payload); Object.assign(store.data.settings, p); if (p.autoUpdate) store.data.settings.autoCheck = true; store.save(); send({ kind: 'data' }); return store.publicSettings(); }
    case 'engine.detect': return runtime.detect();
    case 'engine.install': {
      requireIdle();
      if(runtime.info().installed)return runtime.connectExisting(runtime.info().path,()=>sessions.busy,reconnect);
      const result = await dialog.showOpenDialog(window!, {title:'选择 Pi 保存位置',buttonLabel:'下载到这里并连接',properties:['openDirectory','createDirectory']});
      if (result.canceled || !result.filePaths[0]) return null;
      requireIdle(); return runtime.install(result.filePaths[0],()=>sessions.busy || workspace.deleting,reconnect);
    }
    case 'engine.connect': {
      requireIdle();
      const p = z.object({path:z.string().max(4000).optional()}).parse(payload || {});
      return runtime.connectExisting(p.path || runtime.info().path,()=>sessions.busy || workspace.deleting,reconnect);
    }
    case 'engine.chooseFolder':
    case 'engine.add': {
      requireIdle();
      const result = await dialog.showOpenDialog(window!, action==='engine.chooseFolder'
        ? {title:'选择已下载的 Pi 安装文件夹',buttonLabel:'连接此引擎',properties:['openDirectory']}
        : {title:'选择 Pi 入口文件',buttonLabel:'连接此引擎',properties:['openFile'],filters:[{name:'Pi 入口',extensions:['js','mjs','cjs','exe','cmd','ps1']}]});
      if (result.canceled || !result.filePaths[0]) return null;
      requireIdle(); return runtime.connectExisting(result.filePaths[0],()=>sessions.busy || workspace.deleting,reconnect);
    }
    case 'engine.check': return runtime.check();
    case 'engine.update': return runtime.update(() => sessions.busy || workspace.deleting, reconnect);
    case 'engine.rollback': return runtime.rollback(() => sessions.busy || workspace.deleting, reconnect);
    case 'engine.builtin': { requireIdle(); return runtime.connectExisting(runtime.bundled,()=>sessions.busy || workspace.deleting,reconnect,runtime.bundled); }
    case 'external.open': { const { url } = z.object({ url: z.string().max(4000) }).parse(payload); await shell.openExternal(validWebUrl(url).href); return true; }
    default: throw new Error('未知操作');
  }
}

app.on('second-instance', (_event, argv) => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } receiveLink(argv.find(arg => arg.startsWith('saint-harness:'))); });
app.on('open-url', (event, url) => { event.preventDefault(); receiveLink(url); });
app.whenReady().then(async () => {
  if (!gotLock) return;
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  try { store = new Store(app.getPath('userData')); } catch { await dialog.showMessageBox({ type:'error', message:'工作空间索引无法读取', detail:`原文件已保留，请检查 ${app.getPath('userData')} 中的 workspace.json。` }); app.quit(); return; }
  const extension = path.join(root, 'extensions/permissions.mjs');
  runtime = new RuntimeManager(path.join(root, 'runtime'), process.execPath, extension, store, info => send({ kind: 'engine', engine: info }), async () => { await sessions?.suspendAll(); });
  sessions = new Sessions(store, runtime, extension, send);
  workspace = new WorkspaceActions(store, sessions, () => send({ kind: 'data' }));
  if (app.isPackaged && !process.env.SAINT_DATA_DIR) app.setAsDefaultProtocolClient('saint-harness');
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ width: 1480, height: 950, minWidth: 620, minHeight: 580, title: 'Saint Harness', frame: false, backgroundColor: '#ffffff', show: false, icon: path.join(app.getAppPath(),'assets/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('did-start-loading', cancelAccessConfirmation);
  window.on('closed', cancelAccessConfirmation);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('saint:invoke', async (event, action, payload) => { if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的窗口来源'); try { return await handle(action, payload); } catch (error) { throw new Error((error as Error).message); } });
  ipcMain.on('saint:window', (event, action) => { if (event.sender !== window?.webContents) return; if (action === 'minimize') window.minimize(); if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize(); if (action === 'close') window.close(); });
  window.on('close', event => {
    if (shuttingDown) return;
    if (workspace.deleting) { event.preventDefault(); send({ kind: 'notice', message: '正在删除归档内容，完成后即可退出。' }); return; }
    if (sessions.busy || runtime.info().updating) { event.preventDefault(); void dialog.showMessageBox(window!, { type: 'question', message: '任务仍在运行，要停止并退出吗？', buttons: ['继续运行','停止并退出'], defaultId: 0, cancelId: 0 }).then(async result => { if (result.response !== 1) return; shuttingDown = true; runtime.shutdown(); await sessions.close(); window?.close(); }); }
  });
  window.once('ready-to-show', () => window?.show());
  const dev = !app.isPackaged && process.env.SAINT_DEV_URL;
  if (dev) { if (new URL(dev).origin !== 'http://127.0.0.1:5187') throw new Error('Invalid development URL'); await window.loadURL(dev); } else await window.loadFile(path.join(app.getAppPath(),'dist/index.html'));
  if (store.data.activeThreadId || runtime.info().installed) await sessions.reconnect().catch(() => {});
  ready = true; receiveLink(pendingLink); pendingLink = undefined;
  const check = async () => { if (!store.data.settings.autoCheck || runtime.info().updating) return; try { await runtime.check(); if (store.data.settings.autoUpdate && runtime.info().updateAvailable && !sessions.busy) await runtime.update(() => sessions.busy || workspace.deleting, reconnect); } catch { /* Updates are optional; the current runtime stays usable offline. */ } };
  setTimeout(() => { void check(); }, 5000).unref(); setInterval(() => { void check(); }, 6 * 60 * 60 * 1000).unref();
});
app.on('before-quit', () => { runtime?.shutdown(); sessions?.clearAttachments(); sessions?.kill(); });
app.on('window-all-closed', () => app.quit());
