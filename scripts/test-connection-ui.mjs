import { _electron } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const directory = path.join(root, '.test-data', `connection-ui-${Date.now()}`);
const calls = []; let delay = 150;
const server = http.createServer((req,res) => {
  calls.push({url:req.url,method:req.method,key:req.headers.authorization});
  setTimeout(() => {
    if (res.destroyed) return;
    if (req.headers.authorization !== 'Bearer test-only-key') { res.writeHead(401); res.end('test-only-key'); return; }
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({data:[{id:'test-model'}]}));
  }, delay);
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let app;
try {
  app = await _electron.launch({...(process.env.SAINT_TEST_EXE?{executablePath:process.env.SAINT_TEST_EXE,args:[]}:{args:[root]}),env:{...process.env,SAINT_DATA_DIR:directory}});
  const page = await app.firstWindow(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'我的工作空间',exact:true}).click();
  const testButton = () => page.getByRole('button',{name:'测试连接',exact:true});
  await testButton().click(); await page.getByRole('alert').filter({hasText:'请填写 API Key'}).waitFor();
  await page.getByRole('button',{name:'自定义',exact:true}).click();
  await page.getByLabel('API 地址').fill(baseUrl); await page.getByLabel('API Key').fill('test-only-key');
  await page.getByLabel('模型 ID',{exact:true}).fill('test-model');
  await testButton().click(); await page.getByText('连接成功，已找到指定模型。',{exact:true}).waitFor();
  assert.equal(fs.existsSync(path.join(directory,'workspace.json')),false,'testing must not save settings or create a session');
  await page.getByLabel('模型 ID',{exact:true}).fill('missing');
  assert.equal(await page.locator('.connectionresult').count(),0,'edits clear stale test success');
  await testButton().click(); await page.getByRole('alert').filter({hasText:'未找到填写的模型 ID'}).waitFor();
  await page.getByLabel('模型 ID',{exact:true}).fill('test-model');
  await page.getByLabel('API Key').fill('bad-key');
  await testButton().click(); await page.getByRole('alert').filter({hasText:'鉴权失败（401）'}).waitFor();
  await page.getByLabel('API Key').fill('test-only-key');
  await page.getByRole('button',{name:'保存并刷新模型'}).click();
  await page.getByText('连接设置已保存，可在输入区选择模型。',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('API Key').inputValue(),'');
  const before = fs.readFileSync(path.join(directory,'workspace.json'),'utf8');
  assert.ok(!before.includes('test-only-key'));
  await testButton().click(); await page.getByText('连接成功，已找到指定模型。',{exact:true}).waitFor();
  assert.equal(fs.readFileSync(path.join(directory,'workspace.json'),'utf8'),before);
  assert.equal(calls.at(-1).key,'Bearer test-only-key','blank field reuses encrypted stored credential');
  fs.mkdirSync('artifacts',{recursive:true});
  await page.screenshot({path:'artifacts/connection-test-success.png',animations:'disabled'});
  delay = 700;
  await testButton().click(); await page.getByRole('button',{name:'Anthropic',exact:true}).click();
  await page.waitForTimeout(850); assert.equal(await page.locator('.connectionresult').count(),0,'a late response must not appear on a different provider');
  await page.getByRole('button',{name:'自定义',exact:true}).click();
  await testButton().click(); await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await page.getByRole('button',{name:'我的工作空间',exact:true}).click();
  await page.waitForTimeout(850); assert.equal(await page.locator('.connectionresult').count(),0);
  assert.equal(await page.getByLabel('API 地址').inputValue(),baseUrl);
  delay = 50;
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.unmaximize();w.setBounds({x:60,y:60,width:660,height:740});});
  await page.waitForFunction(()=>innerWidth<700);
  assert.ok((await page.evaluate(()=>innerWidth))<700);
  await testButton().click(); await page.getByText('连接成功，已找到指定模型。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('button',{name:'保存并刷新模型'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'artifacts/connection-test-compact.png',animations:'disabled'});
  assert.ok(calls.every(r=>r.method==='GET'&&r.url==='/v1/models'));
  assert.deepEqual(errors,[]);
  console.log('Connection UI passed: no project/save required, success, auth/model failures, encrypted key reuse, stale-result suppression, compact layout.');
} finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
