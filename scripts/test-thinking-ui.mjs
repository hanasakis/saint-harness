import { _electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root=process.cwd(),data=path.join(root,'.test-data',`thinking-${Date.now()}`),workspace=path.join(data,'项目');
fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync('artifacts',{recursive:true});
let app,stream;const received=[],results=[],errors=[];
const server=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;const request=JSON.parse(body);received.push(request);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'thinking-qa',object:'chat.completion.chunk',model:'qa',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
  chunk({role:'assistant',reasoning_content:'\n\n'});
  stream={reason:text=>chunk({reasoning_content:text}),answer:text=>chunk({content:text}),finish:()=>{chunk({},'stop');res.end('data: [DONE]\n\n');}};
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const project={id:randomUUID(),name:'显示验收项目',path:workspace,trusted:false};
const thread={id:randomUUID(),projectId:project.id,title:'思考显示验收',titleSource:'manual',titleStatus:'done',createdAt:Date.now(),updatedAt:Date.now(),sessionFile:path.join(data,'sessions',project.id,'fixture.jsonl')};
const records=[{type:'session',version:3,id:randomUUID(),timestamp:new Date().toISOString(),cwd:workspace}];let parentId=null;
function assistant(thinking,text){
 const id=randomUUID().slice(0,8);records.push({type:'message',id,parentId,timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'thinking',thinking,thinkingSignature:'reasoning_content'},{type:'text',text}],api:'openai-completions',provider:'saint-custom',model:'qa',usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()}});parentId=id;
}
assistant('历史思考内容：先分析再回答。','历史正式回答：已完成。');
assistant('\n\n','只有换行的思考字段，正文仍然有效。');
assistant('','This is a normal English answer. 这也是正文，不应被猜测成思考。');
fs.mkdirSync(path.dirname(thread.sessionFile),{recursive:true});fs.writeFileSync(thread.sessionFile,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
fs.writeFileSync(path.join(data,'workspace.json'),JSON.stringify({projects:[project],threads:[thread],activeThreadId:thread.id,settings:{access:'auto',autoCheck:false,autoUpdate:false,providers:[{id:'custom',name:'显示验收',modelId:'qa',reasoning:true,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}],defaultModel:{provider:'saint-custom',id:'qa'}},skillPaths:[],secrets:{}}));
const state=page=>page.evaluate(()=>window.saint.invoke('bootstrap'));
async function waitState(page,predicate){for(let i=0;i<450;i++){const value=await state(page);if(predicate(value))return value;await page.waitForTimeout(100);}throw Error('Thinking state timed out');}
async function waitStream(page){for(let i=0;i<150;i++){if(stream)return;await page.waitForTimeout(100);}throw Error('Model request not received');}
try{
 app=await _electron.launch({...(process.env.SAINT_TEST_EXE?{executablePath:process.env.SAINT_TEST_EXE,args:[]}:{args:[root]}),env:{...process.env,SAINT_DATA_DIR:data}});
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await waitState(page,s=>s.snapshot.connected&&!s.snapshot.busy&&!s.navigating);
 const native=page.locator('.assistantmessage').filter({hasText:'历史正式回答：已完成。'});
 assert.equal(await native.locator('.thinking > div').isVisible(),false);
 await native.locator('.thinking summary').click();assert.equal(await native.locator('.thinking > div').isVisible(),true);
 assert.match(await native.locator('.thinking').innerText(),/历史思考内容/);assert.equal(await native.locator('.markdown').innerText(),'历史正式回答：已完成。');
 await native.locator('.thinking summary').click();assert.equal(await native.locator('.thinking > div').isVisible(),false);
 results.push('existing structured thinking expands and collapses; answer remains outside the thinking section');
 const blank=page.locator('.assistantmessage').filter({hasText:'只有换行的思考字段，正文仍然有效。'});
 assert.equal(await blank.locator('.thinking').count(),0,'Shared renderer must hide whitespace-only reasoning instead of an empty expandable section');
 assert.equal(await page.locator('.markdown').filter({hasText:'This is a normal English answer.'}).count(),1);
 results.push('empty and whitespace-only thinking produce no misleading foldout; unmarked answer text is preserved');
 await page.getByLabel('任务输入').fill('流式思考测试');await page.getByRole('button',{name:'发送任务',exact:true}).click();await waitStream(page);
 await waitState(page,s=>s.snapshot.streaming?.some(b=>b.type==='thinking'));
 assert.equal(await page.locator('.streaming .thinking').count(),0);
 stream.reason('流式分析第一部分。');await page.locator('.streaming .thinking summary').waitFor();await page.locator('.streaming .thinking summary').click();
 stream.reason('第二部分。');await page.getByText('流式分析第一部分。第二部分。',{exact:true}).waitFor();
 assert.equal(await page.locator('.streaming .thinking').getAttribute('open'),'');
 stream.answer('流式正式回答。');await page.locator('.streaming .markdown').getByText('流式正式回答。',{exact:true}).waitFor();
 assert.ok(!(await page.locator('.streaming .markdown').innerText()).includes('分析'));
 await page.screenshot({path:'artifacts/thinking-streaming.png',animations:'disabled'});stream.finish();stream=undefined;
 await waitState(page,s=>!s.snapshot.busy&&s.snapshot.messages.some(m=>JSON.stringify(m.content).includes('流式正式回答。')));
 const completed=page.locator('.assistantmessage:not(.streaming)').filter({hasText:'流式正式回答。'});
 await completed.locator('.thinking summary').click();assert.equal(await completed.locator('.thinking > div').isVisible(),true);
 await completed.locator('.thinking summary').press('Enter');assert.equal(await completed.locator('.thinking > div').isVisible(),false);
 const saved=(await state(page)).snapshot.messages.at(-1);assert.ok(saved.content.some(b=>b.type==='thinking'&&b.thinking.includes('第二部分')));assert.deepEqual(saved.content.filter(b=>b.type==='text').map(b=>b.text),['流式正式回答。']);
 await page.getByLabel('任务输入').fill('空白思考测试');await page.getByRole('button',{name:'发送任务',exact:true}).click();await waitStream(page);stream.answer('只有正式回答。');stream.finish();stream=undefined;
 await waitState(page,s=>!s.snapshot.busy&&s.snapshot.messages.some(m=>JSON.stringify(m.content).includes('只有正式回答。')));
 assert.equal(await page.locator('.assistantmessage').filter({hasText:'只有正式回答。'}).locator('.thinking').count(),0);
 results.push('real Pi maps reasoning_content separately during streaming and after completion; expanded state survives deltas; keyboard toggle works');
 await page.screenshot({path:'artifacts/thinking-completed.png',animations:'disabled'});assert.deepEqual(errors,[]);assert.equal(received.length,2);
 fs.writeFileSync('artifacts/thinking-test.json',JSON.stringify({date:new Date().toISOString(),packaged:!!process.env.SAINT_TEST_EXE,results,errors},null,2));console.log(JSON.stringify({passed:results},null,2));
}catch(error){if(app)await(await app.firstWindow()).screenshot({path:'artifacts/thinking-failure.png'}).catch(()=>{});throw error;}
finally{if(app){await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await app.close();}server.closeAllConnections();await new Promise(r=>server.close(r));}
