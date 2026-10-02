#!/usr/bin/env node
'use strict';

/**
 * Wave 5 归档脚本：PRD v2 21 句验收回放 → eval/output/acceptance-report.json + 人读摘要（stdout）。
 *
 * 用法：cd backend && node eval/replay21.js   # 一次跑通 exit 0；任何一句失败 exit 1
 *
 * 与 test/acceptance21.test.js 共用同一 harness（lib/acceptance/replay.js）：
 * 输入 = eval/cases/prd-v2.jsonl（21 句全部 in-scope），引擎按句重放脚本化 envelope，
 * 断言打在引擎行为上（B1-B5 / 批次域确定性短轮 / Wave 5 语种越权·闲聊拉回·批次状态汇报）。
 */

const fs = require('fs');
const path = require('path');
const replay = require('../lib/acceptance/replay');

async function main() {
  const rep = await replay.runAll();

  // —— 人读摘要（stdout）——
  console.log('CartBack PRD v2 21 句验收回放（Wave 5 归档）');
  console.log('='.repeat(64));
  for (const r of rep.results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    const expect = (r.expect && r.expect.assert) || '';
    console.log(`${mark}  #${r.id}  ${r.input}`);
    console.log(`      断言：${expect}`);
    if (r.pass) {
      console.log(`      chips=[${(r.chips || []).join(', ')}] stage=${r.stage}`);
    } else {
      for (const f of r.failures) console.log(`      ↳ ${f}`);
    }
  }
  console.log('='.repeat(64));
  console.log(`${rep.passed}/${rep.results.length} passed` + (rep.failed ? `（${rep.failed} 失败）` : '（全部通过）'));

  // —— 机器可读归档（eval/output/acceptance-report.json，每次覆盖）——
  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    suite: 'prd-v2-acceptance-21',
    generatedAt: new Date().toISOString(),
    source: 'eval/cases/prd-v2.jsonl',
    total: rep.results.length,
    passed: rep.passed,
    failed: rep.failed,
    deferred_remaining: 0,
    final_state: {
      act_id: rep.act.id,
      stage: rep.act.stage,
      filled_count: rep.act.filled_count,
      extras: rep.act.memory.extras,
      needs: Object.fromEntries(Object.entries(rep.act.needs).map(([k, v]) => [k, v && typeof v === 'object' ? v.value : v]))
    },
    cases: rep.results.map(r => ({
      id: r.id,
      input: r.input,
      pass: r.pass,
      failures: r.failures,
      chips: r.chips,
      stage: r.stage,
      expect_assert: (r.expect && r.expect.assert) || ''
    }))
  };
  const outFile = path.join(outDir, 'acceptance-report.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('report → ' + path.relative(process.cwd(), outFile));

  process.exit(rep.failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
