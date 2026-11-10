import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../electron/store';
import { RuntimeManager } from '../electron/runtime';
import { createRequire } from 'node:module';
// Electron APIs are not used by this protocol-only fixture; load its CJS export shape.
const { Sessions }: typeof import('../electron/sessions') = createRequire(import.meta.url)('../electron/sessions.ts');

test('returning to a settled background conversation waits for shutdown and opens a live process', async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'saint-lifecycle-'));
  const fixture=path.join(directory,'fixture.cjs');
  fs.writeFileSync(fixture,`let buffer='',messages=[];
const send=r=>console.log(JSON.stringify(r));
process.stdin.on('end',()=>setTimeout(()=>process.exit(0),250));
process.stdin.on('data',c=>{buffer+=c;let i;while((i=buffer.indexOf('\\n'))>=0){const r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);let data={};
if(r.type==='get_state')data={model:{id:'qa',provider:'qa',name:'QA'}};
if(r.type==='get_commands')data={commands:[{name:'saint-access'}]};
if(r.type==='get_available_models')data={models:[{id:'qa',provider:'qa'}]};
if(r.type==='get_available_thinking_levels')data={levels:['off']};
if(r.type==='get_messages')data={messages};
if(r.type==='run')send({type:'agent_start'});
if(r.type==='finish')send({type:'agent_settled'});
if(r.type==='prompt'){send({type:'agent_start'});const m={role:'user',content:r.message};messages.push(m);send({type:'message_end',message:m});send({type:'agent_settled'});}
send({type:'response',id:r.id,success:true,data});}});`);
  class FixtureRuntime extends RuntimeManager { override launch() { return {executable:process.execPath,args:[fixture],env:{ELECTRON_RUN_AS_NODE:'1'}}; } }
  const store=new Store(path.join(directory,'data'));const project=store.addProject(directory);
  const a=store.addThread(project.id),b=store.addThread(project.id);a.titleSource='manual';b.titleSource='manual';
  const runtime=new FixtureRuntime(directory,process.execPath,'fixture-extension',store,()=>{});
  const sessions=new Sessions(store,runtime,'fixture-extension',()=>{});
  const wait=async(predicate:()=>boolean)=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Lifecycle test timed out');};
  try {
    await sessions.connect(a.id);const original=sessions.rpc!;await original.request('run');
    await sessions.connect(b.id);await original.request('finish');await wait(()=>original.closing);
    await sessions.connect(a.id);
    assert.ok(sessions.rpc!==original,'Do not reuse the background process that is already closing');
    assert.equal(sessions.rpc?.closing,false);assert.equal(sessions.snapshot.connected,true);
    await sessions.prompt('切回后继续工作',[],[]);await wait(()=>!sessions.busy);
    assert.ok(sessions.snapshot.messages.some(m=>m.content==='切回后继续工作'));
  } finally {await sessions.close();if(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('saint-lifecycle-'))fs.rmSync(directory,{recursive:true,force:true});}
});
