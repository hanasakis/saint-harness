import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Bridge, DesktopEvent } from '../shared/types';
const actions = new Set(['confirmation.respond','project.rename','project.reveal','project.copyPath','project.archive','project.restore','thread.restore','thread.move','thread.copyLink','thread.openLink','attachments.remove','bootstrap','project.add','project.trust','thread.new','thread.open','thread.rename','thread.archive','session.refresh','session.send','session.stop','session.model','session.thinking','session.access','session.compact','session.export','ui.respond','files.list','files.read','files.reveal','changes.list','changes.diff','attachments.pick','skills.add','settings.testProvider','settings.saveProvider','settings.removeProvider','settings.save','engine.detect','engine.install','engine.connect','engine.chooseFolder','engine.check','engine.update','engine.rollback','engine.add','engine.builtin','external.open']);
const bridge: Bridge = {
  addDroppedFiles: files => {
    if (files.length > 10) return Promise.reject(new Error('一条消息最多添加 10 个附件'));
    const paths = files.map(file => webUtils.getPathForFile(file));
    if (!paths.length || paths.some(p => !p)) return Promise.reject(new Error('请从桌面或文件夹拖入本地文件'));
    return ipcRenderer.invoke('saint:invoke', 'attachments.add', { paths });
  },
  invoke: (action, payload) => { if (!actions.has(action)) return Promise.reject(new Error('不支持的操作')); return ipcRenderer.invoke('saint:invoke', action, payload); },
  onEvent: callback => { const handler = (_: Electron.IpcRendererEvent, event: DesktopEvent) => callback(event); ipcRenderer.on('saint:event', handler); return () => ipcRenderer.removeListener('saint:event', handler); },
  window: action => { if (['minimize','maximize','close'].includes(action)) ipcRenderer.send('saint:window', action); },
};
contextBridge.exposeInMainWorld('saint', bridge);
