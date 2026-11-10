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
  constructor(readonly bundled: string, private node: string, private extension: string, private store: Store, private notify: (info: RuntimeInfo) => void, private disconnect: () => Promise<void> = async () => {}) {
    // Prefer the copy shipped with Saint, while keeping explicit external choices.
    if (!store.data.externalCli && this.version(bundled) !== '未安装' && store.data.runtimePath && store.data.runtimePath !== bundled) {
      store.data.runtimePath = bundled; store.data.previousRuntime = fs.existsSync(bundled + '.previous') ? bundled + '.previous' : undefined; store.save();
    }
    this.scan();
  }
  get root() { return this.store.data.runtimePath || this.bundled; }
  packageFile(root = this.root) { return path.join(root, 'node_modules', PACKAGE, 'package.json'); }
  version(root = this.root) { try { return resolveEngine(root).version; } catch { return '未安装'; } }
  cli(root = this.root) { return resolveEngine(root).cli; }
  launch(cli = this.store.data.externalCli || this.cli()) { return /\.(?:[cm]?js)$/i.test(cli) ? { executable: this.node, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } } : { executable: cli, args: [], env: {} }; }
  private selected() { try { return resolveEngine(this.store.data.externalCli || this.root); } catch { return undefined; } }
  info(): RuntimeInfo {
    const selected = this.selected();
    const current = this.store.data.externalCli ? selected?.version || '未安装' : this.version();
    return { current, installed: !!selected, candidates: this.candidates, latest: this.latest, previous: !this.store.data.externalCli && this.store.data.previousRuntime === this.root + '.previous' ? this.version(this.store.data.previousRuntime) : undefined, updating: this.updating, message: this.message, external: !!this.store.data.externalCli, path: this.store.data.externalCli || this.root, updateAvailable: !this.store.data.externalCli && !!selected && !!this.latest && !!semver.valid(current) && semver.gt(this.latest, current) };
  }
  private scan() {
    this.candidates = discoverEngines([
      ...(this.store.data.externalCli ? [{path:this.store.data.externalCli,source:'已选择的本地引擎'}] : []),
      {path:this.root,source:this.root===this.bundled?'应用内置 · 当前引擎':'当前引擎',managedRoot:this.root},
      {path:this.bundled,source:'应用内置',managedRoot:this.bundled},
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
    this.store.data.externalCli = candidate.managedRoot ? undefined : candidate.cli;
    if (candidate.managedRoot) {
      this.store.data.runtimePath = candidate.managedRoot;
      this.store.data.previousRuntime = fs.existsSync(candidate.managedRoot + '.previous') ? candidate.managedRoot + '.previous' : undefined;
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
  private removeManagedDirectory(directory: string, parent: string, prefix: string) {
    const resolved = path.resolve(directory), base = path.resolve(parent);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith(prefix) || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('无法清理不属于此次更新的目录');
    fs.rmSync(resolved, {recursive:true,force:true});
  }
  private async download(target: string) {
    const npmCli = this.npmCli(); if (!this.latest) await this.check(); const version = this.latest!;
    const parent = path.dirname(target); fs.mkdirSync(parent,{recursive:true});
    const prefix = `.${path.basename(target)}.update-`, stage = fs.mkdtempSync(path.join(parent,prefix));
    const manifest = fs.existsSync(path.join(target,'package.json')) ? JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8')) : {private:true};
    fs.writeFileSync(path.join(stage,'package.json'), JSON.stringify({...manifest,private:true,dependencies:{...manifest.dependencies,[PACKAGE]:version}}));
    this.report(`正在准备 Pi ${version}，完成后更新原目录：${target}`);
    try {
      await new Promise<void>((resolve,reject) => {
        const child = spawn(this.node,[npmCli,'install','--omit=dev','--no-fund','--no-audit','--registry=https://registry.npmjs.org'],{cwd:stage,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
        this.activeInstall=child; let logs='';
        const collect=(chunk:Buffer)=>{logs=(logs+chunk).slice(-6000);};child.stdout?.on('data',collect);child.stderr?.on('data',collect);
        child.on('error',error=>{this.activeInstall=undefined;reject(error);});
        child.on('exit',code=>{this.activeInstall=undefined;fs.writeFileSync(path.join(stage,'install.log'),logs);code===0?resolve():reject(new Error(`Pi 下载失败 (${code})`));});
      });
      const candidate={...resolveEngine(stage),managedRoot:stage};this.report('正在验证新引擎，现有安装仍保留…');await this.verify(candidate);return candidate;
    } catch(error) {
      const log=path.join(stage,'install.log'); if(fs.existsSync(log))fs.copyFileSync(log,path.join(this.store.directory,'pi-install-failure.log'));
      this.removeManagedDirectory(stage,parent,prefix);throw error;
    }
  }
  private async replaceInPlace(target: string, candidate: EngineCandidate, reconnect: () => Promise<void>) {
    const stage=candidate.managedRoot!, backup=target+'.previous', stale=target+'.superseded';
    const hadTarget=fs.existsSync(target), hadBackup=fs.existsSync(backup);
    const old={runtimePath:this.store.data.runtimePath,externalCli:this.store.data.externalCli,previousRuntime:this.store.data.previousRuntime};
    let oldMoved=false,newMoved=false,backupMoved=false;
    try {
      if(fs.existsSync(stale))throw new Error(`上次更新的恢复目录仍存在，请先检查 ${stale}`);
      if(hadBackup && old.previousRuntime !== backup)throw new Error(`备份位置已被其他目录占用：${backup}`);
      await this.disconnect();
      if(hadBackup){fs.renameSync(backup,stale);backupMoved=true;}
      if(hadTarget){fs.renameSync(target,backup);oldMoved=true;}
      fs.renameSync(stage,target);newMoved=true;
      this.store.data.runtimePath=target;this.store.data.externalCli=undefined;this.store.data.previousRuntime=hadTarget?backup:undefined;this.store.save();
      await reconnect();
    } catch(error) {
      await this.disconnect();
      if(newMoved)fs.renameSync(target,stage);
      if(oldMoved)fs.renameSync(backup,target);
      if(backupMoved)fs.renameSync(stale,backup);
      Object.assign(this.store.data,old);this.store.save();if(this.selected())await reconnect().catch(()=>{});
      throw new Error(`更新失败，已恢复原目录和设置：${(error as Error).message}`);
    } finally {
      if(fs.existsSync(stage))this.removeManagedDirectory(stage,path.dirname(target),`.${path.basename(target)}.update-`);
    }
    if(backupMoved)this.removeManagedDirectory(stale,path.dirname(target),path.basename(target)+'.superseded');
  }
  async install(destination: string,isBusy:()=>boolean,reconnect:()=>Promise<void>) {
    if(this.info().installed)return this.connectExisting(this.store.data.externalCli||this.root,isBusy,reconnect);
    return this.operation(isBusy,async()=>{
      const target=path.join(destination,'Saint-Pi');
      if(fs.existsSync(target)) { const existing={...resolveEngine(target),managedRoot:target};await this.verify(existing);await this.activate(existing,reconnect);return; }
      await this.check();const candidate=await this.download(target);await this.replaceInPlace(target,candidate,reconnect);
      this.store.data.runtimeInstallDirectory=destination;this.store.save();this.report(`Pi ${candidate.version} 已安装并连接。`);
    });
  }
  async update(isBusy:()=>boolean,reconnect:()=>Promise<void>) {
    return this.operation(isBusy,async()=>{
      if(this.store.data.externalCli)throw new Error('外部 Pi 请通过原安装方式更新；Saint 不会覆盖其他工具的安装。');
      await this.check();if(!this.info().updateAvailable)return;
      const target=this.root,candidate=await this.download(target);await this.replaceInPlace(target,candidate,reconnect);
      this.report(`Pi ${candidate.version} 已更新，安装位置保持不变。`);
    });
  }
  async rollback(isBusy:()=>boolean,reconnect:()=>Promise<void>) {
    return this.operation(isBusy,async()=>{
      const target=this.root,backup=target+'.previous';
      if(this.store.data.previousRuntime!==backup||!fs.existsSync(backup))throw new Error('没有可恢复的原目录备份');
      await this.verify({...resolveEngine(backup),managedRoot:backup});
      const temporary=target+'.rollback';if(fs.existsSync(temporary))throw new Error('存在未完成的恢复目录，请先检查');
      await this.disconnect();let moved=false,swapped=false;
      try {
        fs.renameSync(target,temporary);moved=true;fs.renameSync(backup,target);swapped=true;fs.renameSync(temporary,backup);
        await reconnect();this.report(`已恢复 Pi ${this.version()}，安装位置保持不变。`);
      } catch(error) {
        await this.disconnect();
        if(swapped){if(!fs.existsSync(temporary))fs.renameSync(backup,temporary);fs.renameSync(target,backup);}
        if(moved)fs.renameSync(temporary,target);
        await reconnect().catch(()=>{});throw new Error(`恢复失败，已还原当前引擎：${(error as Error).message}`);
      }
    });
  }
  shutdown() { if (this.activeInstall?.pid) { if (process.platform === 'win32') spawn('taskkill.exe',['/pid',String(this.activeInstall.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'}); else this.activeInstall.kill(); } }
}
