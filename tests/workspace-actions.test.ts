import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../electron/store';
import { WorkspaceActions, threadLink, threadIdFromLink } from '../electron/workspace-actions';
import type { Snapshot } from '../shared/types';

test('moving keeps the JSONL history and source intact, changes cwd, and restores selection after a connection failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saint-move-'));
  try {
    const a = path.join(dir, '原项目'), b = path.join(dir, '目标项目'); fs.mkdirSync(a); fs.mkdirSync(b);
    const store = new Store(path.join(dir, 'data')); const source = store.addProject(a), target = store.addProject(b); const thread = store.addThread(source.id);
    const original = path.join(dir, 'history.jsonl'); const history = '\n{"type":"message","message":{"role":"user","content":"保留中文历史"}}\n';
    fs.writeFileSync(original, JSON.stringify({ type: 'session', id: 'pi-original', cwd: a, version: 3 }) + history); thread.sessionFile = original; store.save();
    const sessions = { async connect() { return {} as Snapshot; }, async detach() { store.data.activeThreadId = undefined; } };
    const workspace = new WorkspaceActions(store, sessions, () => {});
    await workspace.move(thread.id, target.id);
    assert.equal(thread.projectId, target.id); assert.notEqual(thread.sessionFile, original);
    const moved = fs.readFileSync(thread.sessionFile!, 'utf8'); assert.equal(moved.slice(moved.indexOf('\n')), history);
    assert.equal(JSON.parse(moved.split('\n')[0]).cwd, b); assert.equal(JSON.parse(fs.readFileSync(original, 'utf8').split('\n')[0]).cwd, a);
    const successfulPath = thread.sessionFile;
    let reconnects = 0; sessions.connect = async () => { if (++reconnects === 1) throw new Error('模拟引擎无法连接'); return {} as Snapshot; };
    await assert.rejects(workspace.move(thread.id, source.id), /模拟引擎/);
    assert.equal(thread.projectId, target.id); assert.equal(thread.sessionFile, successfulPath); assert.equal(reconnects, 2);
    assert.equal(new Store(store.directory).thread(thread.id).projectId, target.id);
    await workspace.archive('project', target.id); assert.ok(target.archivedAt); assert.equal(store.data.activeThreadId, undefined); assert.ok(fs.existsSync(successfulPath!));
    workspace.restore('project', target.id); assert.equal(target.archivedAt, undefined);
    await workspace.archive('thread', thread.id); await workspace.archive('project', target.id); workspace.restore('thread', thread.id);
    assert.equal(thread.archivedAt, undefined); assert.equal(target.archivedAt, undefined); assert.equal(store.data.threads.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('session links accept only a local thread locator', () => {
  assert.equal(threadIdFromLink(threadLink('example-thread-id')), 'example-thread-id');
  for (const value of ['https://threads/id', 'saint-harness://other/id', 'saint-harness://user@threads/id', 'saint-harness://threads/id?run=x', 'saint-harness://threads/id#x', 'saint-harness://threads/%2E%2E/file']) assert.throws(() => threadIdFromLink(value));
});
