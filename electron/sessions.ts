import type { AccessMode, DesktopEvent, ThreadActivity } from '../shared/types';
import type { Store } from './store';
import type { RuntimeManager } from './runtime';
import { SessionChannel, emptySnapshot } from './session';
import { SessionTitles } from './session-title';

export class Sessions {
  private channels = new Map<string, SessionChannel>();
  private current?: SessionChannel;
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
  get busy() { return this.switching || [...this.channels.values()].some(c => c.busy) || this.naming.size > 0; }
  get navigating() { return this.switching; }
  get currentBusy() { return this.switching || !!this.current?.busy; }
  get activities(): ThreadActivity[] {
    return [...this.channels.entries()].filter(([id]) => id !== '').map(([id, channel]) => ({ id, busy: channel.busy, waiting: channel.pendingUI.size > 0, naming: this.naming.has(id) }));
  }
  private publishActivity() { this.send({ kind: 'activity', activities: this.activities, navigating: this.switching }); }
  private channel(id?: string) {
    const key = id || ''; let channel = this.channels.get(key);
    if (!channel) {
      channel = new SessionChannel(this.store, this.runtime, this.extension, event => {
        if (event.kind === 'data') this.send(event);
        else if (this.current === channel) this.send(event);
        if (event.kind === 'snapshot' || event.kind === 'pi' && ['agent_start', 'agent_settled', 'extension_ui_request'].includes(event.record.type)) this.publishActivity();
        if (event.kind === 'pi' && event.record.type === 'extension_ui_request' && channel !== this.current && channel!.pendingUI.size) this.send({ kind: 'notice', message: `${this.store.thread(id).title} 正在等待确认，点击侧栏会话继续。` });
      }, c => { void this.settled(c); });
      this.channels.set(key, channel);
    }
    return channel;
  }
  async connect(id?: string, force = false) {
    if (this.switching) throw new Error('正在切换会话，请稍候');
    if (id) { const thread = this.store.thread(id); if (thread.archivedAt || this.store.projectFor(thread).archivedAt) throw new Error('此会话已归档，请先恢复'); }
    this.switching = true; this.publishActivity();
    const previous = this.current, target = this.channel(id);
    try {
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
    await this.suspendAll(); return this.connect(this.store.data.activeThreadId, true);
  }
  async suspendAll() { for (const channel of this.channels.values()) await channel.suspend(); }
  async detach() {
    if (this.currentBusy) throw new Error('请等待当前任务结束');
    this.current?.clearAttachments(); await this.current?.suspend();
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
          const title = await this.titles.generate(model, messages, env);
          const latest = this.store.data.threads.find(t => t.id === id);
          if (latest && latest.titleSource !== 'manual') { latest.title = title; latest.titleSource = 'model'; latest.titleStatus = 'done'; this.store.save(); }
        } catch {
          const latest = this.store.data.threads.find(t => t.id === id);
          if (latest && latest.titleSource !== 'manual') { latest.titleStatus = 'failed'; this.store.save(); }
        } finally { this.naming.delete(id); this.send({ kind: 'data' }); this.publishActivity(); }
      }
    }
    if (this.current !== channel && !channel.busy && !this.switching) await channel.suspend();
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
  }
  removeAttachment(id: string) { this.current!.removeAttachment(id); }
  clearAttachments() { for (const channel of this.channels.values()) channel.clearAttachments(); }
  async close() { this.titles.shutdown(); for (const channel of this.channels.values()) await channel.rpc?.close(); }
  kill() { this.titles.shutdown(); for (const channel of this.channels.values()) channel.rpc?.kill(); }
}
