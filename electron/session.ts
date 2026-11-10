import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { DesktopEvent, Model, Snapshot, PiEvent, AccessMode, Attachment } from '../shared/types';
import { Store } from './store';
import { PiRpc } from './rpc';
import { RuntimeManager } from './runtime';
import { discardAttachment } from './attachments';

export const emptySnapshot = (): Snapshot => ({ connected: false, busy: false, thinkingLevel: 'off', models: [], levels: [], commands: [], messages: [] });
export class SessionChannel {
  rpc?: PiRpc;
  snapshot = emptySnapshot();
  private connecting = false;
  private starting = false;
  private settling = false;
  private healthy = false;
  private suspension?: Promise<void>;
  pendingUI = new Map<string, PiEvent>();
  attachments = new Map<string, { info: Attachment; path: string }>();
  constructor(private store: Store, private runtime: RuntimeManager, private extension: string, private sendEvent: (event: DesktopEvent) => void, private settled: (channel: SessionChannel) => void = () => {}) {}
  get busy() { return this.connecting || this.starting || this.settling || !!this.rpc?.busy; }
  private emit(record: PiEvent, threadId = this.snapshot.threadId) { this.sendEvent({ kind: 'pi', threadId, record }); }
  environment() {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: this.store.agentDir, SAINT_ACCESS_MODE: this.store.data.settings.access };
    const names: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', custom: 'SAINT_CUSTOM_API_KEY' };
    const providers: Record<string, unknown> = {};
    for (const provider of this.store.data.settings.providers) {
      const encrypted = this.store.data.secrets[provider.id];
      if (encrypted) env[names[provider.id]] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (provider.id === 'custom') {
        providers['saint-custom'] = { baseUrl: provider.baseUrl, api: 'openai-completions', apiKey: encrypted ? '$SAINT_CUSTOM_API_KEY' : 'local', models: [{ id: provider.modelId, name: provider.name || provider.modelId, contextWindow: provider.contextWindow || 128000, maxTokens: 8192, reasoning: !!provider.reasoning, input: provider.supportsImages ? ['text','image'] : ['text'] }] };
      } else if (provider.baseUrl) providers[provider.id] = { baseUrl: provider.baseUrl };
    }
    fs.writeFileSync(path.join(this.store.agentDir, 'models.json'), JSON.stringify({ providers }, null, 2));
    return env;
  }
  async connect(threadId?: string) {
    if (this.busy) throw new Error('请先停止当前任务，再切换会话');
    if (threadId) { const thread = this.store.thread(threadId); if (thread.archivedAt || this.store.projectFor(thread).archivedAt) throw new Error('此会话已归档，请先在归档列表中恢复'); }
    this.connecting = true;
    this.snapshot = { ...this.snapshot, connected: false, busy: true };
    this.sendEvent({ kind: 'snapshot', snapshot: this.snapshot });
    try {
      await this.suspension;
      await this.rpc?.close(); this.pendingUI.clear(); this.healthy = false;
      const thread = threadId ? this.store.thread(threadId) : undefined;
      const project = thread ? this.store.projectFor(thread) : undefined;
      const cwd = project?.path || path.join(this.store.directory, 'engine-workspace');
      if (!project) fs.mkdirSync(cwd, {recursive:true});
      if (!fs.existsSync(cwd)) throw new Error('工作空间目录已移动或不可访问');
      const launch = this.runtime.launch();
      const args = [...launch.args, '--mode', 'rpc', '-e', this.extension];
      if (project) { const directory = path.join(this.store.directory,'sessions',project.id); fs.mkdirSync(directory,{recursive:true}); args.push('--session-dir',directory); }
      else args.push('--no-session','--no-approve');
      if (project?.trusted) args.push('--approve');
      if (thread?.sessionFile && fs.existsSync(thread.sessionFile)) args.push('--session', thread.sessionFile);
      else {
        const model = this.store.data.settings.defaultModel;
        if (model) args.push('--provider', model.provider, '--model', model.id);
        if (this.store.data.settings.defaultThinking) args.push('--thinking', this.store.data.settings.defaultThinking);
      }
      for (const skill of this.store.data.skillPaths.filter(p => fs.existsSync(p))) args.push('--skill', skill);
      const rpc = new PiRpc(launch.executable, args, cwd, { ...this.environment(), ...launch.env }); this.rpc = rpc;
      this.snapshot = { ...emptySnapshot(), threadId, busy: true };
      rpc.on('record', record => { if (this.rpc === rpc && !rpc.closing) this.handle(record, threadId); });
      rpc.on('closed', error => { if (this.rpc !== rpc) return; this.starting = false; this.healthy = false; this.snapshot.connected = false; this.snapshot.busy = false; this.snapshot.error = error.message; this.sendEvent({ kind: 'snapshot', snapshot: this.snapshot }); });
      await rpc.start();
      const commands = await rpc.request('get_commands');
      if (!commands.commands?.some((c: { name: string }) => c.name === 'saint-access')) throw new Error('Pi 未加载 Saint 权限扩展，暂不能执行任务。');
      this.healthy = true;
      return await this.refresh();
    } catch (error) {
      await this.rpc?.close(); this.snapshot = { ...emptySnapshot(), threadId, error: (error as Error).message }; this.sendEvent({ kind: 'snapshot', snapshot: this.snapshot }); throw error;
    } finally { this.connecting = false; this.snapshot.busy = this.starting || !!this.rpc?.busy; this.sendEvent({ kind: 'snapshot', snapshot: this.snapshot }); }
  }
  async detach() {
    if (this.busy) throw new Error('请等待当前任务结束');
    this.connecting = true;
    try {
      await this.rpc?.close(); this.rpc = undefined; this.pendingUI.clear(); this.healthy = false;
      this.store.data.activeThreadId = undefined; this.snapshot = emptySnapshot();
      this.sendEvent({ kind: 'snapshot', snapshot: this.snapshot });
    } finally { this.connecting = false; }
  }
  suspend() {
    if (this.suspension) return this.suspension;
    const rpc = this.rpc;
    // Detach before awaiting shutdown: a returning conversation must wait for
    // this process, never reuse it or have its new process cleared afterward.
    this.rpc = undefined; this.healthy = false; this.snapshot.connected = false;
    this.suspension = (async () => { await rpc?.close(); })().finally(() => { this.suspension = undefined; });
    return this.suspension;
  }
  publish() {
    this.snapshot = { ...this.snapshot, attachments: [...this.attachments.values()].map(a => a.info), requests: [...this.pendingUI.values()] };
    this.sendEvent({ kind: 'snapshot', snapshot: this.snapshot });
  }
  private handle(record: PiEvent, threadId?: string) {
    if (record.type === 'extension_ui_request' && ['confirm','select','input','editor'].includes(record.method)) this.pendingUI.set(record.id, record);
    if (record.type === 'agent_start') { this.starting = false; this.snapshot.busy = true; }
    if (record.type === 'agent_settled') {
      this.starting = false; this.settling = true; this.snapshot.busy = false; this.pendingUI.clear(); this.snapshot.streaming = [];
      // Keep the process until its final messages/statistics have been read, even
      // if navigation moves it into the background during this round trip.
      void this.refresh().then(() => { this.settling = false; this.settled(this); this.publish(); }).catch(e => { this.settling = false; this.emit({ type: 'saint_error', message: e.message }); this.publish(); });
    }
    if (record.type === 'message_update') {
      const e = record.assistantMessageEvent;
      if (e) { const blocks = this.snapshot.streaming || []; const i = e.contentIndex ?? 0;
        if (e.type === 'text_delta') blocks[i] = { type: 'text', text: (blocks[i]?.text || '') + e.delta };
        if (e.type === 'thinking_delta') blocks[i] = { type: 'thinking', thinking: (blocks[i]?.thinking || '') + e.delta };
        if (e.type === 'text_end') blocks[i] = { type: 'text', text: e.content };
        if (e.type === 'thinking_end') blocks[i] = { type: 'thinking', thinking: e.content };
        this.snapshot.streaming = blocks;
      }
    }
    if (record.type === 'tool_execution_start') this.snapshot.tools = { ...this.snapshot.tools, [record.toolCallId]: record };
    if (record.type === 'tool_execution_end') { const tools = { ...this.snapshot.tools }; delete tools[record.toolCallId]; this.snapshot.tools = tools; }
    if (record.type === 'message_end') { this.snapshot.messages = [...this.snapshot.messages, record.message]; if (record.message?.role === 'assistant') this.snapshot.streaming = []; }
    if (record.type === 'message_end' && threadId) {
      const thread = this.store.thread(threadId); thread.updatedAt = Date.now(); this.store.save();
      void this.rpc?.request('get_session_stats').then(stats => { this.snapshot.stats = stats; this.emit({ type: 'saint_stats', stats }, threadId); }).catch(() => {});
    }
    if (record.type === 'extension_error' && (record.event === 'tool_call' || String(record.extensionPath).includes('permissions'))) {
      this.healthy = false; void this.rpc?.stop().catch(() => {});
      this.emit({ type: 'saint_error', message: '权限扩展发生错误，已停止任务；请重新连接引擎。' }, threadId);
    }
    this.emit(record, threadId);
  }
  private model(model: any): Model | undefined { return model && model.id !== 'unknown' && model.provider !== 'unknown' ? { id: model.id, name: model.name || model.id, provider: model.provider, reasoning: !!model.reasoning, contextWindow: model.contextWindow, input: model.input } : undefined; }
  async refresh() {
    if (!this.rpc?.alive) return this.snapshot;
    const rpc = this.rpc;
    const [state, models, levels, commands, messages, stats] = await Promise.all([rpc.request('get_state'), rpc.request('get_available_models'), rpc.request('get_available_thinking_levels'), rpc.request('get_commands'), rpc.request('get_messages'), rpc.request('get_session_stats')]);
    if (rpc !== this.rpc) return this.snapshot;
    this.snapshot = { ...this.snapshot, connected: true, busy: this.connecting || rpc.busy || this.starting || !!state.isStreaming || !!state.isCompacting, threadId: this.snapshot.threadId, model: this.model(state.model), thinkingLevel: state.thinkingLevel, models: models.models.map((m: unknown) => this.model(m)).filter(Boolean), levels: levels.levels, commands: commands.commands, messages: messages.messages, stats, sessionFile: state.sessionFile };
    if (this.snapshot.threadId) { const thread = this.store.thread(this.snapshot.threadId); thread.sessionFile = state.sessionFile; this.store.save(); }
    this.publish(); return this.snapshot;
  }
  async prompt(text: string, skills: string[], attachments: string[]) {
    if (!this.snapshot.threadId) throw new Error('请先选择工作空间，再发送任务');
    if (!this.rpc?.alive || this.rpc.closing || !this.healthy) throw new Error('引擎未就绪，请重新连接');
    if (this.busy) throw new Error('请等待当前任务完成，或先停止');
    if (!this.snapshot.model || !this.snapshot.models.some(m => m.provider === this.snapshot.model?.provider && m.id === this.snapshot.model.id)) throw new Error('请先在设置中连接模型，并在输入框选择模型');
    if (this.runtime.info().updating) throw new Error('引擎更新中，请稍候');
    if (attachments.length > 10 || new Set(attachments).size !== attachments.length) throw new Error('附件数量无效，请重新添加');
    let message = text;
    const blocks: string[] = [];
    for (const name of skills) { const skill = this.snapshot.commands.find(c => c.name === name && c.source === 'skill'); if (!skill?.sourceInfo?.path) throw new Error('技能已失效，请重新选择'); const stat = fs.statSync(skill.sourceInfo.path); if (stat.size > 128000) throw new Error('技能文件超过 128 KB'); blocks.push(`<skill name="${name}" directory="${path.dirname(skill.sourceInfo.path)}">\n${fs.readFileSync(skill.sourceInfo.path,'utf8')}\n</skill>`); }
    const images: { type: string; data: string; mimeType: string }[] = [];
    for (const id of attachments) {
      const item = this.attachments.get(id); if (!item) throw new Error('附件已失效，请重新添加');
      if (item.info.image) {
        const data = fs.readFileSync(item.path); if (data.length > 10 * 1024 * 1024) throw new Error('图片超过 10 MB，请重新添加');
        const ext = path.extname(item.path).slice(1).toLowerCase(); images.push({ type: 'image', data: data.toString('base64'), mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
      } else if (item.info.kind === 'text') {
        const data = fs.readFileSync(item.path); if (data.includes(0) || data.length > 256000) throw new Error('文本附件已变化，请重新添加');
        blocks.push(`<attachment>\n${JSON.stringify({name:item.info.name,localPath:item.path})}\n${data.toString('utf8')}\n</attachment>`);
      } else {
        const stat = fs.statSync(item.path); if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('本地附件不可用，请重新添加');
        blocks.push(`<attachment>\n${JSON.stringify({name:item.info.name,bytes:stat.size,localPath:item.path})}\n这是已附加的本地文件，内容尚未解析。请按文件类型使用可用的本地读取工具处理；不要把文件本身当作程序自动执行。\n</attachment>`);
      }
    }
    if (images.length && !this.snapshot.model.input?.includes('image')) throw new Error('当前模型不支持图片，请切换视觉模型');
    if (blocks.length) message += '\n\n' + blocks.join('\n\n');
    this.starting = true;
    this.snapshot.busy = true; this.sendEvent({ kind: 'snapshot', snapshot: this.snapshot });
    try {
      const result = await this.rpc.request('prompt', { message, ...(images.length ? { images } : {}) }, 60_000);
      const thread = this.store.thread(this.snapshot.threadId); if (thread.title === '新建会话' && thread.titleSource !== 'manual') { thread.title = text.replace(/\s+/g, ' ').slice(0, 38); thread.titleSource = 'fallback'; this.store.save(); this.sendEvent({ kind: 'data' }); }
      if (attachments.length) {
        thread.attachmentPaths = [...new Set([...(thread.attachmentPaths || []), ...attachments.map(id => this.attachments.get(id)!.path)])];
        this.store.save();
      }
      if (result?.disposition === 'handled') { this.starting = false; await this.refresh(); }
      attachments.forEach(id => this.attachments.delete(id)); return result;
    } catch (e) { this.starting = false; this.snapshot.busy = !!this.rpc?.busy; this.sendEvent({ kind: 'snapshot', snapshot: this.snapshot }); throw e; }
  }
  removeAttachment(id: string) { const item = this.attachments.get(id); if (item) discardAttachment(item, path.join(this.store.directory, 'attachments')); this.attachments.delete(id); }
  clearAttachments() { for (const id of this.attachments.keys()) this.removeAttachment(id); }
  async stop() { for (const id of this.pendingUI.keys()) this.rpc?.respond({ id, cancelled: true }); this.pendingUI.clear(); const queue = await this.rpc?.stop(); this.starting = false; return queue; }
  async setModel(provider: string, modelId: string) { if (this.busy) throw new Error('请等待当前任务结束'); if (!this.snapshot.models.some(m => m.provider === provider && m.id === modelId)) throw new Error('模型不可用'); await this.rpc?.request('set_model', { provider, modelId }); this.store.data.settings.defaultModel = { provider, id: modelId }; this.store.save(); return this.refresh(); }
  async setThinking(level: string) { if (this.busy) throw new Error('请等待当前任务结束'); if (!this.snapshot.levels.includes(level)) throw new Error('当前模型不支持该思考强度'); await this.rpc?.request('set_thinking_level', { level }); this.store.data.settings.defaultThinking = level; this.store.save(); return this.refresh(); }
  async setAccess(mode: AccessMode) { if (this.busy) throw new Error('请等待当前任务结束'); if (this.rpc?.alive) await this.rpc.request('prompt', { message: `/saint-access ${mode}` }); this.store.data.settings.access = mode; this.store.save(); }
  respond(id: string, response: { confirmed?: boolean; value?: string; cancelled?: boolean }) { if (!this.pendingUI.has(id)) throw new Error('审批请求已结束'); this.rpc?.respond({ id, ...response }); this.pendingUI.delete(id); }
}
