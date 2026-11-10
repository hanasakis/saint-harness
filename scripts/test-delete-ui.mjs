import { _electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const root = process.cwd(), data = path.join(root, '.test-data', `delete-ui-${Date.now()}`);
const projectPath = path.join(data, '原始项目文件夹'), retainedPath = path.join(data, '保留项目');
for (const p of [projectPath, retainedPath]) fs.mkdirSync(p, { recursive: true });
const original = path.join(projectPath, '不要删除.txt'); fs.writeFileSync(original, 'original user file');
const project = { id: randomUUID(), name: 'tmp', path: projectPath, trusted: false, archivedAt: Date.now() };
const retained = { id: randomUUID(), name: '保留项目', path: retainedPath, trusted: false };
function thread(projectId, title, archived = true) {
  const id = randomUUID(), file = path.join(data, 'sessions', projectId, id + '.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: projectPath }) + '\n');
  return { id, projectId, title, sessionFile: file, createdAt: Date.now(), updatedAt: Date.now(), ...(archived ? { archivedAt: Date.now() } : {}) };
}
const single = thread(retained.id, '单独删除的会话');
const children = [thread(project.id, '随项目删除 1', false), thread(project.id, '随项目删除 2')];
const survivor = thread(retained.id, '保留的会话', false);
const index = path.join(data, 'workspace.json');
fs.writeFileSync(index, JSON.stringify({ projects: [project, retained], threads: [single, ...children, survivor], settings: { access: 'auto', autoCheck: false, autoUpdate: false, providers: [] }, skillPaths: [], secrets: {} }));
let app; const errors = [], results = [];
const state = page => page.evaluate(() => window.saint.invoke('bootstrap'));
async function launch() {
  app = await _electron.launch({ ...(process.env.SAINT_TEST_EXE ? { executablePath: process.env.SAINT_TEST_EXE, args: [] } : { args: [root] }), env: { ...process.env, SAINT_DATA_DIR: data } });
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.getByRole('button', { name: /已归档/ }).waitFor(); return page;
}
try {
  let page = await launch();
  await assert.rejects(page.evaluate(id => window.saint.invoke('thread.delete', { id }), single.id));
  await assert.rejects(page.evaluate(id => window.saint.invoke('thread.delete', { id, confirmed: true }), survivor.id), /先归档/);
  assert.ok(fs.existsSync(single.sessionFile)); assert.ok(fs.existsSync(survivor.sessionFile));
  await page.getByRole('button', { name: /已归档/ }).click();
  const deleteSingle = () => page.getByRole('button', { name: '永久删除会话 单独删除的会话', exact: true });
  await deleteSingle().click(); await page.getByRole('dialog', { name: '永久删除会话？' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click(); assert.ok(fs.existsSync(single.sessionFile));
  await deleteSingle().click(); await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '已归档', exact: true }).waitFor();
  assert.equal((await state(page)).threads.length, 4);
  results.push('confirmation required; cancel/Escape leave data untouched; unarchived records cannot be deleted');
  fs.mkdirSync('artifacts', { recursive: true });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setBounds({ x: 50, y: 50, width: 660, height: 740 }); });
  await page.waitForFunction(() => innerWidth === 660);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'artifacts/archive-delete-compact.png', animations: 'disabled' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 950));
  await deleteSingle().click(); await page.getByRole('button', { name: '永久删除会话', exact: true }).click();
  await page.getByRole('dialog', { name: '已归档', exact: true }).waitFor();
  assert.ok(!fs.existsSync(single.sessionFile)); assert.ok(!(await state(page)).threads.some(t => t.id === single.id));
  assert.ok(children.every(t => fs.existsSync(t.sessionFile))); assert.ok(fs.existsSync(survivor.sessionFile));
  results.push('thread button deletes only its archived session and leaves the project and other sessions intact');
  await page.getByRole('button', { name: '永久删除项目 tmp', exact: true }).click();
  await page.getByText('此项目及其当前所属的 2 条会话', { exact: true }).waitFor();
  await page.getByText(projectPath, { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/archive-project-delete-confirm.png', animations: 'disabled' });
  // If the item was restored after opening confirmation, main must reject deletion.
  await page.evaluate(id => window.saint.invoke('project.restore', { id }), project.id);
  await page.getByRole('button', { name: '永久删除项目', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '只能永久删除已归档' }).waitFor();
  assert.ok(children.every(t => fs.existsSync(t.sessionFile)));
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(id => window.saint.invoke('project.archive', { id }), project.id);
  await page.getByRole('button', { name: '永久删除项目 tmp', exact: true }).click();
  await page.getByRole('button', { name: '永久删除项目', exact: true }).click();
  await page.getByRole('dialog', { name: '已归档', exact: true }).waitFor();
  await page.getByText('还没有归档内容。', { exact: true }).waitFor();
  assert.ok(children.every(t => !fs.existsSync(t.sessionFile))); assert.ok(fs.existsSync(survivor.sessionFile));
  assert.equal(fs.readFileSync(original, 'utf8'), 'original user file');
  assert.deepEqual((await state(page)).projects.map(p => p.id), [retained.id]);
  results.push('project deletion revalidates archive state, cascades two current sessions, and preserves the original directory and other project');
  await app.close(); app = undefined; page = await launch();
  assert.deepEqual((await state(page)).threads.map(t => t.id), [survivor.id]);
  await assert.rejects(page.evaluate(id => window.saint.invoke('thread.openLink', { link: `saint-harness://threads/${id}` }), single.id), /此设备没有/);
  await page.getByRole('button', { name: /已归档/ }).click(); await page.getByText('还没有归档内容。', { exact: true }).waitFor();
  assert.deepEqual(errors, []); results.push('deletion survives restart, old links fail clearly, compact layout and renderer are healthy');
  fs.writeFileSync('artifacts/delete-test.json', JSON.stringify({ date: new Date().toISOString(), packaged: !!process.env.SAINT_TEST_EXE, results, errors }, null, 2));
  console.log(JSON.stringify({ passed: results }, null, 2));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: 'artifacts/delete-failure.png' }).catch(() => {});
  throw error;
} finally { if (app) await app.close(); }
