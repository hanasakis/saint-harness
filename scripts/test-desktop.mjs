import { _electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root=process.cwd();const stamp=Date.now();const data=path.join(root,`.test-data/desktop-${stamp}`);const workspace=path.join(data,'中文验收项目');fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(workspace,'README.md'),'# Saint desktop acceptance\nA disposable integration workspace.\n');
execFileSync('git',['init'],{cwd:workspace,stdio:'pipe'});
const received=[];const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(404);res.end();return;}
  let body='';for await(const chunk of req)body+=chunk;
  const request=JSON.parse(body);received.push(request);
  const messages=request.messages||[];const lastUser=messages.findLastIndex(m=>m.role==='user');const user=messages[lastUser];const text=typeof user?.content==='string'?user.content:JSON.stringify(user?.content);
  const after=messages.slice(lastUser+1);const hasTool=after.some(m=>m.role==='tool');
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
  const chunk=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'saint-qa',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'saint-test',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
  const end=()=>{res.write(`data: ${JSON.stringify({id:'saint-qa',object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:120,completion_tokens:35,total_tokens:155}})}\n\n`);res.end('data: [DONE]\n\n');};
  if(text?.includes('停止测试')){chunk({role:'assistant',content:'开始执行停止测试。'});const timer=setInterval(()=>chunk({content:'等待中…'}),200);req.on('close',()=>clearInterval(timer));setTimeout(()=>{clearInterval(timer);if(!res.destroyed){chunk({},'stop');end();}},8000).unref();return;}
  if(!hasTool&&(text?.includes('创建验收文件')||text?.includes('审批测试'))){const name=text.includes('审批测试')?'未批准.txt':'验收结果.txt';chunk({role:'assistant',content:null,tool_calls:[{index:0,id:`call-${Date.now()}`,type:'function',function:{name:'write',arguments:JSON.stringify({path:name,content:'Saint Harness integration verified\n'})}}]});chunk({},'tool_calls');end();return;}
  chunk({role:'assistant',content:hasTool?'已处理工具结果。桌面集成验收完成。':'你好，这是本地验收服务的回复。'});chunk({},'stop');end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
