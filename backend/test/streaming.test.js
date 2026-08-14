'use strict';

/**
 * 真流式 #1 测试：
 * 1. createReplyStreamExtractor —— 逐 chunk 喂入流式 JSON envelope，断言增量反转义输出；
 * 2. IGDE onReplyToken 线程化 —— 假 callAI 收到 {onReplyToken} 并逐段回调，handle 正常收敛；
 * 3. callAI 不带 opts 时行为与旧签名完全一致（向后兼容注入方）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReplyStreamExtractor } = require('../lib/llm');
const { IGDE } = require('../lib/igde');

test('提取器：reply 在前，逐 chunk 增量流出已反转义文本', () => {
  const pieces = [];
  const ex = createReplyStreamExtractor(p => pieces.push(p));
  const full = JSON.stringify({ reply: '先接住，再问目标。', needs: { audience: '加购未付' } });
  // 按 5 字符切块喂入，模拟 SSE 边界任意切
  for (let i = 0; i < full.length; i += 5) ex.feed(full.slice(i, i + 5));
  assert.equal(pieces.join(''), '先接住，再问目标。');
});

test('提取器：转义（\\n \\" \\\\ \\uXXXX）按 JSON 语义反转义，\\u 跨 chunk 拆分安全', () => {
  const pieces = [];
  const ex = createReplyStreamExtractor(p => pieces.push(p));
  const body = '第一行\\n第二行 \\"引号\\" 反斜杠\\\\ 笑脸\\uD83D\\uDE00';
  const full = '{"reply":"' + body + '"}';
  for (let i = 0; i < full.length; i += 3) ex.feed(full.slice(i, i + 3));
  assert.equal(pieces.join(''), '第一行\n第二行 "引号" 反斜杠\\ 笑脸😀');
});

test('提取器：正文里出现 "reply" 字样但不是键 → 跳过，仍找到真键', () => {
  const pieces = [];
  const ex = createReplyStreamExtractor(p => pieces.push(p));
  const full = '{"reply":"好的，\\"reply\\" 不是键，你说的对：继续。","needs":{}}';
  // 正文中转义过的 "reply" 片段会被命中再回退到扫描态，最终只流出真键的值
  ex.feed(full);
  assert.equal(pieces.join(''), '好的，"reply" 不是键，你说的对：继续。');
});

test('提取器：输出不含 reply 字符串键 → 一个 token 都不流（上层走全量解析兜底）', () => {
  const pieces = [];
  const ex = createReplyStreamExtractor(p => pieces.push(p));
  ex.feed('抱歉，我只是个直出文本的模型，没有结构化。');
  assert.equal(pieces.length, 0);
});

test('提取器：闭引号后 done，后续 feed 不再产出', () => {
  const pieces = [];
  const ex = createReplyStreamExtractor(p => pieces.push(p));
  ex.feed('{"reply":"短话","needs":{"a":1}}');
  ex.feed('尾部多余 chunk');
  assert.equal(pieces.join(''), '短话');
  assert.equal(ex.done, true);
});

test('IGDE 线程化：handle 传 onReplyToken → callAI 收到 {onReplyToken} 且回调逐段到达', async () => {
  let receivedOpts = 'unset';
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async (messages, opts) => {
      receivedOpts = opts;
      // 模拟流式 coach：先逐段推预览，再返回结构化结果（与 streamChatStructured 语义一致）
      if (opts && typeof opts.onReplyToken === 'function') {
        opts.onReplyToken('先接');
        opts.onReplyToken('住，再问');
        opts.onReplyToken('目标。');
      }
      return {
        reply: '先接住，再问目标。',
        needs: { audience: '加购未付', pain: '忘了结账', goal: '完成付款', offer: '9折' },
        memoryPatch: { facts: [], decisions: [], corrections: [] },
        profilePatch: {}
      };
    }
  });
  const pieces = [];
  const act = { id: 'act_t1', stage: 'S0', needs: {}, messages: [], memory: null };
  const r = await igde.handle(act, '加购未付客户忘了结账，希望完成付款，给9折', { onReplyToken: p => pieces.push(p) });
  assert.equal(receivedOpts && typeof receivedOpts.onReplyToken, 'function', 'callAI 应收到 {onReplyToken}');
  assert.equal(pieces.join(''), '先接住，再问目标。');
  assert.equal(r.reply, '先接住，再问目标。');
  assert.equal(r.needs.audience, '加购未付', 'needs patch 应生效');
  assert.notEqual(r.stage, 'S0', '有业务上下文应离开 S0');
});

test('IGDE 线程化：不传 onReplyToken 时 callAI 第二参为 undefined（旧注入零改动）', async () => {
  let receivedOpts = 'unset';
  const igde = new IGDE({
    aiEnabled: true,
    callAI: async (messages, opts) => {
      receivedOpts = opts;
      return { reply: '收到。', needs: {}, memoryPatch: { facts: [], decisions: [], corrections: [] }, profilePatch: {} };
    }
  });
  const act = { id: 'act_t2', stage: 'S0', needs: {}, messages: [], memory: null };
  await igde.handle(act, '我想挽回弃购客户');
  assert.equal(receivedOpts, undefined);
});
