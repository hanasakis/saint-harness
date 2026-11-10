import test from 'node:test';
import assert from 'node:assert/strict';
import { branchEntries, partitionBranchMessages, quotedPrompt, withEntryIds, type TreeEntry } from '../shared/selection';

test('selection node identity follows the active Pi branch even when replies repeat', () => {
  const message = { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: '重复回答' }] };
  const entries: TreeEntry[] = [
    { id: 'root', parentId: null, type: 'model_change' },
    { id: 'abandoned', parentId: 'root', type: 'message', message },
    { id: 'active', parentId: 'root', type: 'message', message },
    { id: 'later', parentId: 'active', type: 'message', message: { ...message, timestamp: 2 } },
  ];
  assert.deepEqual(branchEntries(entries, 'later').map(e => e.id), ['root','active','later']);
  assert.deepEqual(withEntryIds([message, { ...message, timestamp: 2 }], entries, 'later').map(m => m.entryId), ['active','later']);
  assert.equal(withEntryIds([{ role:'assistant',content:'尚未保存' }], entries, 'later')[0].entryId, undefined);
  assert.throws(() => branchEntries([{ id:'loop',parentId:'loop',type:'message' }], 'loop'), /不完整/);
});
test('quoted prompt uses only exact selections and keeps the user draft', () => {
  const text = '  已选中的第一行\n第二行。  ';
  assert.equal(quotedPrompt('已有草稿', [{ threadId:'parent',entryId:'node',title:'来源',text }]), '引用选区（来源）：\n>   已选中的第一行\n> 第二行。  \n\n已有草稿');
  assert.equal(quotedPrompt('普通消息', []), '普通消息');
});
test('compaction of inherited history never hides the side conversation replies', () => {
  const projected = [{role:'user',entryId:'last-ancestor',content:'此前的问题'}, {role:'assistant',content:'压缩摘要'}, {role:'user',entryId:'side-question',content:'侧边问题'}, {role:'assistant',entryId:'side-answer',content:'侧边回答'}];
  const result=partitionBranchMessages(projected,['older-ancestor','last-ancestor']);
  assert.deepEqual(result.inherited.map(m=>m.entryId),['last-ancestor']);
  assert.deepEqual(result.own.map(m=>m.content),['压缩摘要','侧边问题','侧边回答']);
});
