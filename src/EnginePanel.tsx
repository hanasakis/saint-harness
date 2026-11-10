import { Download, FolderOpen, PlugZap, RefreshCw, Loader2, RotateCcw, FileCode2 } from 'lucide-react';
import type { RuntimeInfo, Snapshot, Settings } from '../shared/types';
import { Modal } from './components';

interface Props {
  engine?: RuntimeInfo;
  snapshot: Snapshot;
  settings?: Settings;
  busy: boolean;
  onClose: () => void;
  onAction: (label: string, action: string, payload?: unknown) => void;
}

export function EnginePanel({engine, snapshot, settings, busy, onClose, onAction}: Props) {
  const pending = busy || !!engine?.updating;
  const connected = snapshot.connected && engine?.installed;
  const status = engine?.updating ? '正在处理' : connected ? '已连接' : engine?.installed ? '已安装 · 待连接' : '未连接';
  return <Modal title="Pi 引擎，与上游同行。" subtitle="下载、连接与更新，在这里完成。" onClose={onClose}>
    <div className="enginebig"><span className="pi">π</span><div><strong>Pi Engine</strong><small>{engine?.installed ? `${engine.external?'本地引擎':'稳定版'} ${engine.current}` : '当前未找到可运行的 Pi'}</small></div><span className="statuspill">{status}</span></div>
    <section className="engine-setup" aria-label="安装与连接 Pi">
      <div className="engine-setup-heading"><strong>{connected?'后端已就绪':engine?.installed?'已找到 Pi，点击即可连接':engine?.candidates.length?'发现其他 Pi 安装，可选择连接':'还没有安装 Pi？'}</strong><button className="textbutton" disabled={pending} onClick={()=>onAction('检测引擎','engine.detect')}><RefreshCw size={13}/>重新检测</button></div>
      <p>{connected?'选择工作空间和模型后，就可以开始任务。':engine?.installed?'无需先打开项目，连接后端后再选择工作空间。':'可以下载稳定版，也可以连接电脑上已安装的 Pi。'}</p>
      {engine?.installed&&!connected&&<button className="primarybutton engine-connect" disabled={pending} onClick={()=>onAction('连接 Pi','engine.connect')}><PlugZap/>连接当前 Pi 引擎</button>}
      <div className="engine-install-actions">{!engine?.installed&&<button className={engine?.installed?'outlinebutton':'primarybutton'} disabled={pending} onClick={()=>onAction('下载并连接 Pi','engine.install')}><Download/>下载并连接 Pi</button>}<button className="outlinebutton" disabled={pending} onClick={()=>onAction('选择本地 Pi','engine.chooseFolder')}><FolderOpen/>连接已下载的 Pi</button></div>
      <small>{engine?.installed?(engine.external?'已连接你选择的本地引擎，请通过原安装方式更新。':'优先使用应用内置引擎，更新后安装位置不变。'):'下载时选择保存位置；已有安装可直接连接。'}</small>
      {!!engine?.candidates.length&&<details className="engine-detected"><summary>检测到 {engine.candidates.length} 个 Pi 入口</summary>{engine.candidates.map(candidate=><div className="engine-candidate" key={candidate.cli}><div><strong>{candidate.source} · {candidate.version}</strong><code title={candidate.cli}>{candidate.cli}</code></div><button className="outlinebutton" disabled={pending} onClick={()=>onAction('连接 Pi','engine.connect',{path:candidate.cli})}>连接</button></div>)}</details>}
      {snapshot.error&&!connected&&<div className="inlineerror">{snapshot.error}</div>}
    </section>
    <details className="engine-guide">
      <summary>如何连接本地已下载的 Pi</summary>
      <ol><li>点击“连接已下载的 Pi”，选择安装文件夹（通常包含 <code>node_modules</code>），也可直接选择 <code>pi-coding-agent</code> 包目录。</li><li>使用 npm 全局安装时，在终端执行 <code>npm root -g</code>，将输出的文件夹复制到选择窗口，再进入 <code>@earendil-works/pi-coding-agent</code>。旧包名为 <code>@mariozechner/pi-coding-agent</code>，版本需支持当前连接协议。</li><li>只有入口文件时，使用下面的“选择入口文件”，选择 <code>cli.js</code>、<code>pi.exe</code> 或 npm 的 <code>pi.cmd</code>。不要选择 ZIP 压缩包；源码需要先构建。</li><li>看到“已连接”后，选择工作空间，再配置模型 API。Saint 会自动启动本地后端，无需另开命令行服务。</li></ol>
      <button className="outlinebutton" disabled={pending} onClick={()=>onAction('选择 Pi 入口','engine.add')}><FileCode2/>选择入口文件</button>
      <p>只连接你信任的本地程序。常见目录之外的安装，请手动选择。</p>
    </details>
    <div className="formrow"><div>自动检查更新<small>发现 Pi 新版本时在侧栏提示</small></div><button role="switch" aria-label="自动检查更新" aria-checked={settings?.autoCheck||false} disabled={pending} className={`toggle ${settings?.autoCheck?'on':''}`} onClick={()=>onAction('保存设置','settings.save',{autoCheck:!settings?.autoCheck})}/></div>
    <div className="formrow"><div>空闲时自动更新<small>在原目录更新，验证后生效，保留一份恢复备份</small></div><button role="switch" aria-label="空闲时自动更新" aria-checked={settings?.autoUpdate||false} className={`toggle ${settings?.autoUpdate?'on':''}`} disabled={pending||engine?.external||!engine?.installed} onClick={()=>onAction('保存设置','settings.save',{autoUpdate:!settings?.autoUpdate})}/></div>
    <div className="formrow"><span>更新通道</span><span className="pill">Stable · 稳定版</span></div>
    {engine?.latest&&<div className="formrow"><span>上游版本</span><strong>{engine.latest}</strong></div>}
    <div className="engineprogress" role="status">{engine?.updating?<Loader2 className="spin"/>:<RefreshCw/>}<span>{engine?.message||'已检测当前安装位置，连接后会验证引擎与权限扩展。'}</span></div>
    <div className="enginepath" title={engine?.path}>{engine?.path}</div>
    <div className="modalactions engine-maintenance">{engine?.external?<button className="outlinebutton" disabled={pending} onClick={()=>onAction('切回内置引擎','engine.builtin')}>使用内置</button>:engine?.previous&&engine.previous!=='未安装'&&<button className="outlinebutton" disabled={pending} onClick={()=>onAction('恢复版本','engine.rollback')}><RotateCcw/>恢复 {engine.previous}</button>}{connected&&<button className="textbutton" disabled={pending} onClick={()=>onAction('重新连接 Pi','engine.connect')}>重新连接</button>}<button className="outlinebutton" disabled={pending} onClick={()=>onAction(engine?.updateAvailable?'更新引擎':'检查更新',engine?.updateAvailable?'engine.update':'engine.check')}><RefreshCw/>{engine?.updateAvailable?'更新 Pi':'检查更新'}</button></div>
  </Modal>;
}
