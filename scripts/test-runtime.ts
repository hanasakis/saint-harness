import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeManager } from '../electron/runtime';
import { Store } from '../electron/store';

const root = process.cwd(), directory = path.join(root, '.test-data', `runtime-${Date.now()}`);
const bundled = path.join(directory, '应用内置'), store = new Store(path.join(directory, 'data'));
// Copy into disposable storage: never update the developer's or user's engine.
function copy(source: string, destination: string) {
  fs.mkdirSync(destination, {recursive:true});
  for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
    const from=path.join(source,entry.name), to=path.join(destination,entry.name);
    if(entry.isDirectory())copy(from,to);else if(entry.isFile())fs.copyFileSync(from,to);
  }
}
copy(path.join(root,'runtime'),bundled);
const packageFile=path.join(bundled,'node_modules/@earendil-works/pi-coding-agent/package.json');
const manifest=JSON.parse(fs.readFileSync(packageFile,'utf8'));manifest.version='0.0.0';fs.writeFileSync(packageFile,JSON.stringify(manifest));
store.data.runtimePath=path.join(directory,'旧版本目录');store.save();
let connections=0,disconnections=0;
const runtime = new RuntimeManager(bundled,process.execPath,path.join(root,'extensions/permissions.mjs'),store,info=>console.log(info.message),async()=>{disconnections++;});
assert.equal(runtime.root,bundled,'Bundled Pi takes precedence over legacy managed installs');
const reconnect=async()=>{connections++;assert.ok(fs.existsSync(runtime.cli()));};
const assertClean=()=>assert.deepEqual(fs.readdirSync(directory).filter(n=>n.includes('.update-')||n.endsWith('.superseded')||n.endsWith('.rollback')),[]);
await assert.rejects(runtime.update(()=>true,reconnect),/当前任务/);
await runtime.install(path.join(directory,'不得新增的安装位置'),()=>false,reconnect);
assert.ok(!fs.existsSync(path.join(directory,'不得新增的安装位置')));
await runtime.update(()=>false,reconnect);
assert.equal(runtime.root,bundled);assert.equal(runtime.version(),runtime.info().latest);assert.equal(store.data.previousRuntime,bundled+'.previous');assertClean();
await runtime.rollback(()=>false,reconnect);assert.equal(runtime.root,bundled);assert.equal(runtime.version(),'0.0.0');assertClean();
let fail=true;
await assert.rejects(runtime.rollback(()=>false,async()=>{if(fail){fail=false;throw Error('test reconnect failure');}}),/test reconnect failure/);
assert.equal(runtime.version(),'0.0.0');assertClean();
fail=true;
await assert.rejects(runtime.update(()=>false,async()=>{if(fail){fail=false;throw Error('test update reconnect failure');}}),/test update reconnect failure/);
assert.equal(runtime.version(),'0.0.0');assertClean();
await runtime.update(()=>false,reconnect);assert.equal(runtime.version(),runtime.info().latest);assertClean();
assert.equal(fs.readdirSync(directory).filter(n=>n.endsWith('.previous')).length,1);
assert.ok(disconnections>=4);assert.equal(runtime.info().updating,false);
const external=path.join(root,'runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');store.data.externalCli=external;store.save();
const externalRuntime=new RuntimeManager(bundled,process.execPath,path.join(root,'extensions/permissions.mjs'),store,()=>{});
assert.equal(externalRuntime.info().path,external);assert.equal(externalRuntime.info().previous,undefined);await assert.rejects(externalRuntime.update(()=>false,reconnect),/外部 Pi/);
fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/runtime-test.json',JSON.stringify({date:new Date().toISOString(),latest:runtime.info().latest,connections,disconnections,passed:['bundled preference; existing installation reused without download','real npm staged install and RPC permission verification','stable original install path with one rollback backup','rollback and reconnect failure restoration','failed update restores original files; repeated update leaves no staging directories','explicit external engine preserved and never updated by Saint'],simulation:'Initial package version in a disposable copy changed to 0.0.0; npm downloads, file replacements, Pi RPC and permissions are real.'},null,2));
console.log('Runtime update-in-place and rollback acceptance passed.');
