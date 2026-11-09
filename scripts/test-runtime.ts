import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeManager } from '../electron/runtime';
import { Store } from '../electron/store';

// Simulate an older installed version only in version comparison. Installation,
// npm registry, process startup, RPC and the permission extension are real.
class OlderRuntime extends RuntimeManager {
  override version(root = this.root) { return root === this.bundled ? '0.0.0' : super.version(root); }
}
const root = process.cwd();
const directory = path.join(root, '.test-data', `runtime-${Date.now()}`);
const store = new Store(directory);
const runtime = new OlderRuntime(path.join(root,'runtime'), process.execPath, path.join(root,'extensions/permissions.mjs'), store, info => console.log(info.message));
let connections = 0;
const reconnect = async () => { connections++; assert.ok(fs.existsSync(runtime.cli())); };
await assert.rejects(runtime.update(() => true, reconnect), /当前任务/);
await runtime.update(() => false, reconnect);
assert.notEqual(runtime.root, runtime.bundled);
assert.equal(runtime.version(), runtime.info().latest);
assert.equal(store.data.previousRuntime, runtime.bundled);
assert.equal(runtime.info().updating, false);
const installed = runtime.root;
await runtime.rollback(() => false, reconnect);
assert.equal(runtime.root, runtime.bundled);
assert.equal(store.data.previousRuntime, installed);
assert.equal(runtime.info().updating, false);
let failedOnce = false;
await assert.rejects(runtime.rollback(() => false, async () => { if (!failedOnce) { failedOnce = true; throw new Error('test reconnect failure'); } }), /test reconnect failure/);
assert.equal(runtime.root, runtime.bundled);
assert.equal(store.data.previousRuntime, installed);
assert.equal(runtime.info().updating, false);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/runtime-test.json', JSON.stringify({ date: new Date().toISOString(), latest: runtime.info().latest, connections, passed: ['busy update rejected', 'actual npm staged install and Pi RPC validation', 'runtime switch preserved previous installation', 'rollback validated and restored previous installation', 'failed reconnect restored previous pointer'], simulation: 'Only the initial installed version comparison is simulated as 0.0.0; network install and Pi verification are real.' }, null, 2));
console.log('Runtime update and rollback acceptance passed.');
