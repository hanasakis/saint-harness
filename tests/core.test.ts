import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JsonLines, PiRpc } from '../electron/rpc';
import { needsApproval } from '../extensions/permissions.mjs';
import { within, readFile, changes, diff } from '../electron/files';
import { Store } from '../electron/store';

test('JSONL preserves unicode separators, CRLF and fragmented records', () => {
  const records: unknown[] = []; const parser = new JsonLines(r => records.push(r));
  const record = JSON.stringify({ type:'text', text:'中文\u2028paragraph\u2029line\r\n尾' });
  for (const chunk of [record.slice(0,11),record.slice(11)+'\r','\n{"type":"second"}\n']) parser.feed(chunk);
  assert.deepEqual(records,[JSON.parse(record),{type:'second'}]);
});

test('RPC correlates out-of-order responses and only settles on agent_settled', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'saint-rpc-'));
  const script=path.join(root,'fixture.cjs');
  fs.writeFileSync(script,`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(r.type==='run'){console.log(JSON.stringify({type:'agent_start'}));console.log(JSON.stringify({type:'agent_end'}));setTimeout(()=>console.log(JSON.stringify({type:'agent_settled'})),100);}setTimeout(()=>console.log(JSON.stringify({id:r.id,type:'response',success:true,data:r.type})),r.type==='slow'?50:0);}});`);
  const rpc=new PiRpc(process.execPath,[script],root,process.env);
  try { assert.equal(await rpc.start(),'get_state');assert.deepEqual(await Promise.all([rpc.request('slow'),rpc.request('fast')]),['slow','fast']);await rpc.request('run');assert.equal(rpc.busy,true);await new Promise<void>(resolve=>rpc.on('record',r=>{if(r.type==='agent_settled')resolve();}));assert.equal(rpc.busy,false); }
  finally {await rpc.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('automatic permissions permit workspace files but prompt for commands, secrets and symlink escapes', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'saint-permissions-'));const outside=fs.mkdtempSync(path.join(os.tmpdir(),'saint-outside-'));fs.writeFileSync(path.join(root,'readme.md'),'hello');
  try {
    assert.equal(needsApproval('auto','read',{path:'readme.md'},root),false);
    assert.equal(needsApproval('auto','write',{path:'src/new.txt'},root),false);
    assert.equal(needsApproval('auto','bash',{command:'echo hi'},root),true);
    assert.equal(needsApproval('auto','write',{path:'.env'},root),true);
    assert.equal(needsApproval('auto','read',{path:outside},root),true);
    fs.symlinkSync(outside,path.join(root,'linked'),'junction');
    assert.equal(needsApproval('auto','write',{path:'linked/escape.txt'},root),true);
    assert.equal(needsApproval('ask','read',{path:'readme.md'},root),true);
    assert.equal(needsApproval('full','bash',{command:'echo hi'},root),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
});

test('file previews reject traversal and binary files; Git review includes staged, unstaged and untracked edits', async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'saint-files-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  try {
    git('init');git('config','user.email','test@localhost');git('config','user.name','Saint Test');fs.writeFileSync(path.join(root,'中文.txt'),'original\n');git('add','.');git('commit','-m','fixture');
    fs.writeFileSync(path.join(root,'中文.txt'),'changed\n');git('add','.');fs.appendFileSync(path.join(root,'中文.txt'),'unstaged\n');fs.writeFileSync(path.join(root,'new.md'),'new content');
    const result=await changes(root);assert.equal(result.git,true);assert.equal(result.files.length,2);
    const patch=await diff(root,'中文.txt');assert.match(patch,/changed/);assert.match(patch,/unstaged/);assert.match(await diff(root,'new.md'),/new content/);
    await assert.rejects(within(root,'..'),/工作空间/);fs.writeFileSync(path.join(root,'binary'),Buffer.from([0,1,2]));await assert.rejects(readFile(root,'binary'),/二进制/);
    const nested=path.join(root,'子项目');fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'inside.md'),'nested');const nestedChanges=await changes(nested);assert.deepEqual(nestedChanges.files.map(f=>f.path),['inside.md']);assert.match(await diff(nested,'inside.md'),/nested/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('project/thread indexes survive reopening without duplicating canonical project paths',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'saint-store-'));
  try {const store=new Store(root);const p=store.addProject(root);assert.equal(store.addProject(root).id,p.id);const t=store.addThread(p.id);t.title='继续工作';store.save();const restored=new Store(root);assert.equal(restored.thread(t.id).title,'继续工作');assert.equal(restored.data.projects.length,1);}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});
