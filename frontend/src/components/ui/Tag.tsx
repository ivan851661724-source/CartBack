'use client';

import React from 'react';

export type TagKind = 'intent' | 'risk' | 'price' | 'brand' | 'gray' | 'default';

/** 状态标签 —— 对应 .tag .tag-{kind}（含可选圆点 .tdot） */
export default function Tag({
  kind, children, dot = false,
}: {
  kind: TagKind;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`tag tag-${kind}`}>
      {dot && <span className="tdot" />}
      {children}
    </span>
  );
}
