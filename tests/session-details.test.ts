import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheHitRate } from '../shared/usage';
import { cleanTitle, titleConversation } from '../electron/session-title';

test('cache ratio uses cumulative input only, including cache writes', () => {
  assert.equal(cacheHitRate({tokens:{input:20,output:900,cacheRead:80,cacheWrite:0,total:1000},cost:0}),80);
  assert.equal(cacheHitRate({tokens:{input:20,output:5,cacheRead:60,cacheWrite:20,total:105},cost:0}),60);
  assert.equal(cacheHitRate({tokens:{input:10,output:0,cacheRead:0,cacheWrite:0,total:10},cost:0}),0);
  assert.equal(cacheHitRate({tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},cost:0}),undefined);
  assert.equal(cacheHitRate(),undefined);
  assert.equal(cacheHitRate({tokens:{input:0,output:0,cacheRead:NaN,cacheWrite:0,total:0},cost:0}),undefined);
});
test('titles discard hidden reasoning and wrappers and reject unusable responses', () => {
  assert.equal(cleanTitle('<think>分析</think>\n标题：“项目结构分析”'), '项目结构分析');
  assert.equal(cleanTitle('优化缓存统计\n第二行解释'), '优化缓存统计');
  assert.throws(()=>cleanTitle(''));assert.throws(()=>cleanTitle('<html>error</html>'));assert.throws(()=>cleanTitle('x'.repeat(101)));
});
test('title context includes both participants, excludes tools and appended attachments', () => {
  const context=titleConversation([{role:'user',content:'分析项目\n\n<attachment>\nPRIVATE FILE CONTENT\n</attachment>'},{role:'toolResult',content:[{type:'text',text:'TOOL DATA'}]},{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE REASONING'},{type:'text',text:'已经整理结构'}]}]);
  assert.ok(context.includes('user: 分析项目'));assert.ok(context.includes('assistant: 已经整理结构'));
  assert.ok(!context.includes('PRIVATE'));assert.ok(!context.includes('TOOL DATA'));
});
