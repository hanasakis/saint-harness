import { _electron } from 'playwright';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const root=process.cwd(),data=path.join(root,'.test-data',`context-${Date.now()}`),workspace=path.join(data,'项目');fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync('artifacts',{recursive:true});
let requests=0,app;const errors=[];
const server=http.createServer(async(req,res)=>{
 for await(const part of req){}requests++;
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const chunk=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'context-qa',object:'chat.completion.chunk',model:'qa',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
 chunk({role:'assistant',content:`上下文验收回复 ${requests}`});chunk({},'stop');
 res.write(`data: ${JSON.stringify({id:'context-qa',object:'chat.completion.chunk',choices:[],usage:requests===1?{prompt_tokens:2023,completion_tokens:304,total_tokens:2327,prompt_tokens_details:{cached_tokens:1792}}:{prompt_tokens:4500,completion_tokens:400,total_tokens:4900}})}\n\n`);res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const project={id:randomUUID(),name:'上下文验收',path:workspace,trusted:false},thread={id:randomUUID(),projectId:project.id,title:'上下文显示测试',titleSource:'manual',titleStatus:'done',createdAt:Date.now(),updatedAt:Date.now()};
fs.writeFileSync(path.join(data,'workspace.json'),JSON.stringify({projects:[project],threads:[thread],activeThreadId:thread.id,...(process.env.SAINT_TEST_RUNTIME?{externalCli:process.env.SAINT_TEST_RUNTIME}:{}),settings:{access:'auto',autoCheck:false,autoUpdate:false,providers:[{id:'custom',name:'上下文验收',modelId:'qa',contextWindow:1048576,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}],defaultModel:{provider:'saint-custom',id:'qa'}},skillPaths:[],secrets:{}}));
const state=page=>page.evaluate(()=>window.saint.invoke('bootstrap'));
async function waitState(page,predicate){for(let i=0;i<450;i++){const s=await state(page);if(predicate(s))return s;await page.waitForTimeout(100);}throw Error('Context update timed out');}
try{
 app=await _electron.launch({...(process.env.SAINT_TEST_EXE?{executablePath:process.env.SAINT_TEST_EXE,args:[]}:{args:[root]}),env:{...process.env,SAINT_DATA_DIR:data}});
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await waitState(page,s=>s.snapshot.connected&&!s.snapshot.busy&&!s.navigating);
 await page.getByLabel('任务输入').fill('第一轮统计');await page.getByRole('button',{name:'发送任务',exact:true}).click();
 const first=await waitState(page,s=>!s.snapshot.busy&&s.snapshot.stats?.contextUsage?.tokens===2327);
 assert.equal(first.snapshot.stats.contextUsage.contextWindow,1048576);
 assert.ok(first.snapshot.stats.contextUsage.percent>0&&first.snapshot.stats.contextUsage.percent<0.5);
 console.log(JSON.stringify({piContext:first.snapshot.stats.contextUsage,footer:await page.locator('button.context').innerText()}));
 assert.match(await page.locator('button.context').innerText(),/上下文 0\.22%/,'Nonzero sub-percent usage must not be rounded to 0%');
 await page.locator('button.context').click();assert.equal(await page.locator('.contextpicker .bigvalue').innerText(),'0.22%');
 await page.screenshot({path:'artifacts/context-small-percentage.png',animations:'disabled'});await page.getByRole('button',{name:'收起菜单',exact:true}).click();
 await page.getByLabel('任务输入').fill('第二轮统计');await page.getByRole('button',{name:'发送任务',exact:true}).click();
 const second=await waitState(page,s=>!s.snapshot.busy&&s.snapshot.stats?.contextUsage?.tokens===4900);
 assert.equal(second.snapshot.stats.tokens.total,7227);assert.match(await page.locator('button.context').innerText(),/上下文 0\.47%/);
 await page.locator('button.context').click();assert.equal(await page.locator('.contextpicker .bigvalue').innerText(),'0.47%');
 assert.deepEqual(errors,[]);assert.equal(requests,2);
 const result={date:new Date().toISOString(),packaged:!!process.env.SAINT_TEST_EXE,first:first.snapshot.stats.contextUsage,second:second.snapshot.stats.contextUsage,cumulativeTokens:second.snapshot.stats.tokens.total,passed:['real Pi returns nonzero fractional context percentage','footer and popup display 0.22% for 2327 / 1048576','later reply updates both displays to 0.47%; cumulative session tokens are not used as context'],errors};
 fs.writeFileSync('artifacts/context-test.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){if(app)await(await app.firstWindow()).screenshot({path:'artifacts/context-failure.png'}).catch(()=>{});throw error;}
finally{if(app){await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});}).catch(()=>{});await app.close();}server.closeAllConnections();await new Promise(r=>server.close(r));}
