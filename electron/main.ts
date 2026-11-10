import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { RuntimeManager } from './runtime';
import { Sessions } from './session';
import { testProviderConnection } from './provider-test';
import * as files from './files';
import type { DesktopEvent, Attachment, Bootstrap, AccessMode } from '../shared/types';

app.setName('Saint Harness');
if (process.env.SAINT_DATA_DIR) app.setPath('userData', path.resolve(process.env.SAINT_DATA_DIR));
const gotLock = app.requestSingleInstanceLock(); if (!gotLock) app.quit();
let window: BrowserWindow | undefined;
let store: Store;
let runtime: RuntimeManager;
let sessions: Sessions;
let shuttingDown = false;
const send = (event: DesktopEvent) => { if (window && !window.isDestroyed()) window.webContents.send('saint:event', event); };
const requireIdle = () => { if (sessions.busy || runtime.info().updating) throw new Error('请等待当前任务或更新结束'); };
const currentProject = () => store.projectFor(store.thread());
const idSchema = z.object({ id: z.string().min(1).max(200) });
const pathSchema = z.object({ path: z.string().max(4000) });
const providerSchema = z.object({ id: z.enum(['anthropic','openai','deepseek','custom']), name: z.string().max(100), apiKey: z.string().trim().max(12000).optional(), baseUrl: z.string().trim().max(2000).optional(), modelId: z.string().trim().max(250).optional(), contextWindow: z.number().int().min(1024).max(4_000_000).optional(), reasoning: z.boolean().optional() });

