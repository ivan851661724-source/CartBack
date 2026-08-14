'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyAgentProfilePatch,
  applyMemoryPatch,
  buildContext,
  createEmptyMemory,
  estimateMessagesTokens,
  estimateTokens,
  fitMessagesToBudget
} = require('../lib/context');

test('agent profile admits durable facts but rejects temporary offers and PII', () => {
  const result = applyAgentProfilePatch({}, {
    product: { value: '跑鞋', evidence: '我们主要卖跑鞋' },
    default_offer: { value: '8%折扣', evidence: '这次给8%折扣' },
    market: { value: 'alice@example.com', evidence: '邮箱是alice@example.com' }
  }, { userText: '我们主要卖跑鞋，这次给8%折扣，邮箱是alice@example.com。' });

  assert.equal(result.profile.product, '跑鞋');
  assert.equal(result.profile.default_offer, undefined);
  assert.equal(result.profile.market, undefined);
  assert.deepEqual(result.stats, { accepted: 1, rejected: 2 });
});

test('agent profile only replaces a value with explicit grounded correction', () => {
  const rejected = applyAgentProfilePatch({ market: '德国' }, {
    market: { value: '法国', evidence: '现在主要做法国' }
  }, { userText: '现在主要做法国。' });
  assert.equal(rejected.profile.market, '德国');

  const corrected = applyAgentProfilePatch(rejected.profile, {
    market: { value: '法国', evidence: '不是德国，改成法国' },
    constraints: [{ value: '客户邮件不要出现中文', evidence: '以后客户邮件都不要出现中文' }]
  }, { userText: '不是德国，改成法国；以后客户邮件都不要出现中文。' });
  assert.equal(corrected.profile.market, '法国');
  assert.deepEqual(corrected.profile.constraints, ['客户邮件不要出现中文']);
});

test('token estimator treats CJK text conservatively', () => {
  assert.ok(estimateTokens('这是一个用于估算上下文长度的中文句子') >= 16);
  assert.ok(estimateTokens('four short words') >= 4);
});

test('fitMessagesToBudget preserves system and current user message', () => {
  const messages = [
    { role: 'system', content: 'system contract' },
    ...Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `old-${i} ` + 'context '.repeat(30)
    })),
    { role: 'user', content: 'current request must survive' }
  ];
  const fitted = fitMessagesToBudget(messages, {
    contextWindowTokens: 700,
    maxOutputTokens: 120,
    safetyMargin: 80,
    minRecentMessages: 4
  });

  assert.equal(fitted.messages[0].role, 'system');
  assert.equal(fitted.messages.at(-1).content, 'current request must survive');
  assert.ok(fitted.meta.droppedMessages > 0);
  assert.ok(fitted.meta.estimatedInputTokens <= fitted.meta.inputBudgetTokens);
});

test('buildContext compacts old turns and keeps recent raw history', () => {
  const messages = [];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: 'user', content: `第 ${i} 轮用户消息，商品是跑鞋，市场是欧洲。` });
    messages.push({ role: 'assistant', content: `第 ${i} 轮助手回复。` });
  }
  const act = {
    stage: 'S1',
    needs: { audience: '加购未付客户' },
    messages,
    memory: createEmptyMemory(),
    context_summary: null,
    summary_cursor: 0
  };

  const result = buildContext({
    act,
    userText: '继续聊刚才的欧洲跑鞋客户',
    systemPrompt: '你是邮件挽回助手。',
    contextWindowTokens: 1600,
    maxOutputTokens: 240,
    safetyMargin: 160,
    recentTurns: 8,
    summaryTriggerRatio: 0.7
  });

  assert.ok(result.summary);
  assert.ok(result.summaryCursor > 0);
  assert.ok(result.messages.some(m => m.role === 'system' && m.content.includes('较早对话摘要')));
  assert.ok(result.messages.some(m => m.content.includes('第 59 轮用户消息')));
  assert.equal(result.messages.at(-1).content, '继续聊刚才的欧洲跑鞋客户');
  assert.ok(estimateMessagesTokens(result.messages) <= result.meta.inputBudgetTokens);
});

test('model context never starts conversation history with an assistant opening', () => {
  const result = buildContext({
    act: {
      stage: 'S0', needs: {}, memory: createEmptyMemory(),
      messages: [
        { role: 'assistant', content: '后端创建会话时的开场白' },
        { role: 'user', content: '我想挽回弃购客户' },
        { role: 'assistant', content: '可以，继续说说。' }
      ]
    },
    userText: '他们主要是忘了付款',
    systemPrompt: 'system',
    contextWindowTokens: 4096,
    maxOutputTokens: 256,
    safetyMargin: 256
  });
  const firstConversationMessage = result.messages.find(m => m.role !== 'system');
  assert.equal(firstConversationMessage.role, 'user');
  assert.equal(firstConversationMessage.content, '我想挽回弃购客户');
});

