import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PiEvent } from '../shared/types';

export class JsonLines {
  private buffer = '';
  constructor(private record: (record: PiEvent) => void) {}
  feed(chunk: string) {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      if (line.trim()) this.record(JSON.parse(line));
    }
    if (this.buffer.length > 32 * 1024 * 1024) throw new Error('Pi 返回了过大的协议记录');
  }
}

export class PiRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  busy = false;
  alive = false;
  closing = false;
  diagnostics = '';
  constructor(private executable: string, private args: string[], private cwd: string, private env: NodeJS.ProcessEnv) { super(); }
  async start() {
    this.child = spawn(this.executable, this.args, { cwd: this.cwd, env: this.env, windowsHide: true, stdio: 'pipe', shell: false });
    this.alive = true;
    const parser = new JsonLines(record => this.receive(record));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (text: string) => { try { parser.feed(text); } catch (e) { this.fail(new Error(`Pi 协议解析失败：${(e as Error).message}`)); this.kill(); } });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.diagnostics = (this.diagnostics + text).slice(-6000); this.emit('diagnostic', String(text)); });
    this.child.on('error', e => { this.alive = false; this.fail(e); });
    this.child.on('exit', (code, signal) => { this.alive = false; this.busy = false; const error = new Error(`Pi 进程已退出 (${code ?? signal ?? 'unknown'})${this.diagnostics ? '\n' + this.diagnostics.slice(-1800) : ''}`); this.fail(error); if (!this.closing) this.emit('closed', error); });
    return this.request('get_state', {}, 30_000);
  }
  private receive(record: PiEvent) {
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(record.id); if (record.success) pending.resolve(record.data); else pending.reject(new Error(record.error || `Pi 拒绝了 ${record.command}`)); }
      return;
    }
    if (record.type === 'agent_start') this.busy = true;
    if (record.type === 'agent_settled') this.busy = false;
    this.emit('record', record);
  }
  request<T = any>(type: string, data: Record<string, unknown> = {}, timeout = 30_000): Promise<T> {
    if (!this.child || !this.alive) return Promise.reject(new Error('Pi 引擎尚未连接'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi 操作超时：${type}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ ...data, type, id }) + '\n', e => { if (e) { clearTimeout(timer); this.pending.delete(id); reject(e); } });
    });
  }
  respond(response: Record<string, unknown>) { this.child?.stdin.write(JSON.stringify({ ...response, type: 'extension_ui_response' }) + '\n'); }
  private fail(error: Error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  async stop() { const queue = await this.request('clear_queue'); await this.request('abort'); return queue; }
  async close() {
    if (!this.alive) return;
    this.closing = true;
    if (this.busy) await this.stop().catch(() => {});
    const child = this.child!;
    await new Promise<void>(resolve => { const timer = setTimeout(() => { this.kill(); resolve(); }, 1800); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end(); });
  }
  kill() { this.closing = true; if (this.child?.pid && this.alive) { if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); else this.child.kill('SIGKILL'); } }
}
