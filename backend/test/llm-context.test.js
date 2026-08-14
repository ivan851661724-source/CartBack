'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCoachContext, buildCoachMessages, LLMClient } = require('../lib/llm');

test('buildCoachContext returns budget metadata and a durable summary', () => {
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'user', content: `用户第 ${i} 轮，主营跑鞋。` });
    messages.push({ role: 'assistant', content: `助手第 ${i} 轮。` });
  }
  const act = {
    stage: 'S1',
    needs: { audience: '加购未付客户' },
    messages,
    memory: { facts: [], decisions: [], corrections: [] }
  };
  const result = buildCoachContext({
    act,
    userText: '继续',
    needs: act.needs,
    stage: act.stage,
    missing: ['offer'],
    agentProfile: { product: '跑鞋', market: '德国' },
    contextOptions: {
      contextWindowTokens: 5000,
      maxOutputTokens: 240,
      safetyMargin: 160,
      recentTurns: 6
    }
  });

  assert.ok(result.meta.estimatedInputTokens <= result.meta.inputBudgetTokens);
  assert.ok(result.summaryCursor > 0);
  assert.ok(result.messages.some(m => m.content.includes('较早对话摘要')));
  assert.ok(result.messages.some(m => m.content.includes('长期店铺资料') && m.content.includes('德国')));
  assert.equal(result.messages.at(-1).content, '继续');
});

test('buildCoachMessages remains backward compatible and returns an array', () => {
  const messages = buildCoachMessages({
    act: { messages: [], needs: {}, stage: 'S0' },
    userText: '你好', needs: {}, stage: 'S0', missing: ['audience']
  });
  assert.ok(Array.isArray(messages));
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1).content, '你好');
});

test('chatStructured exposes grounded-memory candidates and request count', async () => {
  const client = new LLMClient({ apiKey: 'test' });
  client.complete = async () => ({
    content: JSON.stringify({
      reply: '明白，你卖跑鞋。',
      needs: { audience: '加购未付客户' },
      memory_patch: {
        facts: [{ key: 'product', value: '跑鞋', evidence: '我卖跑鞋' }],
        corrections: []
      },
      profile_patch: { product: { value: '跑鞋', evidence: '我卖跑鞋' } }
    }),
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    raw: {},
    requestAttempts: 1
  });

  const result = await client.chatStructured({ messages: [{ role: 'user', content: '我卖跑鞋' }] });
  assert.equal(result.reply, '明白，你卖跑鞋。');
  assert.equal(result.memoryPatch.facts[0].key, 'product');
  assert.equal(result.profilePatch.product.value, '跑鞋');
  assert.equal(result.requestCount, 1);
});
