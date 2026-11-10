import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEngine, discoverEngines } from '../electron/engine-location';
import { RuntimeManager } from '../electron/runtime';
import { Store } from '../electron/store';

function installFixture(root:string, name='@earendil-works/pi-coding-agent') {
  const pkg = path.join(root,'node_modules',name); fs.mkdirSync(path.join(pkg,'dist/bundle'),{recursive:true});
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name,version:'1.5.0',bin:{pi:'dist/bundle/cli.js'}}));
  const cli=path.join(pkg,'dist/bundle/cli.js'); fs.writeFileSync(cli,'// fixture'); return {pkg,cli};
}

test('Pi discovery resolves install roots, package folders, npm launchers and legacy packages without executing wrappers',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'saint-location-'));
  try {
    const {pkg,cli}=installFixture(root);fs.writeFileSync(path.join(root,'pi.cmd'),'exit 99');
    for(const p of [root,path.join(root,'node_modules'),pkg,cli,path.join(root,'pi.cmd')]) assert.equal(resolveEngine(p).cli,fs.realpathSync(cli));
    const result=discoverEngines([{path:root,source:'current',managedRoot:root},{path:cli,source:'duplicate'},{path:path.join(root,'missing'),source:'missing'}]);
    assert.equal(result.length,1);assert.equal(result[0].managedRoot,root);
    const legacy=installFixture(path.join(root,'legacy'),'@mariozechner/pi-coding-agent');assert.equal(resolveEngine(path.join(root,'legacy')).cli,fs.realpathSync(legacy.cli));
    fs.unlinkSync(cli);assert.throws(()=>resolveEngine(root),/没有找到可运行/);
    assert.deepEqual(discoverEngines([{path:root,source:'missing-entry'}]),[]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('missing engines remain downloadable and invalid local selections preserve the previous installation',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'saint-runtime-'));
  try {
    const store=new Store(path.join(root,'data'));const runtime=new RuntimeManager(path.join(root,'absent'),process.execPath,'extension.mjs',store,()=>{});
    assert.equal(runtime.info().installed,false);assert.equal(runtime.info().updateAvailable,false);
    const installed=installFixture(path.join(root,'existing'));store.data.externalCli=installed.cli;store.save();
    const before=fs.readFileSync(path.join(store.directory,'workspace.json'),'utf8');
    await assert.rejects(runtime.connectExisting(root,()=>false,async()=>{}),/没有找到可运行/);
    assert.equal(fs.readFileSync(path.join(store.directory,'workspace.json'),'utf8'),before);
    assert.equal(runtime.info().updating,false);
    await assert.rejects(runtime.install(path.join(root,'download'),()=>true,async()=>{}),/当前任务/);
    assert.equal(fs.existsSync(path.join(root,'download')),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
