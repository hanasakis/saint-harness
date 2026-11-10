import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, DesktopEvent } from '../shared/types';
const actions = new Set(['bootstrap','project.add','project.trust','thread.new','thread.open','thread.rename','thread.archive','session.refresh','session.send','session.stop','session.model','session.thinking','session.access','session.compact','session.export','ui.respond','files.list','files.read','files.reveal','changes.list','changes.diff','attachments.pick','skills.add','settings.testProvider','settings.saveProvider','settings.removeProvider','settings.save','engine.check','engine.update','engine.rollback','engine.add','engine.builtin','external.open']);
const bridge: Bridge = {
  invoke: (action, payload) => { if (!actions.has(action)) return Promise.reject(new Error('不支持的操作')); return ipcRenderer.invoke('saint:invoke', action, payload); },
  onEvent: callback => { const handler = (_: Electron.IpcRendererEvent, event: DesktopEvent) => callback(event); ipcRenderer.on('saint:event', handler); return () => ipcRenderer.removeListener('saint:event', handler); },
  window: action => { if (['minimize','maximize','close'].includes(action)) ipcRenderer.send('saint:window', action); },
};
contextBridge.exposeInMainWorld('saint', bridge);
