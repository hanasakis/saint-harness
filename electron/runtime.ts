import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import semver from 'semver';
import type { RuntimeInfo } from '../shared/types';
import { Store } from './store';
import { PiRpc } from './rpc';
const PACKAGE = '@earendil-works/pi-coding-agent';
export class RuntimeManager {
  private latest?: string;
  private updating = false;
  private message?: string;
  private activeInstall?: ReturnType<typeof spawn>;
  constructor(readonly bundled: string, private node: string, private extension: string, private store: Store, private notify: (info: RuntimeInfo) => void) {}
  get root() { return this.store.data.runtimePath || this.bundled; }
  packageFile(root = this.root) { return path.join(root, 'node_modules', PACKAGE, 'package.json'); }
  version(root = this.root) { try { return JSON.parse(fs.readFileSync(this.packageFile(root), 'utf8')).version as string; } catch { return '未安装'; } }
  cli(root = this.root) { const pkg = JSON.parse(fs.readFileSync(this.packageFile(root), 'utf8')); return path.join(root, 'node_modules', PACKAGE, pkg.bin.pi); }
  launch() { const external = this.store.data.externalCli; const cli = external || this.cli(); return /\.(?:[cm]?js)$/i.test(cli) ? { executable: this.node, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } } : { executable: cli, args: [], env: {} }; }
  info(): RuntimeInfo { return { current: this.store.data.externalCli ? '外部引擎' : this.version(), latest: this.latest, previous: this.store.data.previousRuntime ? this.version(this.store.data.previousRuntime) : undefined, updating: this.updating, message: this.message, external: !!this.store.data.externalCli, path: this.store.data.externalCli || this.root, updateAvailable: !!this.latest && !!semver.valid(this.version()) && semver.gt(this.latest, this.version()) }; }
  private report(message: string) { this.message = message; this.notify(this.info()); }
  async check() {
    const response = await fetch('https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest', { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`无法检查 Pi 更新 (${response.status})`);
    const json = await response.json() as { version: string }; if (!semver.valid(json.version)) throw new Error('上游返回的版本号无效');
    this.latest = json.version; this.report(this.info().updateAvailable ? `Pi ${this.latest} 可用` : '已是当前稳定版'); return this.info();
  }
  private async verify(root: string) {
    const cwd = path.join(this.store.directory, 'runtime-check'); fs.mkdirSync(cwd, { recursive: true });
    const rpc = new PiRpc(this.node, [this.cli(root), '--mode','rpc','--no-session','--no-approve','-e',this.extension], cwd, { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: this.store.agentDir, SAINT_ACCESS_MODE: 'ask' });
    try { await rpc.start(); const results = await Promise.all([rpc.request('get_available_models'), rpc.request('get_commands'), rpc.request('get_session_stats')]); if (!results[1].commands?.some((c: { name: string }) => c.name === 'saint-access')) throw new Error('权限扩展未能加载'); }
    finally { await rpc.close(); }
  }
  async update(isBusy: () => boolean, reconnect: () => Promise<void>) {
    if (this.updating) throw new Error('已有更新正在进行'); if (this.store.data.externalCli) throw new Error('外部 Pi 请通过原安装方式更新，或切回内置引擎');
    if (isBusy()) throw new Error('请等待当前任务结束后再更新');
    this.updating = true; this.report('正在检查上游版本…');
    try {
      await this.check(); if (!this.info().updateAvailable) return this.info();
      const version = this.latest!; const stage = path.join(this.store.directory, 'runtimes', `${version}-${Date.now()}`); fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ private: true, dependencies: { [PACKAGE]: version } }));
      this.report(`正在下载 Pi ${version}…`);
      const npmCli = path.join(this.bundled, 'node_modules/npm/bin/npm-cli.js');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.node, [npmCli,'install','--omit=dev','--no-fund','--no-audit','--registry=https://registry.npmjs.org'], { cwd: stage, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore','pipe','pipe'] }); this.activeInstall = child;
        let logs = ''; const collect = (chunk: Buffer) => { logs = (logs + chunk).slice(-6000); };
        child.stdout?.on('data', collect); child.stderr?.on('data', collect); child.on('error', reject); child.on('exit', code => { this.activeInstall = undefined; fs.writeFileSync(path.join(stage,'install.log'), logs); if (code === 0) resolve(); else reject(new Error(`Pi 下载失败 (${code})，安装记录已保留。\n${logs.slice(-1000)}`)); });
      });
      this.report('正在启动新引擎并验证连接…'); await this.verify(stage);
      if (isBusy()) throw new Error('当前有任务运行，已保留新版本，尚未切换');
      const old = this.root; const previous = this.store.data.previousRuntime;
      this.store.data.runtimePath = stage; this.store.data.previousRuntime = old; this.store.save();
      try { await reconnect(); } catch (error) { this.store.data.runtimePath = old; this.store.data.previousRuntime = previous; this.store.save(); await reconnect().catch(() => {}); throw new Error(`新版本连接失败，已恢复原版本：${(error as Error).message}`); }
      this.report(`已更新至 Pi ${version}，上一版本可恢复`);
    } catch (error) { this.report((error as Error).message); throw error; }
    finally { this.updating = false; this.notify(this.info()); }
    return this.info();
  }
  async rollback(isBusy: () => boolean, reconnect: () => Promise<void>) {
    if (isBusy() || this.updating) throw new Error('请在空闲时恢复版本'); const target = this.store.data.previousRuntime; if (!target) throw new Error('没有可恢复的旧版本');
    this.updating = true; this.report('正在验证并恢复上一版本…');
    const external = this.store.data.externalCli;
    try {
    await this.verify(target); const old = this.root; this.store.data.runtimePath = target; this.store.data.previousRuntime = old; this.store.data.externalCli = undefined; this.store.save();
    try { await reconnect(); } catch (e) { this.store.data.runtimePath = old; this.store.data.previousRuntime = target; this.store.data.externalCli = external; this.store.save(); await reconnect().catch(() => {}); throw e; }
    this.report(`已恢复 Pi ${this.version()}`); return this.info();
    } catch (error) { this.report((error as Error).message); throw error; }
    finally { this.updating = false; this.notify(this.info()); }
  }
  shutdown() { if (this.activeInstall?.pid) { if (process.platform === 'win32') spawn('taskkill.exe',['/pid',String(this.activeInstall.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'}); else this.activeInstall.kill(); } }
}
