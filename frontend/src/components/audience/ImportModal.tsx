'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/state/AppProvider';
import Modal from '@/components/ui/Modal';

/** 导入弹窗：粘贴 CSV 名单（姓名,邮箱,意向,风险,价格敏,弃购额）—— 对应 #importModal + doImport。 */
export default function ImportModal() {
  const { importOpen, setImportOpen, doImport } = useApp();
  const [csv, setCsv] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (importOpen) { setCsv(''); setMsg(''); setErr(false); }
  }, [importOpen]);

  const onSubmit = async () => {
    const ok = await doImport(csv);
    if (!ok) { setMsg('导入失败，请检查格式'); setErr(true); }
  };

  return (
    <Modal open={importOpen} onClose={() => setImportOpen(false)} title="导入高意向访客">
      <div className="m-body">
        <p>粘贴访客清单，每行一个，格式：<b>姓名,邮箱,意向,风险,价格敏,弃购额</b>。</p>
        <textarea
          spellCheck={false}
          placeholder={'name,email,intent,risk,price,abandoned_value\n张三,zhang@x.com,弃购,高,中,860'}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
      </div>
      <div className="m-foot">
        <button className="btn primary" onClick={onSubmit}>解析并导入</button>
        {msg && <span className={`msg${err ? ' err' : ''}`}>{msg}</span>}
      </div>
    </Modal>
  );
}