test('memory patch only admits facts grounded in the current user message', () => {
  const act = { memory: createEmptyMemory() };
  const stats = applyMemoryPatch(act, {
    facts: [
      { key: 'product', value: '跑鞋', evidence: '我卖跑鞋' },
      { key: 'market', value: '美国', evidence: '我主要做美国市场' },
      { key: 'invented', value: '高端品牌', evidence: '用户没有说过的内容' }
    ],
    decisions: [
      { key: 'send_offer', value: '包邮', evidence: '最终就用包邮' }
    ]
  }, {
    userText: '我卖跑鞋，我主要做美国市场，最终就用包邮。',
    sourceMessageIndex: 12,
    now: 1000
  });

  assert.equal(stats.accepted, 3);
  assert.equal(stats.rejected, 1);
  assert.equal(act.memory.facts.length, 2);
  assert.equal(act.memory.decisions[0].value, '包邮');
  assert.equal(act.memory.facts[0].sourceMessageIndex, 12);

  const conflictingDecision = applyMemoryPatch(act, {
    decisions: [{ key: 'send_offer', value: '跑鞋', evidence: '继续考虑跑鞋' }]
  }, {
    userText: '继续考虑跑鞋。', sourceMessageIndex: 13, now: 2000
  });
  assert.equal(conflictingDecision.accepted, 0);
  assert.equal(act.memory.decisions[0].value, '包邮');
});

test('evidence grounding rejects partial word matches but allows CJK particle 的', () => {
  // "卖雨伞" in "卖雨伞生意" - "雨伞" followed by "生" (CJK, not particle) → reject
  const result1 = applyAgentProfilePatch({}, {
    product: { value: '雨伞', evidence: '卖雨伞' }
  }, { userText: '我卖雨伞生意很好' });
  assert.equal(result1.profile.product, undefined, '"卖雨伞" followed by CJK "生" should be rejected');
  assert.equal(result1.stats.rejected, 1);

  // "卖跑鞋" in "我店主要是卖跑鞋的" - "跑鞋" followed by "的" (CJK particle) → accept
  const result2 = applyAgentProfilePatch({}, {
    product: { value: '跑鞋', evidence: '卖跑鞋' }
  }, { userText: '我店主要是卖跑鞋的' });
  assert.equal(result2.profile.product, '跑鞋', '"卖跑鞋" followed by particle "的" should be accepted');
  assert.equal(result2.stats.accepted, 1);

  // "德国" in "我们主攻德国市场" - followed by "市" (CJK) → should reject
  const result3 = applyAgentProfilePatch({}, {
    market: { value: '德国', evidence: '德国' }
  }, { userText: '我们主攻德国市场' });
  assert.equal(result3.profile.market, undefined, '"德国" followed by CJK "市" should be rejected');

  // Basic substring match still works
  const result4 = applyAgentProfilePatch({}, {
    market: { value: '德国', evidence: '德国' }
  }, { userText: '我们主攻德国。' });
  assert.equal(result4.profile.market, '德国', '"德国" followed by punctuation should be accepted');
});

test('corrections replace facts only when the user explicitly corrects them', () => {
  const act = { memory: createEmptyMemory() };
  applyMemoryPatch(act, {
    facts: [{ key: 'market', value: '美国', evidence: '主要做美国' }]
  }, { userText: '我们主要做美国。', sourceMessageIndex: 1, now: 1000 });

  const rejected = applyMemoryPatch(act, {
    facts: [{ key: 'market', value: '欧洲', evidence: '现在是欧洲' }]
  }, { userText: '现在是欧洲。', sourceMessageIndex: 2, now: 2000 });
  assert.equal(rejected.accepted, 0);
  assert.equal(act.memory.facts.find(f => f.key === 'market').value, '美国');

  const corrected = applyMemoryPatch(act, {
    corrections: [{ key: 'market', value: '欧洲', evidence: '不是美国，改成欧洲' }]
  }, { userText: '不是美国，改成欧洲。', sourceMessageIndex: 3, now: 3000 });
  assert.equal(corrected.accepted, 1);
  assert.equal(act.memory.facts.find(f => f.key === 'market').value, '欧洲');
  assert.equal(act.memory.corrections.length, 1);
});