async function bootstrap(): Promise<Bootstrap> { return { projects: store.data.projects, threads: store.data.threads, activeThreadId: store.data.activeThreadId, settings: store.publicSettings(), engine: runtime.info(), version: app.getVersion(), snapshot: sessions.snapshot }; }
async function reconnect() { await sessions.reconnect(); send({ kind: 'data' }); }
function validWebUrl(input: string) { const url = new URL(input); if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('地址必须是有效的 HTTP 或 HTTPS URL'); return url; }
async function handle(action: string, payload: unknown) {
  switch (action) {
    case 'bootstrap': return bootstrap();
    case 'project.add': {
      requireIdle(); const result = await dialog.showOpenDialog(window!, { title: '选择工作空间', properties: ['openDirectory'] }); if (result.canceled) return null;
      const project = store.addProject(result.filePaths[0]); const thread = store.addThread(project.id); send({ kind: 'data' }); await sessions.connect(thread.id); return project;
    }
    case 'project.trust': {
      requireIdle(); const project = currentProject();
      const result = await dialog.showMessageBox(window!, { type: 'warning', title: '信任项目配置', message: `允许加载 ${project.name} 的项目配置与扩展？`, detail: 'Pi 的项目扩展、MCP 和配置可以执行本机代码。仅对你信任的项目启用；这不会创建系统沙箱。', buttons: ['取消','信任此项目'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return false; project.trusted = true; store.save(); await reconnect(); return true;
    }
    case 'thread.new': { requireIdle(); const { projectId } = z.object({ projectId: z.string() }).parse(payload); const thread = store.addThread(projectId); send({ kind: 'data' }); await sessions.connect(thread.id); return thread; }
    case 'thread.open': { const { id } = idSchema.parse(payload); return sessions.connect(id); }
    case 'thread.rename': { const { id, title } = idSchema.extend({ title: z.string().trim().min(1).max(100) }).parse(payload); store.thread(id).title = title; store.save(); send({ kind: 'data' }); return true; }
    case 'thread.archive': {
      requireIdle(); const { id } = idSchema.parse(payload); const index = store.data.threads.findIndex(t => t.id === id); if (index < 0) return;
      // Archiving removes only the sidebar entry. Pi's session file stays intact.
      if (store.data.activeThreadId === id) { await sessions.rpc?.close(); store.data.activeThreadId = undefined; sessions.snapshot.connected = false; sessions.snapshot.threadId = undefined; sessions.snapshot.messages = []; }
      store.data.threads.splice(index, 1); store.save(); send({ kind: 'data' }); return true;
    }
    case 'session.refresh': return sessions.refresh();
    case 'session.send': { const p = z.object({ text: z.string().trim().min(1).max(200000), skills: z.array(z.string()).max(20).default([]), attachments: z.array(z.string()).max(10).default([]) }).parse(payload); return sessions.prompt(p.text, p.skills, p.attachments); }
    case 'session.stop': return sessions.stop();
    case 'session.model': { const p = z.object({ provider: z.string(), modelId: z.string() }).parse(payload); return sessions.setModel(p.provider, p.modelId); }
    case 'session.thinking': return sessions.setThinking(z.object({ level: z.string() }).parse(payload).level);
    case 'session.access': {
      const { mode } = z.object({ mode: z.enum(['ask','auto','full']) }).parse(payload); requireIdle();
      if (mode === 'full' && store.data.settings.access !== 'full') { const result = await dialog.showMessageBox(window!, { type: 'warning', title: '完全访问', message: '允许 Pi 自动执行所有工具操作？', detail: 'Pi 将使用当前系统账户的文件、终端和网络权限，工具调用不再逐次询问。你可以随时停止任务并切回其他模式。', buttons: ['取消','启用完全访问'], defaultId: 0, cancelId: 0 }); if (result.response !== 1) return store.data.settings.access; }
      await sessions.setAccess(mode as AccessMode); send({ kind: 'data' }); return mode;
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
      const result = await dialog.showOpenDialog(window!, { title: '添加文本或图片', properties: ['openFile','multiSelections'], filters: [{ name: '文本和图片', extensions: ['txt','md','json','csv','ts','tsx','js','jsx','py','html','css','yml','yaml','png','jpg','jpeg','webp'] }] });
      if (result.canceled) return []; if (result.filePaths.length > 10) throw new Error('一次最多添加 10 个附件');
      const added: Attachment[] = [];
      for (const file of result.filePaths) { const bytes = fs.statSync(file).size; if (bytes > 10 * 1024 * 1024) throw new Error('单个附件不能超过 10 MB'); const info = { id: randomUUID(), name: path.basename(file), bytes, image: /\.(png|jpe?g|webp)$/i.test(file) }; sessions.attachments.set(info.id, { info, path: file }); added.push(info); }
      return added;
    }
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
    case 'engine.check': return runtime.check();
    case 'engine.update': return runtime.update(() => sessions.busy, reconnect);
    case 'engine.rollback': return runtime.rollback(() => sessions.busy, reconnect);
    case 'engine.add': {
      requireIdle(); const result = await dialog.showOpenDialog(window!, { title: '添加已有的 Pi CLI（cli.js 或 pi.exe）', properties: ['openFile'], filters: [{ name: 'Pi CLI', extensions: ['js','mjs','cjs','exe'] }] }); if (result.canceled) return null;
      const old = store.data.externalCli; store.data.externalCli = result.filePaths[0]; store.save();
      try { await reconnect(); } catch (e) { store.data.externalCli = old; store.save(); await reconnect().catch(() => {}); throw e; }
      send({ kind: 'engine', engine: runtime.info() }); return runtime.info();
    }
    case 'engine.builtin': { requireIdle(); store.data.externalCli = undefined; store.save(); await reconnect(); send({ kind: 'engine', engine: runtime.info() }); return runtime.info(); }
    case 'external.open': { const { url } = z.object({ url: z.string().max(4000) }).parse(payload); await shell.openExternal(validWebUrl(url).href); return true; }
    default: throw new Error('未知操作');
  }
}

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.whenReady().then(async () => {
  if (!gotLock) return;
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  try { store = new Store(app.getPath('userData')); } catch { await dialog.showMessageBox({ type:'error', message:'工作空间索引无法读取', detail:`原文件已保留，请检查 ${app.getPath('userData')} 中的 workspace.json。` }); app.quit(); return; }
  const extension = path.join(root, 'extensions/permissions.mjs');
  runtime = new RuntimeManager(path.join(root, 'runtime'), process.execPath, extension, store, info => send({ kind: 'engine', engine: info }));
  sessions = new Sessions(store, runtime, extension, send);
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ width: 1480, height: 950, minWidth: 620, minHeight: 580, title: 'Saint Harness', frame: false, backgroundColor: '#ffffff', show: false, icon: path.join(app.getAppPath(),'assets/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('saint:invoke', async (event, action, payload) => { if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的窗口来源'); try { return await handle(action, payload); } catch (error) { throw new Error((error as Error).message); } });
  ipcMain.on('saint:window', (event, action) => { if (event.sender !== window?.webContents) return; if (action === 'minimize') window.minimize(); if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize(); if (action === 'close') window.close(); });
  window.on('close', event => {
    if (shuttingDown) return;
    if (sessions.busy || runtime.info().updating) { event.preventDefault(); void dialog.showMessageBox(window!, { type: 'question', message: '任务仍在运行，要停止并退出吗？', buttons: ['继续运行','停止并退出'], defaultId: 0, cancelId: 0 }).then(async result => { if (result.response !== 1) return; shuttingDown = true; runtime.shutdown(); await sessions.rpc?.close(); window?.close(); }); }
  });
  window.once('ready-to-show', () => window?.show());
  const dev = !app.isPackaged && process.env.SAINT_DEV_URL;
  if (dev) { if (new URL(dev).origin !== 'http://127.0.0.1:5187') throw new Error('Invalid development URL'); await window.loadURL(dev); } else await window.loadFile(path.join(app.getAppPath(),'dist/index.html'));
  if (store.data.activeThreadId) await sessions.connect(store.data.activeThreadId).catch(() => {});
  const check = async () => { if (!store.data.settings.autoCheck || runtime.info().updating) return; try { await runtime.check(); if (store.data.settings.autoUpdate && runtime.info().updateAvailable && !sessions.busy) await runtime.update(() => sessions.busy, reconnect); } catch { /* Updates are optional; the current runtime stays usable offline. */ } };
  setTimeout(() => { void check(); }, 5000).unref(); setInterval(() => { void check(); }, 6 * 60 * 60 * 1000).unref();
});
app.on('before-quit', () => { runtime?.shutdown(); sessions?.rpc?.kill(); });
app.on('window-all-closed', () => app.quit());
