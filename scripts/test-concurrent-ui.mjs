import { _electron } from 'playwright';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';
const root=process.cwd(),data=path.join(root,'.test-data',`concurrent-${Date.now()}`),workspace=path.join(data,'项目');fs.mkdirSync(workspace,{recursive:true});
const pending=new Map(),titles=[],requests=[],results=[];let app;
const server=http.createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;const r=JSON.parse(body);requests.push(r);
 const messages=r.messages||[],sys=JSON.stringify(messages.filter(m=>m.role==='system'||m.role==='developer')),last=messages.findLast(m=>m.role==='user');const text=typeof last?.content==='string'?last.content:(last?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
 const title=sys.includes('你只负责为对话生成简短标题');const label=title?(text.includes('任务 A')?'A':text.includes('任务 B')?'B':text.includes('命名失败')?'fail':'C'):text;
 if(title){titles.push({label,r});if(label==='fail'){res.writeHead(503);res.end('unavailable');return;}}
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const chunk=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'qa',object:'chat.completion.chunk',model:'qa',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
 const finish=answer=>{if(res.writableEnded||res.destroyed)return;chunk({content:answer});chunk({},'stop');res.write(`data: ${JSON.stringify({id:'qa',object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:80}}})}\n\n`);res.end('data: [DONE]\n\n');};
 if(title){chunk({role:'assistant',content:''});pending.set('title-'+label,()=>finish(label==='A'?'项目结构分析':label==='B'?'第二项任务规划':'后台审批验证'));return;}
 if(text==='任务 A'||text==='任务 B'){chunk({role:'assistant',content:`${text}思考中。`});pending.set(text,()=>finish(`${text}完成。`));return;}
 if(text==='审批任务'&&!messages.slice(messages.findLastIndex(m=>m.role==='user')+1).some(m=>m.role==='tool')){chunk({role:'assistant',content:null,tool_calls:[{index:0,id:'approval-call',type:'function',function:{name:'write',arguments:JSON.stringify({path:'permission-test.txt',content:'approved'})}}]});chunk({},'tool_calls');res.end('data: [DONE]\n\n');return;}
 chunk({role:'assistant',content:''});finish('普通回复完成。');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const state=p=>p.evaluate(()=>window.saint.invoke('bootstrap'));
async function waitState(p,fn){for(let n=0;n<450;n++){const s=await state(p);if(fn(s))return s;await p.waitForTimeout(100);}throw Error('state timeout');}
async function waitFor(fn){for(let n=0;n<450;n++){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('response timeout');}
const launch=async()=>{app=await _electron.launch({...(process.env.SAINT_TEST_EXE?{executablePath:process.env.SAINT_TEST_EXE,args:[]}:{args:[root]}),env:{...process.env,SAINT_DATA_DIR:data}});const p=await app.firstWindow();await p.waitForSelector('.welcome,.conversation');return p;};
try{
 let p=await launch();const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},workspace);
 await p.getByRole('button',{name:'添加工作空间',exact:true}).click();await waitState(p,s=>s.snapshot.connected&&!s.snapshot.busy);
 await p.evaluate(baseUrl=>window.saint.invoke('settings.saveProvider',{id:'custom',name:'QA',baseUrl,modelId:'qa'}),`http://127.0.0.1:${server.address().port}/v1`);await p.evaluate(()=>window.saint.invoke('session.model',{provider:'saint-custom',modelId:'qa'}));
 const a=(await state(p)).activeThreadId;
 await p.getByLabel('任务输入').fill('任务 A');await p.getByRole('button',{name:'发送任务',exact:true}).click();await waitState(p,s=>s.snapshot.busy);await p.getByText('任务 A思考中。',{exact:true}).waitFor();
 assert.equal(await p.locator('.newthread').isEnabled(),true,'New conversation must remain enabled while Pi is thinking');
 await p.locator('.newthread').click();await waitState(p,s=>s.activeThreadId!==a&&s.snapshot.connected&&!s.snapshot.busy);
 const b=(await state(p)).activeThreadId;
 assert.equal((await state(p)).snapshot.messages.length,0);assert.ok((await state(p)).activities.find(t=>t.id===a).busy);
 await p.getByLabel('任务输入').fill('任务 B');await p.getByRole('button',{name:'发送任务',exact:true}).click();await waitState(p,s=>s.snapshot.busy);await waitFor(()=>pending.has('任务 B'));
 await p.locator(`[data-thread-id="${a}"] .thread`).click();await waitState(p,s=>s.activeThreadId===a&&!s.navigating);
 await p.getByText('任务 A思考中。',{exact:true}).waitFor();assert.equal(await p.getByText('任务 B思考中。',{exact:true}).count(),0);
 await p.getByLabel('任务输入').fill('A 的未发送草稿');
 pending.get('任务 B')();await waitFor(()=>pending.has('title-B'));
 assert.equal((await state(p)).activeThreadId,a);assert.ok((await state(p)).snapshot.busy);
 await p.evaluate(id=>window.saint.invoke('thread.rename',{id,title:'我手动命名的 B'}),b);pending.get('title-B')();
 pending.get('任务 A')();await waitFor(()=>pending.has('title-A'));pending.get('title-A')();
 await waitState(p,s=>s.threads.find(t=>t.id===a).title==='项目结构分析'&&!s.activities.some(t=>t.naming));
 assert.equal((await state(p)).threads.find(t=>t.id===b).title,'我手动命名的 B');assert.equal(titles.filter(t=>t.label==='A').length,1);assert.equal(titles.filter(t=>t.label==='B').length,1);
 assert.ok(titles.every(t=>!t.r.tools?.length),'Title generation must not expose tools');
 assert.ok(titles.find(t=>t.label==='A').r.messages.some(m=>JSON.stringify(m.content).includes('任务 A完成。')),'Title sees both sides of the conversation');
 await p.locator('.cachemetric').getByText('80.0%',{exact:true}).waitFor();assert.ok(await p.locator('.usagegroup .cachemetric').count());
 fs.mkdirSync('artifacts',{recursive:true});await p.screenshot({path:'artifacts/concurrent-titles-cache.png',animations:'disabled'});
 results.push('new conversation and two simultaneous real Pi streams; switching preserves partial replies; background completion never steals selection');
 results.push('one isolated model title request after first reply; assistant content included; manual rename wins the race; 80% cache rate is beside session tokens');
 await p.locator(`[data-thread-id="${b}"] .thread`).click();await waitState(p,s=>s.activeThreadId===b&&s.snapshot.connected&&!s.navigating);
 assert.equal((await state(p)).snapshot.messages.some(m=>JSON.stringify(m).includes('任务 A')),false);
 await p.getByLabel('任务输入').fill('B 的草稿');await p.locator(`[data-thread-id="${a}"] .thread`).click();await waitState(p,s=>s.activeThreadId===a&&!s.navigating);assert.equal(await p.getByLabel('任务输入').inputValue(),'A 的未发送草稿');
 await p.getByLabel('任务输入').fill('继续聊天');await p.getByRole('button',{name:'发送任务',exact:true}).click();await waitState(p,s=>!s.snapshot.busy&&s.snapshot.messages.length>=4);assert.equal(titles.filter(t=>t.label==='A').length,1);
 await p.locator('.newthread').click();await waitState(p,s=>s.activeThreadId!==a&&s.activeThreadId!==b&&s.snapshot.connected&&!s.navigating);const c=(await state(p)).activeThreadId;
 await p.evaluate(()=>window.saint.invoke('session.access',{mode:'ask'}));await p.getByLabel('任务输入').fill('审批任务');await p.getByRole('button',{name:'发送任务',exact:true}).click();await p.getByRole('dialog',{name:'允许执行 write？'}).waitFor();
 // IPC mirrors clicking another session; pending approval must follow its owner.
 await p.evaluate(id=>window.saint.invoke('thread.open',{id}),b);await waitState(p,s=>s.activeThreadId===b&&!s.navigating);assert.equal(await p.getByRole('dialog',{name:'允许执行 write？'}).count(),0);assert.ok((await state(p)).activities.find(t=>t.id===c).waiting);
 await p.locator(`[data-thread-id="${c}"] .thread`).click();await p.getByRole('dialog',{name:'允许执行 write？'}).waitFor();await p.getByRole('button',{name:'拒绝 / 取消',exact:true}).click();await waitFor(()=>pending.has('title-C'));pending.get('title-C')();await waitState(p,s=>!s.activities.some(a=>a.busy||a.naming));assert.ok(!fs.existsSync(path.join(workspace,'permission-test.txt')));
 results.push('drafts, messages and tool approvals stay with each thread; rejecting a restored approval blocks the write');
 await p.locator('.newthread').click();await waitState(p,s=>s.activeThreadId!==c&&s.snapshot.connected&&!s.navigating);const failed=(await state(p)).activeThreadId;
 await p.getByLabel('任务输入').fill('命名失败');await p.getByRole('button',{name:'发送任务',exact:true}).click();await waitState(p,s=>s.threads.find(t=>t.id===failed).titleStatus==='failed');assert.equal(titles.filter(t=>t.label==='fail').length,1);
 assert.equal((await state(p)).threads.find(t=>t.id===failed).title,'命名失败');
 await app.close();app=undefined;p=await launch();await waitState(p,s=>s.snapshot.connected&&!s.navigating);assert.equal((await state(p)).threads.find(t=>t.id===a).title,'项目结构分析');assert.equal(titles.filter(t=>t.label==='fail').length,1);
 assert.deepEqual(errors,[]);results.push('title failure leaves fallback without automatic retries; generated and manual titles persist across restart');
 fs.writeFileSync('artifacts/concurrent-test.json',JSON.stringify({date:new Date().toISOString(),packaged:!!process.env.SAINT_TEST_EXE,results,errors},null,2));console.log(JSON.stringify({passed:results},null,2));
}catch(error){fs.mkdirSync('artifacts',{recursive:true});if(app){const page=await app.firstWindow();await page.screenshot({path:'artifacts/concurrent-failure.png'}).catch(()=>{});fs.writeFileSync('artifacts/concurrent-failure.json',JSON.stringify({error:String(error),requests,state:await state(page),body:await page.locator('body').innerText()},null,2));}throw error;}finally{for(const finish of pending.values())try{finish();}catch{}if(app){await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await app.close();}server.closeAllConnections();await new Promise(r=>server.close(r));}
