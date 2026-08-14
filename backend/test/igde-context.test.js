'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { IGDE } = require('../lib/igde');

function longAct(turns = 40) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `第 ${i} 轮：继续讨论弃购客户。` });
    messages.push({ role: 'assistant', content: `第 ${i} 轮：明白。` });
  }
  return {
    id: 'act_long', stage: 'S1', needs: {}, messages,
    memory: { facts: [], decisions: [], corrections: [] },
    context_summary: null, summary_cursor: 0, context_version: 1
  };
}

test('long conversations compact, persist summary, and admit grounded memory', async () => {
  let capturedMessages;
  const igde = new IGDE({
    aiEnabled: true,
    contextOptions: {
      contextWindowTokens: 6000,
      maxOutputTokens: 512,
      safetyMargin: 512,
      recentTurns: 6,
      summaryTriggerRatio: 0.7
    },
    callAI: async (messages) => {
      capturedMessages = messages;
      return {
        reply: '明白，你卖跑鞋。',
        needs: {},
        memoryPatch: {
          facts: [{ key: 'product', value: '跑鞋', evidence: '我卖跑鞋' }],
          corrections: []
        },
        usage: { prompt_tokens: 800, completion_tokens: 30, total_tokens: 830 },
        requestCount: 1,
        jsonOk: true
      };
    }
  });
  const act = longAct();
  const result = await igde.handle(act, '我卖跑鞋', { locale: 'en' });

  assert.ok(capturedMessages.some(m => m.content.includes('较早对话摘要')));
  assert.ok(act.summary_cursor > 0);
  assert.ok(act.context_summary);
  assert.equal(act.memory.facts.find(f => f.key === 'product').value, '跑鞋');
  assert.equal(result.agentMeta.llmCalls, 1);
  assert.equal(result.agentMeta.providerRequests, 1);
  assert.equal(result.agentMeta.memoryAccepted, 1);
  assert.ok(result.agentMeta.context.compacted);
});

test('confirmed needs only change after an explicit user correction', () => {
  const igde = new IGDE();
  const act = { needs: { audience: '加购未付客户' } };

  igde.applyNeeds(act, { audience: '沉睡老客' }, '顺便说说沉睡老客');
  assert.equal(act.needs.audience, '加购未付客户');

  igde.applyNeeds(act, { audience: '沉睡老客' }, '不是加购客户，改成沉睡老客');
  assert.equal(act.needs.audience, '沉睡老客');
});

test('agent profile is recalled and a grounded profile patch stays internal', async () => {
  let capturedMessages;
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async (messages) => {
      capturedMessages = messages;
      return {
        reply: '明白，以后按年轻直接的调性来。',
        needs: {}, memoryPatch: {}, requestCount: 1,
        profilePatch: {
          brand_tone: { value: '年轻直接', evidence: '品牌调性是年轻直接' }
        }
      };
    }
  });
  const act = { stage: 'S0', needs: {}, messages: [] };
  const result = await igde.handle(act, '品牌调性是年轻直接', {
    agentProfile: { product: '跑鞋', market: '德国' }
  });

  assert.ok(capturedMessages.some(message => message.content.includes('长期店铺资料') && message.content.includes('跑鞋')));
  assert.equal(result.agentMeta.profileAccepted, 1);
  assert.deepEqual(result.agentMeta.agentProfile, {
    product: '跑鞋', market: '德国', brand_tone: '年轻直接'
  });
  assert.equal('profilePatch' in result, false);
});

test('a correction only changes the field explicitly mentioned by the user', () => {
  const igde = new IGDE();
  const act = {
    needs: {
      audience: '加购未付客户', pain: '运费顾虑',
      goal: '促成付款', offer: '9折优惠'
    }
  };
  igde.applyNeeds(act, {
    audience: '模型重述后的受众', pain: '模型重述后的痛点',
    goal: '模型重述后的目标', offer: '包邮'
  }, '折扣改成包邮，其他不变');

  assert.deepEqual(act.needs, {
    audience: '加购未付客户', pain: '运费顾虑',
    goal: '促成付款', offer: '包邮'
  });
});

test('offline extraction understands Chinese discount numerals', () => {
  const { extractNeeds } = require('../lib/igde');
  assert.equal(extractNeeds('给九折优惠').offer, '9折优惠');
  assert.equal(extractNeeds('改成八折').offer, '8折优惠');
  assert.equal(extractNeeds('这次不要任何折扣优惠').offer, '无额外优惠');
  assert.equal(extractNeeds('本次不用优惠券').offer, '无额外优惠');
});

test('remembered default offer fills a new task but an explicit offer wins', async () => {
  const igde = new IGDE();
  const withDefault = { stage: 'S0', needs: {}, messages: [] };
  await igde.handle(withDefault, '加购未付客户忘了付款，希望回来完成结账', {
    agentProfile: { default_offer: '8%折扣' }
  });
  assert.equal(withDefault.needs.offer, '8%折扣');

  const overridden = { stage: 'S0', needs: {}, messages: [] };
  await igde.handle(overridden, '加购未付客户忘了付款，希望回来完成结账，这次给9折优惠', {
    agentProfile: { default_offer: '8%折扣' }
  });
  assert.equal(overridden.needs.offer, '9折优惠');
});

test('short safe replies skip critic while suspicious long replies invoke it', async () => {
  let criticCalls = 0;
  let reply = '好，先说最想挽回哪拨人？';
  const igde = new IGDE({
    aiEnabled: true,
    criticMode: 'suspicious',
    callAI: async () => ({ reply, needs: {}, memoryPatch: {}, requestCount: 1 }),
    callCritic: async () => { criticCalls++; return true; }
  });

  await igde.handle({ stage: 'S0', needs: {}, messages: [] }, '想做邮件挽回');
  assert.equal(criticCalls, 0);

  reply = '这件事可以继续讨论，下面我会给你一些比较完整的分析。'.repeat(10);
  await igde.handle({ stage: 'S0', needs: {}, messages: [] }, '想做邮件挽回');
  assert.equal(criticCalls, 1);
});
