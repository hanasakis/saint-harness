import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArrowRightLeft, Copy, Ellipsis, Folder, FolderOpen, Info, Link, Plus, RotateCcw, Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import type { Bootstrap } from '../shared/types';
import { IconButton, Modal } from './components';

const threadMime = 'application/x-saint-thread';
type Target = { kind: 'project' | 'thread'; id: string };
type Props = {
  data?: Bootstrap; activeId?: string; busy: boolean; running: boolean;
  onOpen: (id: string) => void; onAdd: () => void;
  onAction: (action: string, payload: unknown, notice?: string) => Promise<boolean>;
};
export function WorkspaceSidebar({ data, activeId, busy, running, onOpen, onAdd, onAction }: Props) {
  const [menu, setMenu] = useState<(Target & { x: number; y: number }) | null>(null);
  const [detail, setDetail] = useState<Target | null>(null);
  const [title, setTitle] = useState('');
  const [moving, setMoving] = useState<string>();
  const [archives, setArchives] = useState(false);
  const [deletion, setDeletion] = useState<Target | null>(null);
  const [dropTarget, setDropTarget] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);
  const projects = data?.projects.filter(p => !p.archivedAt) || [];
  const threads = data?.threads || [];
  const archivedProjects = data?.projects.filter(p => p.archivedAt) || [];
  const archivedThreads = threads.filter(t => t.archivedAt || data?.projects.find(p => p.id === t.projectId)?.archivedAt);
  const name = (target: Target) => target.kind === 'project' ? data?.projects.find(p => p.id === target.id)?.name : threads.find(t => t.id === target.id)?.title;
  useLayoutEffect(() => {
    const node = menuRef.current; if (!node || !menu) return;
    const bounds = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    node.style.top = `${Math.max(40, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(null); } };
    const dismiss = () => setMenu(null);
    const scroll = (e: Event) => { if (e.target instanceof HTMLElement && e.target.classList.contains('projectlist')) dismiss(); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key, true); window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss); document.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); document.removeEventListener('scroll', scroll, true); };
  }, [menu]);
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => { if (e.key !== 'Escape') return; if (deletion) { e.stopPropagation(); if (!busy) setDeletion(null); } else if (detail || moving || archives) { e.stopPropagation(); setDetail(null); setMoving(undefined); setArchives(false); } };
    document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true);
  }, [detail, moving, archives, deletion, busy]);
  function context(e: MouseEvent, target: Target) { e.preventDefault(); e.stopPropagation(); setMenu({ ...target, x: e.clientX, y: e.clientY }); }
  function keyboardContext(e: KeyboardEvent, target: Target) {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault(); const box = e.currentTarget.getBoundingClientRect(); setMenu({ ...target, x: box.left + 24, y: box.bottom });
  }
  function showDetails(target: Target) { setMenu(null); setTitle(name(target) || ''); setDetail(target); }
  async function action(action: string, target: Target, notice?: string) { setMenu(null); return onAction(action, { id: target.id }, notice); }
  async function move(id: string, projectId: string) {
    setDropTarget(undefined); setDragging(undefined);
    if (await onAction('thread.move', { id, projectId }, '会话已迁移，后续任务将在目标项目中执行')) setMoving(undefined);
  }
  const detailThread = detail?.kind === 'thread' ? threads.find(t => t.id === detail.id) : undefined;
  const detailProject = data?.projects.find(p => p.id === (detail?.kind === 'project' ? detail.id : detailThread?.projectId));
  const deletionProject = deletion?.kind === 'project' ? data?.projects.find(p => p.id === deletion.id) : undefined;
  const deletionCount = deletion?.kind === 'project' ? threads.filter(t => t.projectId === deletion.id).length : 1;
  return <>
    <div className="projectlist"><div className="sectionlabel">工作空间<IconButton title="添加工作空间" onClick={onAdd} disabled={busy}><Plus /></IconButton></div>
      {projects.map(p => <div className={`projectgroup ${dropTarget === p.id ? 'droptarget' : ''}`} key={p.id} data-project-id={p.id}
        onDragOver={e => { if (busy || !e.dataTransfer.types.includes(threadMime) || threads.find(t => t.id === dragging)?.projectId === p.id) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(p.id); }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(undefined); }}
        onDrop={e => { if (!e.dataTransfer.types.includes(threadMime)) return; e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData(threadMime); setDropTarget(undefined); if (!busy && threads.some(t => t.id === id && !t.archivedAt)) void move(id, p.id); }}>
        <div className="projectheading" onContextMenu={e => context(e, { kind: 'project', id: p.id })} onKeyDown={e => keyboardContext(e, { kind: 'project', id: p.id })}>
          <Folder /><button disabled={busy} title={p.path} onClick={() => { const t = threads.find(t => t.projectId === p.id && !t.archivedAt); if (t) onOpen(t.id); else void onAction('thread.new', { projectId: p.id }); }}>{p.name}</button>
          <IconButton title={`${p.name} 项目菜单`} onClick={() => { const box = document.querySelector(`[data-project-id="${p.id}"]`)!.getBoundingClientRect(); setMenu({ kind: 'project', id: p.id, x: box.right - 10, y: box.top + 25 }); }}><Ellipsis /></IconButton>
          <IconButton title={`在 ${p.name} 新建会话`} disabled={busy} onClick={() => void onAction('thread.new', { projectId: p.id })}><Plus /></IconButton>
        </div>
        {threads.filter(t => t.projectId === p.id && !t.archivedAt).map(t => <div className={`threadrow ${dragging === t.id ? 'dragging' : ''}`} key={t.id} data-thread-id={t.id}
          onContextMenu={e => context(e, { kind: 'thread', id: t.id })} onKeyDown={e => keyboardContext(e, { kind: 'thread', id: t.id })}>
          <button className={`thread ${activeId === t.id ? 'active' : ''}`} title={t.title} disabled={busy} onClick={() => onOpen(t.id)} draggable={!busy}
            onDragStart={e => { e.dataTransfer.setData(threadMime, t.id); e.dataTransfer.effectAllowed = 'move'; setDragging(t.id); setMenu(null); }} onDragEnd={() => { setDropTarget(undefined); setDragging(undefined); }}><span>{t.title}</span>{activeId === t.id && running && <i />}</button>
          <button className="threadmore iconbutton" aria-label={`${t.title} 会话菜单`} onClick={e => context(e, { kind: 'thread', id: t.id })}><Ellipsis /></button>
        </div>)}
        {dropTarget === p.id && <div className="drophint">松开以迁移至 {p.name}</div>}
      </div>)}
      {!projects.length && <p className="sidebarhint">打开一个文件夹，开始你的项目。</p>}
    </div>
    <button className="archiveentry" onClick={() => setArchives(true)}><Archive />已归档<span>{archivedProjects.length + threads.filter(t => t.archivedAt).length || ''}</span></button>
    {menu && createPortal(<div className="contextmenu glass" role="menu" aria-label={menu.kind === 'project' ? '项目菜单' : '会话菜单'} ref={menuRef} style={{ left: menu.x, top: menu.y }} onContextMenu={e => e.preventDefault()} onKeyDown={e => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return; e.preventDefault();
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      <div className="menutitle">{name(menu)}</div>
      {menu.kind === 'project' ? <>
        <button role="menuitem" disabled={busy} onClick={() => { setMenu(null); void onAction('thread.new', { projectId: menu.id }); }}><Plus />新建会话</button>
        <button role="menuitem" onClick={() => void action('project.reveal', menu)}><FolderOpen />在文件夹中打开</button>
        <button role="menuitem" onClick={() => void action('project.copyPath', menu, '项目路径已复制')}><Copy />复制项目路径</button>
      </> : <>
        <button role="menuitem" disabled={busy} onClick={() => { setMenu(null); onOpen(menu.id); }}><FolderOpen />打开会话</button>
        <button role="menuitem" disabled={busy || projects.length < 2} onClick={() => { setMoving(menu.id); setMenu(null); }}><ArrowRightLeft />迁移到项目…</button>
        <button role="menuitem" onClick={() => void action('thread.copyLink', menu, '会话链接已复制，可在本机 Saint Harness 中打开')}><Link />复制会话链接</button>
      </>}
      <button role="menuitem" onClick={() => showDetails(menu)}><Info />详情与重命名</button><hr />
      <button role="menuitem" disabled={busy} onClick={() => void action(`${menu.kind}.archive`, menu, '已归档，可在侧栏「已归档」中恢复')}><Archive />{menu.kind === 'project' ? '归档项目' : '归档会话'}</button>
    </div>, document.body)}
    {detail && createPortal(<Modal title={detail.kind === 'project' ? '项目详情' : '会话详情'} subtitle="名称、位置与工作记录。" onClose={() => setDetail(null)}>
      <label className="formrow">{detail.kind === 'project' ? '项目名称' : '会话名称'}<input value={title} maxLength={100} onChange={e => setTitle(e.target.value)} /></label>
      <dl className="workspacedetails"><dt>项目位置</dt><dd>{detailProject?.path}</dd>{detailThread && <><dt>创建时间</dt><dd>{new Date(detailThread.createdAt).toLocaleString()}</dd><dt>最近更新</dt><dd>{new Date(detailThread.updatedAt).toLocaleString()}</dd></>}<dt>{detail.kind === 'project' ? '项目 ID' : '会话 ID'}</dt><dd>{detail.id}</dd></dl>
      <div className="modalactions"><button className="outlinebutton" onClick={() => setDetail(null)}>关闭</button><button className="primarybutton" disabled={busy || !title.trim()} onClick={async () => { if (await onAction(`${detail.kind}.rename`, { id: detail.id, title }, '名称已更新')) setDetail(null); }}>保存名称</button></div>
    </Modal>, document.body)}
    {moving && createPortal(<Modal title="迁移会话" subtitle="保留完整对话历史，后续任务使用目标项目目录。项目文件不会移动。" onClose={() => setMoving(undefined)}>
      <div className="workspacechoices">{projects.filter(p => p.id !== threads.find(t => t.id === moving)?.projectId).map(p => <button key={p.id} disabled={busy} onClick={() => void move(moving, p.id)}><Folder /><span><strong>{p.name}</strong><small>{p.path}</small></span><ArrowRightLeft /></button>)}</div>
    </Modal>, document.body)}
    {archives && !deletion && createPortal(<Modal title="已归档" subtitle="恢复归档内容，或永久删除不再需要的记录。" onClose={() => setArchives(false)}>
      <div className="archivelist">{archivedProjects.map(p => <div key={p.id} data-archived-project={p.id}><Folder /><span><strong>{p.name}</strong><small>项目 · {p.path}</small></span><div className="archiveactions"><button className="outlinebutton" disabled={busy} onClick={() => void onAction('project.restore', { id: p.id }, '项目已恢复')}><RotateCcw />恢复项目</button><button className="archive-delete" aria-label={`永久删除项目 ${p.name}`} disabled={busy} onClick={() => setDeletion({ kind: 'project', id: p.id })}><Trash2 />永久删除</button></div></div>)}
      {archivedThreads.map(t => <div key={t.id} data-archived-thread={t.id}><Archive /><span><strong>{t.title}</strong><small>会话 · {data?.projects.find(p => p.id === t.projectId)?.name}</small></span><div className="archiveactions"><button className="outlinebutton" disabled={busy} onClick={() => void onAction('thread.restore', { id: t.id }, '会话已恢复，所属项目已显示')}><RotateCcw />恢复会话</button><button className="archive-delete" aria-label={`永久删除会话 ${t.title}`} disabled={busy} onClick={() => setDeletion({ kind: 'thread', id: t.id })}><Trash2 />永久删除</button></div></div>)}
      {!archivedProjects.length && !archivedThreads.length && <p className="emptypop">还没有归档内容。</p>}</div>
    </Modal>, document.body)}
    {deletion && createPortal(<Modal title={deletion.kind === 'project' ? '永久删除项目？' : '永久删除会话？'} subtitle="此操作无法撤销，删除后不能从归档中恢复。" onClose={() => { if (!busy) setDeletion(null); }}>
      <div className="deletion-target"><Trash2 /><div><strong>{name(deletion)}</strong><small>{deletion.kind === 'project' ? `此项目及其当前所属的 ${deletionCount} 条会话` : '此会话的本地历史记录'}</small></div></div>
      <div className="deletion-scope"><p>将删除会话记录及仅供这些会话使用的关联附件副本，原会话链接将失效。</p><p>{deletion.kind === 'project' ? '磁盘上的项目文件夹会保留，已迁移到其他项目的会话也会保留。' : '其他会话、原始附件和磁盘项目文件会保留。'}</p>{deletionProject && <code>{deletionProject.path}</code>}</div>
      <div className="access-warning"><AlertTriangle /><p>删除的记录不会进入回收站。已导出或独立备份的内容不在此次删除范围内。</p></div>
      <div className="modalactions deletion-actions"><button className="outlinebutton" disabled={busy} onClick={() => setDeletion(null)}>取消</button><button className="dangerbutton" disabled={busy} onClick={async () => { if (await onAction(`${deletion.kind}.delete`, { id: deletion.id, confirmed: true }, deletion.kind === 'project' ? '项目及其会话已永久删除，磁盘文件夹已保留' : '会话已永久删除')) setDeletion(null); }}>{busy ? <Loader2 className="spin" /> : <Trash2 />}{busy ? '正在删除…' : deletion.kind === 'project' ? '永久删除项目' : '永久删除会话'}</button></div>
    </Modal>, document.body)}
  </>;
}