let app;const errors=[];const results=[];
const launch=async()=>{app=await _electron.launch({...(process.env.SAINT_TEST_EXE?{executablePath:process.env.SAINT_TEST_EXE,args:[]}:{args:[root]}),env:{...process.env,SAINT_DATA_DIR:data}});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));app.process().stderr.on('data',d=>{const s=String(d);if(/Error|error/i.test(s))console.log(s.trim().slice(0,1000));});await page.waitForSelector('.welcome,.conversation');return page;};
const snapshot=page=>page.evaluate(()=>window.saint.invoke('bootstrap'));
const waitState=async(page,predicate,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){const d=await snapshot(page);if(predicate(d))return d;await page.waitForTimeout(100);}throw new Error('Timed out waiting for desktop state');};
const waitIdle=page=>waitState(page,d=>d.snapshot.connected&&!d.snapshot.busy);
try {
  let page=await launch();
  await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},workspace);
  await page.getByRole('button',{name:'添加工作空间',exact:true}).click();
  await waitState(page,d=>d.snapshot.connected&&!d.snapshot.busy);
  results.push('real Pi process connected to a workspace containing Chinese characters');
  await page.getByRole('button',{name:'我的工作空间',exact:true}).click();
  await page.getByRole('button',{name:'自定义',exact:true}).click();
  await page.getByLabel('显示名称',{exact:true}).fill('Saint 本地验收模型');
  await page.getByLabel('API Key').fill('saint-test-secret');
  await page.getByLabel('API 地址').fill(`http://127.0.0.1:${port}/v1`);
  await page.getByLabel('模型 ID',{exact:true}).fill('saint-test');
  await page.getByRole('button',{name:'保存并刷新模型'}).click();
  await waitState(page,d=>d.snapshot.connected&&!d.snapshot.busy&&d.snapshot.models.some(m=>m.id==='saint-test'));
  await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await page.locator('.modeltool').click();await page.locator('.modelresults').getByRole('button',{name:/Saint 本地验收模型/}).click();await waitState(page,d=>d.snapshot.model?.id==='saint-test'&&!d.snapshot.busy);
  const disk=fs.readFileSync(path.join(data,'workspace.json'),'utf8');assert.ok(!disk.includes('saint-test-secret'));results.push('API key encrypted at rest and custom model configured through UI');
  await page.getByLabel('任务输入').fill('创建验收文件');await page.getByRole('button',{name:'发送任务',exact:true}).click();
  await page.waitForFunction(()=>document.body.innerText.includes('桌面集成验收完成'),null,{timeout:45000});await waitIdle(page);
  assert.equal(fs.readFileSync(path.join(workspace,'验收结果.txt'),'utf8'),'Saint Harness integration verified\n');results.push('real Pi called write and persisted the file; streamed reply completed');
  let state=await snapshot(page);assert.ok(state.snapshot.stats.tokens.total>0);assert.ok(state.snapshot.sessionFile&&fs.existsSync(state.snapshot.sessionFile));
  await page.getByRole('button',{name:'待审阅'}).click();await page.getByRole('button',{name:/验收结果.txt/}).click();await page.locator('.diff').getByText(/integration verified/).waitFor();assert.match(await page.locator('.diff').innerText(),/integration verified/);results.push('actual Git changes and file diff rendered');
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'artifacts/02-desktop-connected.png'});
  await page.getByRole('button',{name:'关闭侧边面板',exact:true}).last().click();
  await page.evaluate(()=>window.saint.invoke('session.access',{mode:'ask'}));
  await page.getByLabel('任务输入').fill('审批测试');await page.getByRole('button',{name:'发送任务',exact:true}).click();
  await page.getByRole('dialog',{name:'允许执行 write？'}).waitFor({timeout:30000});await page.screenshot({path:'artifacts/03-tool-approval.png',animations:'disabled'});await page.getByRole('button',{name:'拒绝 / 取消',exact:true}).click();await waitIdle(page);assert.ok(!fs.existsSync(path.join(workspace,'未批准.txt')));results.push('denied tool approval blocked the real filesystem write');
  await page.getByLabel('任务输入').fill('停止测试');await page.getByRole('button',{name:'发送任务',exact:true}).click();await page.getByRole('button',{name:'停止任务',exact:true}).waitFor();await waitState(page,d=>d.snapshot.busy);await page.getByRole('button',{name:'停止任务',exact:true}).click();await waitIdle(page);await page.evaluate(()=>window.saint.invoke('session.refresh'));results.push('stop cleared pending work and aborted the actual Pi run');
  const messages=(await snapshot(page)).snapshot.messages.length;await app.close();app=undefined;page=await launch();await waitState(page,d=>d.snapshot.connected&&!d.snapshot.busy&&d.snapshot.messages.length>0);assert.equal((await snapshot(page)).snapshot.messages.length,messages);results.push('application restart restored the Pi session without duplicating messages');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(780,840));await page.waitForTimeout(250);await page.screenshot({path:'artifacts/04-compact-window.png'});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);results.push('compact desktop window has no horizontal page overflow');
  await page.getByRole('button',{name:'展开侧边面板',exact:true}).click();await page.screenshot({path:'artifacts/05-compact-review.png'});await page.getByRole('button',{name:'关闭侧边面板',exact:true}).last().click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1480,950));await page.getByRole('button',{name:'新建会话',exact:false}).first().click();await waitIdle(page);assert.equal((await snapshot(page)).snapshot.messages.length,0);await page.locator('.thread').getByText('创建验收文件',{exact:true}).click();await waitIdle(page);assert.equal((await snapshot(page)).snapshot.messages.length,messages);results.push('new session starts empty and switching restores the original history');
  await page.getByRole('button',{name:'我的工作空间',exact:true}).click();await page.screenshot({path:'artifacts/06-model-settings.png',animations:'disabled'});await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
  assert.equal(errors.length,0,errors.join('\n'));assert.ok(received.length>=4);results.push('renderer reported no uncaught JavaScript errors');
  fs.writeFileSync('artifacts/desktop-test.json',JSON.stringify({date:new Date().toISOString(),packaged:!!process.env.SAINT_TEST_EXE,results,requests:received.length,errors,model:'local deterministic OpenAI-compatible test service; no external paid API',pi:(await snapshot(page)).engine.current},null,2));console.log(JSON.stringify({passed:results},null,2));
}catch(e){if(app){const p=await app.firstWindow();await p.screenshot({path:'artifacts/desktop-failure.png'}).catch(()=>{});const failure=await snapshot(p).catch(()=>({}));console.log(JSON.stringify({error:failure.snapshot?.error,connected:failure.snapshot?.connected,models:failure.snapshot?.models,working:await p.locator('.toast').allTextContents()},null,2));}throw e;}
finally {if(app){await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});}).catch(()=>{});await app.close();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
