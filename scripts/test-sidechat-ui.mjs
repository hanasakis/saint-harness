import { _electron } from 'playwright';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const root=process.cwd(),data=path.join(root,'.test-data',`sidechat-${Date.now()}`),workspace=path.join(data,'选区项目');fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync('artifacts',{recursive:true});
const selected='只引用这小段文字。',prefix='不要加入侧边对话的整段开头。',suffix='不要加入侧边对话的秘密结尾。';
const requests=[],pending=new Map(),passed=[],errors=[];let app,page;
const server=http.createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;const r=JSON.parse(body);requests.push(r);
 const messages=r.messages||[],last=messages.findLast(m=>m.role==='user'),text=typeof last?.content==='string'?last.content:JSON.stringify(last?.content);
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const chunk=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'side-qa',object:'chat.completion.chunk',model:'qa',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
 const finish=value=>{if(res.destroyed||res.writableEnded)return;chunk({content:value});chunk({},'stop');res.end('data: [DONE]\n\n');};
 if(text.includes('侧边审批')&&!messages.slice(messages.findLastIndex(m=>m.role==='user')+1).some(m=>m.role==='tool')){chunk({role:'assistant',content:null,tool_calls:[{index:0,id:'side-write',type:'function',function:{name:'write',arguments:JSON.stringify({path:'side-permission.txt',content:'must-not-write'})}}]});chunk({},'tool_calls');res.end('data: [DONE]\n\n');return;}
 if(text.includes('主任务继续')){chunk({role:'assistant',content:'主对话仍在运行。'});pending.set('main',()=>finish('主任务完成。'));return;}
 if(text.includes('侧边独立问题')){chunk({role:'assistant',content:'侧边对话正在独立思考。'});pending.set('side',()=>finish('侧边任务完成。'));return;}
 if(text.includes('侧边停止')){chunk({role:'assistant',content:'侧边等待停止。'});pending.set('stop',()=>finish('已结束。'));return;}
 chunk({role:'assistant',content:''});finish(`${prefix}\n\n${selected}\n\n${suffix}`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const project={id:randomUUID(),name:'选区项目',path:workspace,trusted:false},parent={id:randomUUID(),projectId:project.id,title:'主对话',titleSource:'manual',titleStatus:'done',createdAt:Date.now(),updatedAt:Date.now()};
fs.writeFileSync(path.join(data,'workspace.json'),JSON.stringify({projects:[project],threads:[parent],activeThreadId:parent.id,...(process.env.SAINT_TEST_RUNTIME?{externalCli:process.env.SAINT_TEST_RUNTIME}:{}),settings:{access:'auto',autoCheck:false,autoUpdate:false,providers:[{id:'custom',name:'选区验收',modelId:'qa',contextWindow:128000,supportsImages:true,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}],defaultModel:{provider:'saint-custom',id:'qa'}},skillPaths:[],secrets:{}}));
const state=()=>page.evaluate(()=>window.saint.invoke('bootstrap'));
const wait=async fn=>{for(let i=0;i<450;i++){const s=await state();if(fn(s))return s;await page.waitForTimeout(100);}throw Error('Timed out waiting for side chat');};
const launch=async()=>{app=await _electron.launch({...(process.env.SAINT_TEST_EXE?{executablePath:process.env.SAINT_TEST_EXE,args:[]}:{args:[root]}),env:{...process.env,SAINT_DATA_DIR:data}});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await wait(s=>s.snapshot.connected&&!s.navigating&&!s.snapshot.busy);await app.evaluate(async({clipboard,ClipboardItem})=>{globalThis.savedClipboard=await Promise.all((await clipboard.read()).map(async item=>new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)]))))));});};
const restoreClipboard=()=>app.evaluate(async({clipboard})=>{if(globalThis.savedClipboard)await clipboard.write(globalThis.savedClipboard);});
async function menu(){
 const target=page.locator('.chat .assistantmessage .markdown p').filter({hasText:selected}).first();
 const box=await target.evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);const s=window.getSelection();s.removeAllRanges();s.addRange(r);const b=r.getBoundingClientRect();return {x:b.x,y:b.y};});
 await page.mouse.click(box.x+8,box.y+8,{button:'right'});await page.getByRole('menu',{name:'选中文字菜单'}).waitFor();
}
try{
 await launch();
 await page.getByLabel('任务输入',{exact:true}).fill('建立源对话');await page.getByRole('button',{name:'发送任务',exact:true}).click();
 await wait(s=>!s.snapshot.busy&&s.snapshot.messages.some(m=>m.role==='assistant'&&m.entryId));
 const source=(await state()).snapshot.messages.find(m=>m.role==='assistant');
 await page.getByLabel('任务输入',{exact:true}).fill('已有草稿');
 await menu();await page.getByRole('menuitem',{name:/添加到聊天/}).click();
 assert.equal(await page.getByLabel('任务输入',{exact:true}).inputValue(),'已有草稿');
 await page.locator('.chat .quotechip').hover();const quotePopup=page.getByRole('region',{name:'Selected text 选中文字'});await quotePopup.waitFor();
 assert.ok((await quotePopup.innerText()).includes(selected));assert.ok(!(await quotePopup.innerText()).includes(prefix));assert.ok(!(await quotePopup.innerText()).includes(suffix));
 await page.screenshot({path:'artifacts/selected-text-main.png',animations:'disabled'});await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'移除全部引用'}).click();
 await menu();await page.getByRole('menuitem',{name:'复制 Ctrl C',exact:true}).click();assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),selected);
 await menu();await page.getByRole('menuitem',{name:/粘贴到输入框/}).click();await page.waitForFunction(v=>document.querySelector('textarea[aria-label="任务输入"]').value==='已有草稿'+v,selected);
 passed.push('Selection menu and themed hover card contain only exact selected text; existing draft preserved; copy works');
 await page.getByLabel('任务输入',{exact:true}).fill('主任务继续');await page.getByRole('button',{name:'发送任务',exact:true}).click();await wait(s=>s.snapshot.busy&&pending.has('main'));
 const before=(await state()).snapshot.sessionFile,beforeContents=fs.readFileSync(before,'utf8');
 await menu();await page.getByRole('menuitem',{name:/在侧边对话中提问/}).click();
 let s=await wait(s=>s.side?.connected&&!s.navigating);const child=s.side.threadId;
 assert.equal(s.activeThreadId,parent.id);assert.ok(s.snapshot.busy);assert.equal(fs.readFileSync(before,'utf8'),beforeContents,'Creating a branch must never rewrite the live parent');
 const side=s.threads.find(t=>t.id===child);assert.equal(side.origin.entryId,source.entryId);assert.equal(side.origin.text,selected);
 const childRecords=fs.readFileSync(side.sessionFile,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(childRecords[0].parentSession,before);assert.ok(!JSON.stringify(childRecords).includes(prefix));assert.ok(!JSON.stringify(childRecords).includes(suffix));
 assert.ok(!JSON.stringify(childRecords).includes('主任务继续'),'Fork excludes turns after the selected node');
 assert.equal(s.side.messages.filter(m=>m.role==='user').length,1);assert.equal(s.side.messages.filter(m=>m.role==='assistant').length,0);assert.equal(side.origin.inheritedMessages,s.side.messages.length);await page.locator(`.sidechatlist [data-thread-id="${child}"]`).waitFor();
 await page.evaluate(id=>window.saint.invoke('thread.rename',{id,title:'持久侧边对话'}),child);
 await page.locator('.sidechat .quotechip').hover();await quotePopup.waitFor();assert.ok((await quotePopup.innerText()).includes(selected));assert.ok(!(await quotePopup.innerText()).includes(prefix));await page.keyboard.press('Escape');
 await app.evaluate(({clipboard,ClipboardItem,nativeImage})=>clipboard.write([new ClipboardItem({'image/png':new Blob([nativeImage.createFromBitmap(Buffer.alloc(16*16*4,128),{width:16,height:16}).toPNG()],{type:'image/png'})})]));
 await page.getByLabel('侧边对话输入',{exact:true}).focus();await page.keyboard.press('Control+V');await page.locator('.sidechat .imagechip').waitFor();assert.equal(await page.locator('.chat .imagechip').count(),0);
 await page.getByLabel('侧边对话输入',{exact:true}).fill('侧边独立问题');await page.getByRole('button',{name:'发送侧边任务',exact:true}).click();
 await wait(s=>s.side?.busy&&s.snapshot.busy&&pending.has('side'));
 const sideRequest=requests.find(r=>JSON.stringify(r.messages.at(-1)).includes('侧边独立问题'));
 assert.ok(JSON.stringify(sideRequest.messages).includes(selected));assert.ok(!JSON.stringify(sideRequest.messages).includes(prefix));assert.ok(!JSON.stringify(sideRequest.messages).includes(suffix));assert.ok(!JSON.stringify(sideRequest.messages).includes('主任务继续'));
 assert.ok(sideRequest.messages.at(-1).content.some(c=>c.type==='image_url'));assert.ok(!JSON.stringify(requests.find(r=>JSON.stringify(r.messages.at(-1)).includes('主任务继续'))).includes('image_url'));
 assert.ok(await page.locator('.chat').getByText('主对话仍在运行。',{exact:true}).count());assert.ok(await page.locator('.sidechat').getByText('侧边对话正在独立思考。',{exact:true}).count());
 await page.screenshot({path:'artifacts/sidechat-concurrent.png',animations:'disabled'});
 pending.get('side')();await wait(s=>!s.side?.busy&&s.snapshot.busy);
 await page.getByLabel('侧边对话输入',{exact:true}).fill('侧边停止');await page.getByRole('button',{name:'发送侧边任务',exact:true}).click();await wait(s=>s.side?.busy&&pending.has('stop'));
 await page.getByRole('button',{name:'停止侧边任务',exact:true}).click();await wait(s=>!s.side?.busy&&s.snapshot.busy);
 pending.get('main')();await wait(s=>!s.snapshot.busy&&!s.activities.some(a=>a.busy||a.naming));
 await page.evaluate(()=>window.saint.invoke('session.access',{mode:'ask'}));await wait(s=>s.side?.connected&&!s.navigating);
 pending.delete('main');await page.getByLabel('任务输入',{exact:true}).fill('主任务继续');await page.getByRole('button',{name:'发送任务',exact:true}).click();await wait(s=>s.snapshot.busy&&pending.has('main'));
 await page.getByLabel('侧边对话输入',{exact:true}).fill('侧边审批');await page.getByRole('button',{name:'发送侧边任务',exact:true}).click();
 const approval=page.getByRole('group',{name:'侧边对话审批'});await approval.waitFor();assert.equal(await page.getByRole('dialog',{name:'允许执行 write？'}).count(),0);await approval.getByRole('button',{name:'拒绝 / 取消',exact:true}).click();await wait(s=>!s.side?.busy&&s.snapshot.busy);assert.ok(!fs.existsSync(path.join(workspace,'side-permission.txt')));
 pending.get('main')();await wait(s=>!s.activities.some(a=>a.busy||a.naming));
 passed.push('Side clipboard image reaches only the side model; selection-menu paste preserves draft; side permission rejection blocks write while main continues');
 passed.push('Real Pi tree fork excludes the selected full reply and future turns; only quote reaches side model; parallel replies and stop are isolated');
 const splitter=page.getByRole('separator',{name:'调整主对话与侧边对话比例'}),leftBefore=await page.locator('.chat').boundingBox(),splitBox=await splitter.boundingBox();
 await page.mouse.move(splitBox.x+3,splitBox.y+100);await page.mouse.down();await page.mouse.move(splitBox.x-130,splitBox.y+100,{steps:8});await page.mouse.up();
 assert.ok((await page.locator('.chat').boundingBox()).width<leftBefore.width-70);const ratio=await splitter.getAttribute('aria-valuenow');
 await page.screenshot({path:'artifacts/sidechat-resized.png',animations:'disabled'});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(780,760));await page.waitForTimeout(150);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Compact split layout must not overflow the window');await page.screenshot({path:'artifacts/sidechat-compact.png',animations:'disabled'});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1480,950));
 await page.getByLabel('侧边对话输入',{exact:true}).fill('关闭应用后继续编辑的侧边草稿');
 await page.getByRole('button',{name:'收起侧边对话',exact:true}).click();await wait(s=>!s.side);
 await page.locator(`.sidechatlist [data-thread-id="${child}"] .thread`).click();await wait(s=>s.side?.threadId===child&&s.side.connected);
 assert.ok((await state()).side.messages.some(m=>JSON.stringify(m.content).includes('侧边任务完成')));
 await restoreClipboard();await app.close();app=undefined;await launch();s=await wait(s=>s.side?.connected&&!s.navigating);
 assert.equal(s.side.threadId,child);assert.equal(await page.getByRole('separator',{name:'调整主对话与侧边对话比例'}).getAttribute('aria-valuenow'),ratio);assert.ok(s.side.messages.some(m=>JSON.stringify(m.content).includes('侧边任务完成')));
 assert.equal(await page.locator('.sidechat .quotechip').count(),0,'A sent quote must not be silently attached again after restart');
 assert.equal(await page.getByLabel('侧边对话输入',{exact:true}).inputValue(),'关闭应用后继续编辑的侧边草稿');
 await page.getByRole('button',{name:'在主窗口打开侧边对话',exact:true}).click();await wait(s=>s.activeThreadId===child&&!s.navigating&&!s.side);assert.equal(await page.getByLabel('任务输入',{exact:true}).inputValue(),'关闭应用后继续编辑的侧边草稿');
 await page.getByLabel('任务输入',{exact:true}).fill('主窗口编辑的侧边草稿');await page.evaluate(id=>window.saint.invoke('thread.open',{id}),parent.id);await wait(s=>s.activeThreadId===parent.id&&!s.navigating);
 await page.locator(`.sidechatlist [data-thread-id="${child}"] .thread`).click();await wait(s=>s.side?.connected&&!s.navigating);assert.equal(await page.getByLabel('侧边对话输入',{exact:true}).inputValue(),'主窗口编辑的侧边草稿');
 passed.push('Split ratio, side transcript, sidebar entry and open panel survive app restart; closing panel does not delete');
 await page.locator(`.sidechatlist [data-thread-id="${child}"] .thread`).click({button:'right'});await page.getByRole('menuitem',{name:'归档会话',exact:true}).click();await wait(s=>!s.side&&s.threads.find(t=>t.id===child).archivedAt);
 assert.ok(fs.existsSync(side.sessionFile));await page.evaluate(id=>window.saint.invoke('thread.restore',{id}),child);await page.locator(`.sidechatlist [data-thread-id="${child}"] .thread`).click();await wait(s=>s.side?.connected&&!s.navigating);
 await page.evaluate(id=>window.saint.invoke('thread.archive',{id}),parent.id);await page.evaluate(id=>window.saint.invoke('thread.delete',{id,confirmed:true}),parent.id);
 assert.ok(fs.existsSync(side.sessionFile),'Side history remains after parent deletion');await page.evaluate(id=>window.saint.invoke('side.open',{id}),child);await wait(s=>s.side?.connected&&!s.navigating);
 await page.evaluate(id=>window.saint.invoke('thread.archive',{id}),child);await page.evaluate(id=>window.saint.invoke('thread.delete',{id,confirmed:true}),child);
 assert.ok(!fs.existsSync(side.sessionFile));assert.ok(!(await state()).threads.some(t=>t.id===child));
 await page.waitForFunction(id=>localStorage.getItem('saint-side-draft:'+id)===null,child);
 passed.push('Side archive/restore/delete is user-controlled; deleting parent preserves side data; side delete removes only its own history');
 assert.deepEqual(errors,[]);fs.writeFileSync('artifacts/sidechat-test.json',JSON.stringify({date:new Date().toISOString(),packaged:!!process.env.SAINT_TEST_EXE,passed,errors},null,2));console.log(JSON.stringify({passed},null,2));
}catch(e){if(app){await page.screenshot({path:'artifacts/sidechat-failure.png',animations:'disabled'}).catch(()=>{});fs.writeFileSync('artifacts/sidechat-failure.json',JSON.stringify({error:String(e),state:await state(),errors},null,2));}throw e;}
finally{
 for(const finish of pending.values())finish();
 if(app){await restoreClipboard().catch(()=>{});await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await app.close();}
 server.closeAllConnections();await new Promise(r=>server.close(r));
}
