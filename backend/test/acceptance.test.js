'use strict';

/**
 * README「6 句验收」自动化（离线桩模式，无网络 / 无 key / 确定性）：
 * 你能干啥啊 / 我老婆不理我 / 我太持久了 / 我不知道啊 / 你人机吗 / 加购没付那拨人想挽回一下
 * 用例本体在 eval/cases/mvp-v1.jsonl（group: acceptance），此处复用 eval runner 执行，
 * 保证「npm test」与「npm run eval:offline」断言同源，不会漂移。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runSuite } = require('../eval/runner');

test('6 句验收：接住 / 拉回 / 无死模板 / 进收集', async () => {
  const suite = await runSuite(path.join(__dirname, '..', 'eval', 'cases', 'mvp-v1.jsonl'));
  const acc = suite.cases.filter(c => c.group === 'acceptance');
  assert.ok(acc.length >= 1, 'mvp-v1.jsonl 应包含 acceptance 组（6 句验收）');
  for (const c of acc) {
    assert.ok(c.ok, `验收用例 ${c.id} 失败:\n  ${c.failures.join('\n  ')}`);
  }
});
