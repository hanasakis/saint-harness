import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, ChevronDown, CornerUpLeft, GitBranch, Loader2, MessageSquarePlus, Paperclip, ShieldCheck, Square, X, Brain } from 'lucide-react';
import type { Attachment, Bootstrap, PiEvent, SelectionQuote, Snapshot } from '../shared/types';
import { quotedPrompt, partitionBranchMessages } from '../shared/selection';
import { formatContextPercent } from '../shared/usage';
import { ComposerInput } from './ComposerInput';
import { QuoteSelection } from './QuoteSelection';
import { SelectionActions } from './SelectionActions';
import { IconButton, MessageView, Streaming, ToolActivity, levelNames, modeNames } from './components';

type Props = { data: Bootstrap; initial: Snapshot; onClose: () => void; onOpen: (id: string) => void; onBranch: (quote: SelectionQuote) => void; onSource: (quote: SelectionQuote) => void };
export function SideChat({ data, initial, onClose, onOpen, onBranch, onSource }: Props) {
  const id = initial.threadId!, thread = data.threads.find(t => t.id === id)!;
  const [snap, setSnap] = useState(initial), [working, setWorking] = useState(''), [error, setError] = useState('');
  const [draft, setDraft] = useState(() => readSideDraft(id)?.text || '');
  const [quotes, setQuotes] = useState<SelectionQuote[]>(() => readSideDraft(id)?.quotes ?? (thread.origin && !partitionBranchMessages(initial.messages, thread.origin.inheritedEntryIds).own.length ? [thread.origin] : []));
  const [attachments, setAttachments] = useState<Attachment[]>(initial.attachments || []);
  const [response, setResponse] = useState(''), [picker, setPicker] = useState<'model' | 'thinking'>();
  const input = useRef<HTMLTextAreaElement>(null), controller = useRef<{ paste: () => void }>(null), feed = useRef<HTMLDivElement>(null), follow = useRef(true);
  const busy = snap.busy || !!working, request = snap.requests?.[0];
  const messages = partitionBranchMessages(snap.messages, thread.origin?.inheritedEntryIds || []);
  useEffect(() => { localStorage.setItem('saint-side-draft:' + id, JSON.stringify({ text: draft, quotes })); }, [draft, quotes, id]);
  useEffect(() => {
    input.current?.focus();
    return window.saint.onEvent(event => {
      if (event.kind === 'side-snapshot' && event.snapshot.threadId === id) { setSnap(event.snapshot); setAttachments(event.snapshot.attachments || []); return; }
      if (event.kind !== 'side-pi' || event.threadId !== id) return;
      const r = event.record;
      if (r.type === 'saint_error') setError(r.message);
      if (r.type === 'extension_ui_request' && r.method === 'set_editor_text') setDraft(r.text || '');
      setSnap(previous => sideEvent(previous, r));
    });
  }, [id]);
  useEffect(() => { if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [snap.messages, snap.streaming, snap.tools]);
  useEffect(() => setResponse(request?.prefill || ''), [request?.id]);
  async function run<T,>(label: string, operation: () => Promise<T>) {
    setWorking(label); setError('');
    try { return await operation(); } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } finally { setWorking(''); }
  }
  async function send() {
    if (busy || (!draft.trim() && !quotes.length && !attachments.length)) return;
    const original = draft, reference = quotes; follow.current = true;
    await run('发送任务', async () => {
      setDraft(''); setQuotes([]);
      try { await window.saint.invoke('side.send', { threadId: id, text: quotedPrompt(original, reference) || '请查看这些附件。', attachments: attachments.map(a => a.id) }); setAttachments([]); }
      catch (e) { setDraft(original); setQuotes(reference); throw e; }
    });
  }
  const quote = (value: SelectionQuote) => { if (quotes.length >= 8) { setError('一次最多引用 8 段文字'); return; } setQuotes(q => [...q, value]); input.current?.focus(); };
  const answer = (value: Record<string, unknown>) => { if (request) void run('回复审批', async () => { await window.saint.invoke('side.respond', { threadId: id, id: request.id, ...value }); setSnap(s => ({ ...s, requests: s.requests?.filter(r => r.id !== request.id) })); }); };
  return <aside className="sidechat" aria-label="侧边对话">
    <header className="sidechatheader"><div><MessageSquarePlus/><strong>Side chat</strong><span>侧边对话</span></div><IconButton title="在主窗口打开侧边对话" onClick={() => onOpen(id)}><ArrowUpRight/></IconButton><IconButton title="收起侧边对话" onClick={onClose}><X/></IconButton></header>
    <div className="sidechatbreadcrumb"><GitBranch/><span>{thread.title}</span>{thread.origin && <button disabled={!data.threads.some(t => t.id === thread.origin!.threadId && !t.archivedAt && !data.projects.find(p => p.id === t.projectId)?.archivedAt)} onClick={() => onSource(thread.origin!)}><CornerUpLeft/>回到来源</button>}</div>
    <div className="sidechatfeed" ref={feed} onScroll={() => { const el = feed.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <SelectionActions threadId={id} title={thread.title} onQuote={quote} onSide={onBranch} onPaste={() => controller.current?.paste()} onError={setError} disabled={data.navigating}>
        {messages.inherited.length > 0 && <details className="inheritedcontext"><summary>已继承此前的上下文 · {messages.inherited.filter(m=>['user','assistant'].includes(m.role)).length} 条消息<ChevronDown/></summary>{messages.inherited.map((m, i) => <MessageView key={m.entryId || i} message={m}/>)}</details>}
        {!messages.own.length && !snap.busy ? <div className="sidechatwelcome"><MessageSquarePlus/><h3>围绕选区，继续深入。</h3><p>写下你的问题，开始一条侧边分支。<br/>对话会保存在左侧的「侧边对话」中。</p></div> : messages.own.map((m, i) => <MessageView key={m.entryId || i} message={m}/>)}
        <Streaming blocks={snap.streaming || []} running={snap.busy}/><ToolActivity tools={snap.tools || {}}/>
      </SelectionActions>
    </div>
    {request && <div className="sideapproval glass" role="group" aria-label="侧边对话审批"><strong>{request.title || '需要你的确认'}</strong>{request.message && <pre>{request.message}</pre>}{['input','editor'].includes(request.method) && <textarea aria-label="侧边审批回复" value={response} onChange={e => setResponse(e.target.value)}/>}<div><button className="outlinebutton" disabled={!!working} onClick={() => answer({ cancelled: true })}>拒绝 / 取消</button>{request.method === 'select' ? request.options?.map((option: string) => <button className="outlinebutton" key={option} onClick={() => answer({ value: option })}>{option}</button>) : <button className="primarybutton" disabled={!!working} onClick={() => answer(request.method === 'confirm' ? { confirmed: true } : { value: response })}>{request.method === 'confirm' ? '允许这一次' : '提交'}</button>}</div></div>}
    {error && <div className="sideerror" role="alert"><span>{error}</span><button aria-label="关闭侧边提示" onClick={() => setError('')}><X/></button></div>}
    {!snap.connected && !busy && <button className="textbutton side-reconnect" onClick={() => void run('重新连接', () => window.saint.invoke('side.open', { id }))}>重新连接侧边对话</button>}
    <div className="sidecomposerwrap" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } }} onDrop={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); if (!busy) void run('添加附件', async () => { const added = await window.saint.addDroppedFiles(Array.from(e.dataTransfer.files), id); setAttachments(a => [...a, ...added]); }); }}>
      <div className={`composer ${snap.busy ? 'running' : ''}`}>
        <QuoteSelection quotes={quotes} onChange={setQuotes}/>
        {!!attachments.length && <div className="chips">{attachments.map(a => <button className={`filechip ${a.preview ? 'imagechip' : ''}`} key={a.id} aria-label={`移除侧边附件 ${a.name}`} disabled={!!working} onClick={() => void run('移除附件', async () => { await window.saint.invoke('attachments.remove', { threadId: id, id: a.id }); setAttachments(v => v.filter(item => item.id !== a.id)); })}>{a.preview ? <img src={a.preview} alt={a.name}/> : <Paperclip/>}<span>{a.name}</span><X/></button>)}</div>}
        <ComposerInput label="侧边对话输入" inputRef={input} controller={controller} value={draft} onChange={setDraft} placeholder="围绕选中文字，继续提问…" threadId={id} onSend={() => void send()} onPaste={operation => run('粘贴内容', operation)} onAttachments={added => setAttachments(a => [...a, ...added])} onError={setError}/>
        <div className="composertools">
          <IconButton title="添加侧边附件" disabled={busy} onClick={() => void run('添加附件', async () => { const added = await window.saint.invoke<Attachment[]>('attachments.pick', { threadId: id }); setAttachments(a => [...a, ...added]); })}><Paperclip/></IconButton>
          <div className="anchor"><button className="tool" disabled={busy} onClick={() => setPicker(p => p === 'model' ? undefined : 'model')}>{snap.model?.name || '选择模型'}<ChevronDown/></button>{picker === 'model' && <div className="popover glass sidepicker">{snap.models.map(m => <button key={m.provider + m.id} onClick={() => void run('切换模型', async () => { await window.saint.invoke('side.model', { threadId: id, provider: m.provider, modelId: m.id }); setPicker(undefined); })}>{m.name}</button>)}</div>}</div>
          <div className="anchor"><button className="tool" disabled={busy} onClick={() => setPicker(p => p === 'thinking' ? undefined : 'thinking')}><Brain/>{levelNames[snap.thinkingLevel] || snap.thinkingLevel}</button>{picker === 'thinking' && <div className="popover glass sidepicker">{snap.levels.map(level => <button key={level} onClick={() => void run('设置思考强度', async () => { await window.saint.invoke('side.thinking', { threadId: id, level }); setPicker(undefined); })}>{levelNames[level] || level}</button>)}</div>}</div>
          <span className="sideaccess"><ShieldCheck/>{modeNames[data.settings.access]}</span>
          {snap.busy ? <button className="send stop" aria-label="停止侧边任务" onClick={() => void run('停止任务', () => window.saint.invoke('side.stop', { id }))}><Square fill="currentColor"/></button> : <button className="send" aria-label="发送侧边任务" disabled={!!working || !snap.connected || (!draft.trim() && !quotes.length && !attachments.length)} onClick={() => void send()}>{working ? <Loader2 className="spin"/> : <ArrowUp/>}</button>}
        </div>
      </div><div className="composerfoot"><span>{working || 'Enter 发送 · Shift Enter 换行'}</span><span>上下文 {formatContextPercent(snap.stats?.contextUsage?.percent)}</span></div>
    </div>
  </aside>;
}
export function readSideDraft(id: string): { text: string; quotes: SelectionQuote[] } | undefined {
  try { const value = JSON.parse(localStorage.getItem('saint-side-draft:' + id) || 'null'); if (value && typeof value.text === 'string' && Array.isArray(value.quotes)) return value; } catch {}
}
function sideEvent(s: Snapshot, r: PiEvent): Snapshot {
  if (r.type === 'agent_start') return { ...s, busy: true, streaming: [] };
  if (r.type === 'agent_settled') return { ...s, busy: false, streaming: [], requests: [] };
  if (r.type === 'message_end') return { ...s, messages: [...s.messages, r.message], streaming: r.message?.role === 'assistant' ? [] : s.streaming };
  if (r.type === 'message_update') {
    const e = r.assistantMessageEvent; if (!e) return s;
    const next = (s.streaming || []).map(b => ({ ...b })), i = e.contentIndex ?? 0;
    if (e.type === 'text_delta') next[i] = { type: 'text', text: (next[i]?.text || '') + e.delta };
    if (e.type === 'thinking_delta') next[i] = { type: 'thinking', thinking: (next[i]?.thinking || '') + e.delta };
    if (e.type === 'text_end') next[i] = { type: 'text', text: e.content };
    if (e.type === 'thinking_end') next[i] = { type: 'thinking', thinking: e.content };
    return { ...s, streaming: next };
  }
  if (r.type === 'tool_execution_start') return { ...s, tools: { ...s.tools, [r.toolCallId]: r } };
  if (r.type === 'tool_execution_end') { const tools = { ...s.tools }; delete tools[r.toolCallId]; return { ...s, tools }; }
  if (r.type === 'saint_stats') return { ...s, stats: r.stats };
  if (r.type === 'extension_ui_request' && ['confirm','select','input','editor'].includes(r.method)) return { ...s, requests: [...(s.requests || []), r] };
  return s;
}
