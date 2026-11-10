import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import semver from 'semver';
import type { RuntimeInfo, EngineCandidate } from '../shared/types';
import { Store } from './store';
import { PiRpc } from './rpc';
import { discoverEngines, localSearchPaths, resolveEngine } from './engine-location';
const PACKAGE = '@earendil-works/pi-coding-agent';
export class RuntimeManager {
  private latest?: string;
  private updating = false;
  private message?: string;
  private candidates: EngineCandidate[] = [];
  private activeInstall?: ReturnType<typeof spawn>;
  constructor(readonly bundled: string, private node: string, private extension: string, private store: Store, private notify: (info: RuntimeInfo) => void) { this.scan(); }
  get root() { return this.store.data.runtimePath || this.bundled; }
  packageFile(root = this.root) { return path.join(root, 'node_modules', PACKAGE, 'package.json'); }
  version(root = this.root) { try { return resolveEngine(root).version; } catch { return '未安装'; } }
  cli(root = this.root) { return resolveEngine(root).cli; }
  launch(cli = this.store.data.externalCli || this.cli()) { return /\.(?:[cm]?js)$/i.test(cli) ? { executable: this.node, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } } : { executable: cli, args: [], env: {} }; }
  private selected() { try { return resolveEngine(this.store.data.externalCli || this.root); } catch { return undefined; } }
  info(): RuntimeInfo {
    const selected = this.selected();
    const current = this.store.data.externalCli ? selected?.version || '未安装' : this.version();
    return { current, installed: !!selected, candidates: this.candidates, latest: this.latest, previous: this.store.data.previousRuntime ? this.version(this.store.data.previousRuntime) : undefined, updating: this.updating, message: this.message, external: !!this.store.data.externalCli, path: this.store.data.externalCli || this.root, updateAvailable: !this.store.data.externalCli && !!selected && !!this.latest && !!semver.valid(current) && semver.gt(this.latest, current) };
  }
  private scan() {
    this.candidates = discoverEngines([
      ...(this.store.data.externalCli ? [{path:this.store.data.externalCli,source:'已选择的本地引擎'}] : []),
      {path:this.root,source:'当前引擎',managedRoot:this.root},
      {path:this.bundled,source:'应用内置',managedRoot:this.bundled},
      ...(this.store.data.previousRuntime ? [{path:this.store.data.previousRuntime,source:'上一版本',managedRoot:this.store.data.previousRuntime}] : []),
      ...localSearchPaths().map(p=>({path:p,source:'系统安装'})),
    ]);
  }
  detect() { this.scan(); this.report(this.candidates.length ? `检测到 ${this.candidates.length} 个可用入口，连接后将验证引擎。` : '未检测到 Pi。可以下载，或手动选择已安装的位置。'); return this.info(); }
  private report(message: string) { this.message = message; this.notify(this.info()); }
  async check() {
    const response = await fetch('https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest', { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`无法检查 Pi 更新 (${response.status})`);
    const json = await response.json() as { version: string }; if (!semver.valid(json.version)) throw new Error('上游返回的版本号无效');
    this.latest = json.version;
    this.report(!this.info().installed ? `可下载 Pi ${this.latest}` : this.store.data.externalCli ? `上游稳定版 Pi ${this.latest}；本地引擎请通过原安装方式更新。` : this.info().updateAvailable ? `Pi ${this.latest} 可用` : '已是当前稳定版'); return this.info();
  }
  private async verify(candidate: EngineCandidate) {
    const cwd = path.join(this.store.directory, 'runtime-check'); fs.mkdirSync(cwd, { recursive: true });
    const launch = this.launch(candidate.cli);
    const rpc = new PiRpc(launch.executable, [...launch.args, '--mode','rpc','--no-session','--no-approve','-e',this.extension], cwd, { ...process.env, ...launch.env, PI_CODING_AGENT_DIR: this.store.agentDir, SAINT_ACCESS_MODE: 'ask' });
    try {
      await rpc.start();
      const results = await Promise.all([rpc.request('get_available_models'), rpc.request('get_commands'), rpc.request('get_session_stats'), rpc.request('get_available_thinking_levels'), rpc.request('get_messages')]);
      if (!results[1].commands?.some((c: { name: string }) => c.name === 'saint-access')) throw new Error('权限扩展未能加载');
    } finally { await rpc.close(); }
  }
  private async operation(isBusy: () => boolean, work: () => Promise<void>) {
    if (this.updating || isBusy()) throw new Error('请等待当前任务或引擎操作结束');
    this.updating = true; this.notify(this.info());
    try { await work(); }
    catch (error) { this.report((error as Error).message); throw error; }
    finally { this.updating = false; this.scan(); this.notify(this.info()); }
    return this.info();
  }
  private async activate(candidate: EngineCandidate, reconnect: () => Promise<void>, installDirectory?: string) {
    const old = {runtimePath:this.store.data.runtimePath,externalCli:this.store.data.externalCli,previousRuntime:this.store.data.previousRuntime,runtimeInstallDirectory:this.store.data.runtimeInstallDirectory};
    const oldRoot = this.root;
    this.store.data.externalCli = candidate.managedRoot ? undefined : candidate.cli;
    if (candidate.managedRoot) {
      this.store.data.runtimePath = candidate.managedRoot;
      if (oldRoot !== candidate.managedRoot && this.version(oldRoot) !== '未安装') this.store.data.previousRuntime = oldRoot;
    }
    if (installDirectory) this.store.data.runtimeInstallDirectory = installDirectory;
    this.store.save();
    try { await reconnect(); }
    catch (error) { Object.assign(this.store.data, old); this.store.save(); if (this.selected()) await reconnect().catch(() => {}); throw new Error(`连接失败，已恢复原引擎设置：${(error as Error).message}`); }
  }
  async connectExisting(input: string, isBusy: () => boolean, reconnect: () => Promise<void>, managedRoot?: string) {
    return this.operation(isBusy, async () => {
      this.report('正在验证并连接 Pi…');
      const resolved = resolveEngine(input);
      const known = this.candidates.find(c=>c.cli.toLowerCase()===resolved.cli.toLowerCase());
      const candidate = {...resolved, managedRoot: managedRoot || known?.managedRoot};
      await this.verify(candidate);
      await this.activate(candidate, reconnect);
      this.report('Pi 已连接，可以选择工作空间开始任务。');
    });
  }
  private npmCli() {
    const candidates = [this.bundled, path.dirname(this.node), ...localSearchPaths()].map(p=>path.join(p,'node_modules/npm/bin/npm-cli.js'));
    const cli = candidates.find(p=>fs.existsSync(p));
    if (!cli) throw new Error('未找到下载组件。请使用完整桌面包，或安装 Node.js 24+ 后重试；也可以连接已下载的 Pi。');
    return cli;
  }
  private async download(destination: string) {
    const npmCli = this.npmCli(); await this.check(); const version = this.latest!;
    fs.mkdirSync(destination, {recursive:true});
    const stage = fs.mkdtempSync(path.join(destination, `Saint-Pi-${version}-`));
    fs.writeFileSync(path.join(stage,'package.json'), JSON.stringify({private:true,dependencies:{[PACKAGE]:version}}));
    this.report(`正在下载 Pi ${version}… 保存位置：${stage}`);
    await new Promise<void>((resolve,reject) => {
      const child = spawn(this.node, [npmCli,'install','--omit=dev','--no-fund','--no-audit','--registry=https://registry.npmjs.org'], {cwd:stage,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
      this.activeInstall = child; let logs = '';
      const collect = (chunk:Buffer) => { logs = (logs + chunk).slice(-6000); };
      child.stdout?.on('data',collect); child.stderr?.on('data',collect);
      child.on('error', error=>{this.activeInstall=undefined;reject(error);});
      child.on('exit',code=>{this.activeInstall=undefined;fs.writeFileSync(path.join(stage,'install.log'),logs);code===0?resolve():reject(new Error(`Pi 下载失败 (${code})，当前引擎未更改。安装记录保留在 ${path.join(stage,'install.log')}`));});
    });
    const candidate = {...resolveEngine(stage),managedRoot:stage};
    this.report('下载完成，正在验证引擎与权限扩展…'); await this.verify(candidate); return candidate;
  }
  async install(destination: string, isBusy: () => boolean, reconnect: () => Promise<void>) {
    return this.operation(isBusy, async()=>{
      const candidate = await this.download(destination); await this.activate(candidate,reconnect,destination);
      this.report(`Pi ${candidate.version} 已下载并连接。`);
    });
  }
  async update(isBusy: () => boolean, reconnect: () => Promise<void>) {
    return this.operation(isBusy, async()=>{
      if (this.store.data.externalCli) throw new Error('外部 Pi 请通过原安装方式更新，或下载由 Saint 管理的版本。');
      await this.check(); if (!this.info().updateAvailable) return;
      const destination = this.store.data.runtimeInstallDirectory || path.join(this.store.directory,'runtimes');
      const candidate = await this.download(destination); await this.activate(candidate,reconnect);
      this.report(`已更新至 Pi ${candidate.version}，上一版本可恢复。`);
    });
  }
  async rollback(isBusy: () => boolean, reconnect: () => Promise<void>) {
    return this.operation(isBusy,async()=>{
      const target = this.store.data.previousRuntime; if (!target) throw new Error('没有可恢复的旧版本');
      this.report('正在验证并恢复上一版本…');
      const candidate = {...resolveEngine(target),managedRoot:target}; await this.verify(candidate);
      await this.activate(candidate,reconnect); this.report(`已恢复 Pi ${candidate.version}`);
    });
  }
  shutdown() { if (this.activeInstall?.pid) { if (process.platform === 'win32') spawn('taskkill.exe',['/pid',String(this.activeInstall.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'}); else this.activeInstall.kill(); } }
}
