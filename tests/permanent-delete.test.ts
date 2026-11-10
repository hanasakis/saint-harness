import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../electron/store';
import { permanentlyDelete } from '../electron/permanent-delete';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saint-delete-'));
  const projectPath = path.join(root, '原始项目'); fs.mkdirSync(projectPath);
  const store = new Store(path.join(root, 'data')), project = store.addProject(projectPath);
  const session = (group: string, name: string, piId: string, attachments: string[] = []) => {
    const file = path.join(store.directory, 'sessions', group, name + '.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'session', id: piId, cwd: projectPath }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: attachments.map(localPath => `<attachment>\n${JSON.stringify({ name: '测试附件', localPath })}\n</attachment>`).join('\n') } }) + '\n'); return file;
  };
  const attachment = (name: string) => { const file = path.join(store.directory, 'attachments', name, 'file.bin'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name); return file; };
  const cleanup = () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, store, project, projectPath, session, attachment, cleanup };
}

test('delete archived thread removes history and migration copies, cleans exclusive attachments and preserves shared files', async () => {
  const f = fixture();
  try {
    const image = f.attachment('image'), legacy = f.attachment('legacy'), shared = f.attachment('shared');
    const target = f.store.addThread(f.project.id), other = f.store.addThread(f.project.id);
    target.sessionFile = f.session(f.project.id, 'target', 'target-pi', [legacy, shared]); target.attachmentPaths = [image]; target.archivedAt = Date.now();
    const oldCopy = f.session('old-project', 'before-move', 'target-pi', [legacy]);
    other.sessionFile = f.session(f.project.id, 'other', 'other-pi', [shared]);
    const empty = f.store.addThread(f.project.id); empty.sessionFile = path.join(f.store.directory, 'sessions', f.project.id, 'never-written.jsonl');
    f.store.save();
    await permanentlyDelete(f.store, 'thread', target.id);
    assert.ok(!fs.existsSync(target.sessionFile)); assert.ok(!fs.existsSync(oldCopy));
    assert.ok(!fs.existsSync(image)); assert.ok(!fs.existsSync(legacy)); assert.ok(fs.existsSync(shared)); assert.ok(fs.existsSync(other.sessionFile));
    assert.equal(new Store(f.store.directory).data.threads.length, 2); assert.ok(fs.existsSync(f.projectPath));
  } finally { f.cleanup(); }
});

test('deleting an archived project cascades current threads and preserves migrated-out sessions and original project files', async () => {
  const f = fixture();
  try {
    const otherPath = path.join(f.root, '其他项目'); fs.mkdirSync(otherPath); const otherProject = f.store.addProject(otherPath);
    const target = f.store.addThread(f.project.id), migrated = f.store.addThread(otherProject.id);
    target.sessionFile = f.session(f.project.id, 'target', 'target');
    const oldMigrated = f.session(f.project.id, 'original-migrated', 'migrated');
    migrated.sessionFile = f.session(otherProject.id, 'migrated', 'migrated');
    const document = path.join(f.projectPath, 'keep.txt'); fs.writeFileSync(document, 'user content');
    f.project.archivedAt = Date.now(); f.store.save();
    await permanentlyDelete(f.store, 'project', f.project.id);
    assert.equal(f.store.data.projects.length, 1); assert.deepEqual(f.store.data.threads.map(t => t.id), [migrated.id]);
    assert.ok(!fs.existsSync(target.sessionFile)); assert.ok(fs.existsSync(oldMigrated)); assert.ok(fs.existsSync(migrated.sessionFile));
    assert.equal(fs.readFileSync(document, 'utf8'), 'user content');
    assert.equal(new Store(f.store.directory).data.projects[0].id, otherProject.id);
  } finally { f.cleanup(); }
});

test('deletion rejects live records and escaping/junction paths without changing the index or original files', async () => {
  const f = fixture();
  try {
    const target = f.store.addThread(f.project.id); f.store.data.activeThreadId = undefined; f.store.save();
    await assert.rejects(permanentlyDelete(f.store, 'thread', target.id), /先归档/);
    await assert.rejects(permanentlyDelete(f.store, 'project', f.project.id), /先归档/);
    target.archivedAt = Date.now(); f.store.data.activeThreadId = target.id;
    await assert.rejects(permanentlyDelete(f.store, 'thread', target.id), /使用中/);
    f.store.data.activeThreadId = undefined;
    const outside = path.join(f.projectPath, 'original.jsonl'); fs.writeFileSync(outside, '{"type":"session","id":"original"}\n');
    target.sessionFile = outside; f.store.save();
    await assert.rejects(permanentlyDelete(f.store, 'thread', target.id), /超出/);
    const junction = path.join(f.store.directory, 'sessions', 'escape'); fs.mkdirSync(path.dirname(junction), { recursive: true }); fs.symlinkSync(f.projectPath, junction, 'junction');
    target.sessionFile = path.join(junction, 'original.jsonl'); f.store.save();
    await assert.rejects(permanentlyDelete(f.store, 'thread', target.id), /之外/);
    assert.ok(fs.existsSync(outside)); assert.equal(new Store(f.store.directory).data.threads.length, 1);
    fs.unlinkSync(junction);
  } finally { f.cleanup(); }
});

test('a locked file keeps the archived entry retryable; shared session files are never unlinked', async t => {
  const f = fixture();
  try {
    const target = f.store.addThread(f.project.id); target.archivedAt = Date.now(); f.store.data.activeThreadId = undefined;
    target.sessionFile = f.session(f.project.id, 'locked', 'locked'); f.store.save();
    const original = fs.promises.unlink;
    const mock = t.mock.method(fs.promises, 'unlink', async (file: fs.PathLike) => { if (file === target.sessionFile) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return original(file); });
    await assert.rejects(permanentlyDelete(f.store, 'thread', target.id), /归档条目已保留/);
    assert.equal(new Store(f.store.directory).data.threads.length, 1); assert.ok(fs.existsSync(target.sessionFile));
    mock.mock.restore();
    await permanentlyDelete(f.store, 'thread', target.id); assert.ok(!fs.existsSync(target.sessionFile));
    const shared = f.store.addThread(f.project.id); shared.sessionFile = f.session(f.project.id, 'shared', 'shared'); shared.archivedAt = Date.now();
    const other = f.store.addThread(f.project.id); other.sessionFile = shared.sessionFile; f.store.save();
    await permanentlyDelete(f.store, 'thread', shared.id);
    assert.ok(fs.existsSync(other.sessionFile)); assert.equal(new Store(f.store.directory).data.threads.length, 1);
  } finally { f.cleanup(); }
});
