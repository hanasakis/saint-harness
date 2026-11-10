import type { AccessMode, DesktopEvent, ThreadActivity, SelectionQuote } from '../shared/types';
import path from 'node:path';
import { branchEntries, partitionBranchMessages, type TreeEntry } from '../shared/selection';
import { createSelectionBranch } from './session-tree';
import type { Store } from './store';
import type { RuntimeManager } from './runtime';
import { SessionChannel, emptySnapshot } from './session';
import { SessionTitles } from './session-title';

export class Sessions {
  private channels = new Map<string, SessionChannel>();
  private current?: SessionChannel;
  private side?: SessionChannel;
  private branching = false;
  private sideOpening = false;
  private switching = false;
  private titles: SessionTitles;
  private naming = new Set<string>();
  constructor(private store: Store, private runtime: RuntimeManager, private extension: string, private send: (event: DesktopEvent) => void) {
    this.titles = new SessionTitles(runtime, store.directory);
    this.current = this.channel();
  }
  get rpc() { return this.current?.rpc; }
  get snapshot() { return this.current?.snapshot || emptySnapshot(); }
  get attachments() { return this.current!.attachments; }
  get busy() { return this.navigating || [...this.channels.values()].some(c => c.busy) || this.naming.size > 0; }
  get navigating() { return this.switching || this.branching || this.sideOpening; }
  get sideSnapshot() { return this.side?.view(); }
  visibleChannel(id = this.snapshot.threadId) {
    if (id === this.snapshot.threadId) return this.current!;
    if (id && id === this.side?.snapshot.threadId) return this.side;
    throw new Error('此会话已不在当前窗口，请重新打开');
  }
  get currentBusy() { return this.switching || !!this.current?.busy; }
  get activities(): ThreadActivity[] {
    return [...this.channels.entries()].filter(([id]) => id !== '').map(([id, channel]) => ({ id, busy: channel.busy, waiting: channel.pendingUI.size > 0, naming: this.naming.has(id) }));
  }
  private publishActivity() { this.send({ kind: 'activity', activities: this.activities, navigating: this.navigating }); }
  private channel(id?: string) {
    const key = id || ''; let channel = this.channels.get(key);
    if (!channel) {
      channel = new SessionChannel(this.store, this.runtime, this.extension, event => {
        if (event.kind === 'data') this.send(event);
        else if (this.current === channel) this.send(event);
        else if (this.side === channel && event.kind === 'snapshot') this.send({ kind: 'side-snapshot', snapshot: channel!.view() });
        else if (this.side === channel && event.kind === 'pi') this.send({ ...event, kind: 'side-pi' });
        if (event.kind === 'snapshot' || event.kind === 'pi' && ['agent_start', 'agent_settled', 'extension_ui_request'].includes(event.record.type)) this.publishActivity();
        if (event.kind === 'pi' && event.record.type === 'extension_ui_request' && channel !== this.current && channel !== this.side && channel!.pendingUI.size) this.send({ kind: 'notice', message: `${this.store.thread(id).title} 正在等待确认，点击侧栏会话继续。` });
      }, c => { void this.settled(c); });
      this.channels.set(key, channel);
    }
    return channel;
  }
  async connect(id?: string, force = false) {
    if (this.navigating) throw new Error('正在切换会话，请稍候');
    if (id) { const thread = this.store.thread(id); if (thread.archivedAt || this.store.projectFor(thread).archivedAt) throw new Error('此会话已归档，请先恢复'); }
    this.switching = true; this.publishActivity();
    const previous = this.current, target = this.channel(id);
    try {
      await this.closeSide();
      this.current = target; if(this.store.data.activeThreadId!==id){this.store.data.activeThreadId = id; this.store.save();}
      if (force || !target.rpc?.alive || !target.snapshot.connected) await target.connect(id);
      target.publish();
      // Running channels keep their process. Idle background channels keep their
      // draft attachments and reconnect from the Pi session when selected again.
      if (previous && previous !== target && !previous.busy) await previous.suspend();
      return target.snapshot;
    } finally { this.switching = false; this.publishActivity(); }
  }
  async reconnect() {
    if (this.busy) throw new Error('请等待所有会话任务和命名结束');
    const sideId = this.store.data.activeSideThreadId;
    await this.suspendAll(); const result = await this.connect(this.store.data.activeThreadId, true);
    const thread = this.store.data.threads.find(t => t.id === sideId);
    if (thread && !thread.archivedAt && !this.store.projectFor(thread).archivedAt && thread.id !== this.snapshot.threadId) await this.openSide(thread.id);
    return result;
  }
  async suspendAll() { for (const channel of this.channels.values()) await channel.suspend(); }
  async detach() {
    if (this.currentBusy) throw new Error('请等待当前任务结束');
    await this.closeSide(); this.current?.clearAttachments(); await this.current?.suspend();
    this.store.data.activeThreadId = undefined; this.current = this.channel(); this.current.snapshot = emptySnapshot(); this.current.publish(); this.publishActivity();
  }
  private async settled(channel: SessionChannel) {
    const id = channel.snapshot.threadId;
    if (id) {
      const thread = this.store.data.threads.find(t => t.id === id);
      const assistant = [...channel.snapshot.messages].reverse().find(m => m.role === 'assistant');
      if (thread?.titleStatus === 'pending' && thread.titleSource !== 'manual' && channel.snapshot.model && assistant && !['aborted', 'error'].includes(assistant.stopReason || '')) {
        thread.titleStatus = 'generating'; this.naming.add(id); this.store.save(); this.send({ kind: 'data' }); this.publishActivity();
        const model = channel.snapshot.model, messages = [...channel.snapshot.messages], env = channel.environment();
        try {
          const title = await this.titles.generate(model, thread.origin ? partitionBranchMessages(messages, thread.origin.inheritedEntryIds).own : messages, env);
          const latest = this.store.data.threads.find(t => t.id === id);
          if (latest && latest.titleSource !== 'manual') { latest.title = title; latest.titleSource = 'model'; latest.titleStatus = 'done'; this.store.save(); }
        } catch {
          const latest = this.store.data.threads.find(t => t.id === id);
          if (latest && latest.titleSource !== 'manual') { latest.titleStatus = 'failed'; this.store.save(); }
        } finally { this.naming.delete(id); this.send({ kind: 'data' }); this.publishActivity(); }
      }
    }
    if (this.current !== channel && this.side !== channel && !channel.busy && !this.navigating) await channel.suspend();
    this.publishActivity();
  }
  refresh() { return this.current!.refresh(); }
  prompt(text: string, skills: string[], attachments: string[]) { return this.current!.prompt(text, skills, attachments); }
  stop() { return this.current!.stop(); }
  respond(id: string, response: { confirmed?: boolean; value?: string; cancelled?: boolean }) { return this.current!.respond(id, response); }
  setModel(provider: string, id: string) { return this.current!.setModel(provider, id); }
  setThinking(level: string) { return this.current!.setThinking(level); }
  async setAccess(mode: AccessMode) {
    if (this.busy) throw new Error('请等待所有会话结束，再修改权限');
    await this.current!.setAccess(mode);
    for (const channel of this.channels.values()) if (channel !== this.current) await channel.suspend();
    if (this.side?.snapshot.threadId) await this.openSide(this.side.snapshot.threadId);
  }
  removeAttachment(id: string) { this.current!.removeAttachment(id); }
  async openSide(id: string) {
    if (this.sideOpening) throw new Error('正在打开侧边对话，请稍候');
    if (id === this.snapshot.threadId) throw new Error('该会话已在主窗口打开');
    const thread = this.store.thread(id);
    if (thread.archivedAt || this.store.projectFor(thread).archivedAt) throw new Error('请先恢复已归档的会话');
    const previous = this.side, target = this.channel(id);
    this.sideOpening = true; this.publishActivity();
    try { this.side = target; this.store.data.activeSideThreadId = id; this.store.save(); if (!target.rpc?.alive || target.rpc.closing || !target.snapshot.connected) await target.connect(id); }
    finally {
      this.sideOpening = false; this.publishActivity();
      target.publish(); this.send({ kind: 'data' });
      if (previous && previous !== target && previous !== this.current && !previous.busy) await previous.suspend();
    }
    return target.view();
  }
  async closeSide() {
    const previous = this.side; this.side = undefined;
    if (this.store.data.activeSideThreadId) { delete this.store.data.activeSideThreadId; this.store.save(); }
    if (previous && previous !== this.current && !previous.busy) await previous.suspend();
    this.send({ kind: 'data' });
  }
  async closeSideFor(kind: 'project' | 'thread', id: string) {
    const thread = this.store.data.threads.find(t => t.id === this.side?.snapshot.threadId);
    if (thread && (kind === 'thread' ? thread.id === id : thread.projectId === id)) await this.closeSide();
  }
  async branchSelection(quote: SelectionQuote) {
    if (this.navigating) throw new Error('正在切换会话，请稍候');
    const source = this.visibleChannel(quote.threadId), thread = this.store.thread(quote.threadId);
    if (!quote.entryId || !source.rpc?.alive) throw new Error('请等待这条消息保存后，再创建侧边对话');
    this.branching = true; this.publishActivity();
    try {
      const tree = await source.rpc.request<{ entries: TreeEntry[]; leafId: string | null }>('get_entries');
      const branch = branchEntries(tree.entries, tree.leafId), selected = branch.find(e => e.id === quote.entryId);
      if (!selected || selected.type !== 'message' || !['user','assistant'].includes(selected.message?.role || '')) throw new Error('这段选区已不在当前会话路径中，请重新选择');
      const state = await source.rpc.request('get_state');
      const file = await createSelectionBranch(this.runtime, state.sessionFile, this.store.projectFor(thread).path, path.join(this.store.directory, 'sessions', thread.projectId), tree.entries, quote.entryId);
      const child = this.store.addThread(thread.projectId, false);
      child.title = '侧聊 · ' + quote.text.replace(/\s+/g, ' ').slice(0, 24); child.titleSource = 'fallback';
      child.sessionFile = file.file; child.attachmentPaths = [...(thread.attachmentPaths || [])];
      child.origin = { ...quote, title: thread.title, inheritedMessages: file.inherited, inheritedEntryIds: branch.slice(0, branch.indexOf(selected)).map(e => e.id) }; this.store.save();
      await this.openSide(child.id); return child;
    } finally { this.branching = false; this.publishActivity(); this.send({ kind: 'data' }); }
  }
  clearAttachments() { for (const channel of this.channels.values()) channel.clearAttachments(); }
  async close() { this.titles.shutdown(); for (const channel of this.channels.values()) await channel.rpc?.close(); }
  kill() { this.titles.shutdown(); for (const channel of this.channels.values()) channel.rpc?.kill(); }
}
