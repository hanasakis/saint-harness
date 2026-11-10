import { AlertTriangle, Folder, Terminal, Globe, ShieldCheck } from 'lucide-react';
import { Modal } from './components';

export function AccessConfirmation({ onAnswer }: { onAnswer: (confirmed: boolean) => void }) {
  return <Modal title="允许完全访问？" subtitle="让 Pi 连续执行任务，工具调用将不再逐次询问。" onClose={() => onAnswer(false)}>
    <div className="access-summary"><span className="access-symbol"><ShieldCheck /></span><div><strong>完全访问</strong><small>使用当前 Windows 账户的权限</small></div><span className="access-badge">需明确确认</span></div>
    <div className="access-capabilities"><div><Folder /><span><strong>文件与目录</strong><small>读取、创建和修改当前账户可访问的本地文件。</small></span></div><div><Terminal /><span><strong>终端与程序</strong><small>执行命令、运行程序与安装依赖。</small></span></div><div><Globe /><span><strong>网络访问</strong><small>访问网络服务，发送任务涉及的数据。</small></span></div></div>
    <div className="access-warning"><AlertTriangle /><p>此模式不是系统沙箱，操作范围不限于当前项目。只在信任任务内容时启用。</p></div>
    <p className="access-help">你可以随时停止任务，结束后切回「自动审批」或「每次询问」。</p>
    <div className="modalactions access-actions"><button className="outlinebutton" onClick={() => onAnswer(false)}>保持当前权限</button><button className="primarybutton" onClick={() => onAnswer(true)}><ShieldCheck />启用完全访问</button></div>
  </Modal>;
}
