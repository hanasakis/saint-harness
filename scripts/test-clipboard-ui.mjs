import { _electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const root=process.cwd(),data=path.join(root,'.test-data',`clipboard-${Date.now()}`),workspace=path.join(data,'项目');
fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync('artifacts',{recursive:true});
const project={id:randomUUID(),name:'粘贴交互验收',path:workspace,trusted:false};
const thread={id:randomUUID(),projectId:project.id,title:'剪贴板测试',titleSource:'manual',titleStatus:'done',createdAt:Date.now(),updatedAt:Date.now()};
const requests=[];
const server=http.createServer(async(req,res)=>{
 let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body));
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 for(const choice of [{delta:{role:'assistant',content:'已收到粘贴的附件。'},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write(`data: ${JSON.stringify({id:'clipboard-qa',object:'chat.completion.chunk',choices:[{index:0,...choice}]})}\n\n`);
 res.end('data: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
fs.writeFileSync(path.join(data,'workspace.json'),JSON.stringify({projects:[project],threads:[thread],activeThreadId:thread.id,...(process.env.SAINT_TEST_RUNTIME?{externalCli:process.env.SAINT_TEST_RUNTIME}:{}),settings:{access:'auto',autoCheck:false,autoUpdate:false,providers:[{id:'custom',name:'粘贴验收',modelId:'qa',contextWindow:128000,supportsImages:true,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}],defaultModel:{provider:'saint-custom',id:'qa'}},skillPaths:[],secrets:{}}));
let app;const failures=[],errors=[],passed=[];
async function check(name,fn){try{await fn();passed.push(name);console.log(`PASS ${name}`);}catch(e){failures.push(`${name}: ${e.message}`);console.log(`FAIL ${name}: ${e.message}`);}}
function copyFiles(files){
 execFileSync('powershell.exe',['-NoProfile','-STA','-Command',"Add-Type -AssemblyName System.Windows.Forms; $files=New-Object System.Collections.Specialized.StringCollection; foreach($file in (ConvertFrom-Json $env:SAINT_CLIPBOARD_FIXTURE)){[void]$files.Add($file)}; [System.Windows.Forms.Clipboard]::SetFileDropList($files)"],{env:{...process.env,SAINT_CLIPBOARD_FIXTURE:JSON.stringify(files)},windowsHide:true});
}
try{
 app=await _electron.launch({...(process.env.SAINT_TEST_EXE?{executablePath:process.env.SAINT_TEST_EXE,args:[]}:{args:[root]}),env:{...process.env,SAINT_DATA_DIR:data}});
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 const waitState=async predicate=>{for(let i=0;i<450;i++){const s=await page.evaluate(()=>window.saint.invoke('bootstrap'));if(predicate(s))return s;await page.waitForTimeout(100);}throw Error('Timed out waiting for Pi');};
 await waitState(s=>s.snapshot.connected&&!s.snapshot.busy&&!s.navigating);
 // Materialize and restore all original clipboard representations, including images.
 await app.evaluate(async({clipboard,ClipboardItem})=>{globalThis.savedClipboard=await Promise.all((await clipboard.read()).map(async item=>new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async t=>[t,await item.getType(t)]))))));});
 await check('cache tooltip uses the application theme',async()=>{
  await page.locator('.cachemetric').hover();
  await page.getByRole('tooltip').waitFor({timeout:1500});
  assert.equal(await page.locator('.cachemetric').evaluate(el=>el.closest('[title]')),null);
  await page.screenshot({path:'artifacts/cache-tooltip.png',animations:'disabled'});
  await page.keyboard.press('Escape');await page.getByRole('tooltip').waitFor({state:'hidden'});
  await page.locator('.cachemetric').focus();await page.getByRole('tooltip').waitFor();
  await page.keyboard.press('Escape');await page.getByRole('tooltip').waitFor({state:'hidden'});
 });
 await app.evaluate(({clipboard,ClipboardItem,nativeImage})=>clipboard.write([new ClipboardItem({'image/png':new Blob([nativeImage.createFromBitmap(Buffer.alloc(64*64*4,128),{width:64,height:64}).toPNG()],{type:'image/png'})})]));
 await check('Ctrl+V adds a clipboard bitmap as an attachment',async()=>{
  await page.getByLabel('任务输入').focus();await page.keyboard.press('Control+V');
  await page.locator('.imagechip').waitFor({timeout:2000});
 });
 await check('composer offers a themed paste context menu',async()=>{
  await page.getByLabel('任务输入').click({button:'right'});
  await page.getByRole('menu',{name:'输入编辑菜单'}).waitFor({timeout:1500});
  assert.equal(await page.getByRole('menuitem',{name:/粘贴/}).count(),1);
  await page.screenshot({path:'artifacts/composer-menu.png',animations:'disabled'});
  await page.getByRole('menuitem',{name:/粘贴/}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.imagechip').length===2);
  await page.waitForTimeout(150);assert.equal(await page.locator('.imagechip').count(),2,'One paste must add exactly one image');
 });
 const copiedFile=path.join(workspace,'剪贴板 文件.txt');fs.writeFileSync(copiedFile,'clipboard text fixture');
 const binary=path.join(workspace,'任意类型.bin');fs.writeFileSync(binary,Buffer.from([0,255,42,128]));
 copyFiles([copiedFile,binary]);
 await check('Ctrl+V adds Explorer file copies',async()=>{
  await page.keyboard.press('Escape');await page.getByLabel('任务输入').focus();await page.keyboard.press('Control+V');
  await page.getByRole('button',{name:'移除附件 剪贴板 文件.txt',exact:true}).waitFor({timeout:2000});
  await page.getByRole('button',{name:'移除附件 任意类型.bin',exact:true}).waitFor();
  assert.equal(await page.locator('.filechip').count(),4);
 });
 const input=page.getByLabel('任务输入');
 const text=async value=>{await app.evaluate(({clipboard},v)=>clipboard.writeText(v),value);};
 const menuAction=async name=>{await input.focus();await page.keyboard.press('Shift+F10');await page.getByRole('menuitem',{name}).click();};
 const inputEquals=async value=>page.waitForFunction(v=>document.querySelector('textarea[aria-label="任务输入"]').value===v,value);
 await check('text paste replaces the selection and supports menu undo/redo',async()=>{
  await input.fill('开始替换结束');await input.evaluate(el=>el.setSelectionRange(2,4));await text('粘贴\n文字');
  await page.keyboard.press('Control+V');await inputEquals('开始粘贴\n文字结束');
  await menuAction(/^撤销/);await inputEquals('开始替换结束');
  await menuAction(/^重做/);await inputEquals('开始粘贴\n文字结束');
  await input.evaluate(el=>el.setSelectionRange(0,2));await menuAction(/^复制/);
  assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'开始');
  await input.evaluate(el=>el.setSelectionRange(0,2));await menuAction(/^剪切/);await inputEquals('粘贴\n文字结束');
  await menuAction(/^全选/);await text('菜单粘贴文字');await menuAction(/^粘贴/);await inputEquals('菜单粘贴文字');
  assert.equal(await page.locator('.filechip').count(),4);
 });
 await check('file paste from menu and removal preserve the source',async()=>{
  const file=path.join(workspace,'菜单附件.md');fs.writeFileSync(file,'menu file fixture');copyFiles([file]);
  await menuAction(/^粘贴/);const chip=page.getByRole('button',{name:'移除附件 菜单附件.md',exact:true});await chip.waitFor();await chip.click();await chip.waitFor({state:'hidden'});
  assert.equal(fs.readFileSync(file,'utf8'),'menu file fixture');
 });
 await check('invalid attachment batches leave existing attachments intact',async()=>{
  const huge=path.join(workspace,'超过限制.bin');fs.writeFileSync(huge,'');fs.truncateSync(huge,100*1024*1024+1);
  for(const [files,message]of [[[huge],/超过 100 MB/],[[workspace],/文件夹请先压缩/],[Array.from({length:7},(_,i)=>{const f=path.join(workspace,`批量${i}.txt`);fs.writeFileSync(f,'test');return f;}),/最多添加 10 个附件/]]){
   copyFiles(files);await input.focus();await page.keyboard.press('Control+V');await page.getByRole('alert').filter({hasText:message}).waitFor();
   assert.equal(await page.locator('.filechip').count(),4);await page.getByRole('button',{name:'关闭提示'}).click();
  }
 });
 await check('attachments and draft remain isolated across threads',async()=>{
  await page.locator('.newthread').click();
  await waitState(s=>s.snapshot.connected&&!s.snapshot.busy&&!s.navigating);
  assert.equal(await page.locator('.filechip').count(),0);assert.equal(await input.inputValue(),'');
  await page.locator(`[data-thread-id="${thread.id}"] .thread`).click();
  await page.waitForFunction(()=>document.querySelectorAll('.filechip').length===4);assert.equal(await input.inputValue(),'菜单粘贴文字');
 });
 await check('small-window menus remain visible and keyboard accessible',async()=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(780,680));
  await input.click({button:'right',position:{x:10,y:10}});
  const menu=page.getByRole('menu',{name:'输入编辑菜单'});const box=await menu.boundingBox(),size=page.viewportSize()||await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=size.width&&box.y+box.height<=size.height);
  await page.keyboard.press('End');assert.match(await page.locator(':focus').innerText(),/全选/);
  await page.screenshot({path:'artifacts/composer-menu-compact.png',animations:'disabled'});
  await page.keyboard.press('Escape');assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1480,950));
 });
 await check('preloaded clipboard files and images reach real Pi after originals move',async()=>{
  fs.renameSync(copiedFile,copiedFile+'.moved');fs.renameSync(binary,binary+'.moved');
  await page.getByRole('button',{name:'发送任务',exact:true}).click();
  await waitState(s=>!s.snapshot.busy&&s.snapshot.messages.some(m=>m.role==='assistant'&&m.stopReason==='stop'));
  assert.equal(await page.locator('.filechip').count(),0);
  for(let i=0;i<200&&!requests.length;i++)await page.waitForTimeout(100);
  assert.ok(requests.length,'The local model endpoint must receive the attachments');
  const message=requests.at(-1).messages.findLast(m=>m.role==='user');
  assert.ok(message.content.some(c=>c.type==='image_url'&&c.image_url.url.startsWith('data:image/png;base64,')));
  assert.match(JSON.stringify(message),/clipboard text fixture/);assert.match(JSON.stringify(message),/任意类型.bin/);
 });
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
 fs.writeFileSync('artifacts/clipboard-test.json',JSON.stringify({date:new Date().toISOString(),packaged:!!process.env.SAINT_TEST_EXE,passed,errors},null,2));
}catch(e){console.error(e);throw e;}finally{
 if(app){await app.evaluate(async({clipboard,dialog})=>{dialog.showMessageBox=async()=>({response:1});if(globalThis.savedClipboard)await clipboard.write(globalThis.savedClipboard);}).catch(()=>{});await app.close();}
 server.closeAllConnections();await new Promise(r=>server.close(r));
}
