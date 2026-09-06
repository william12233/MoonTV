import { Suspense } from 'react';

import PlayClient from './PlayClient';

/**
 * 播放页入口。
 *
 * 完整逻辑已拆分至同目录下的 usePlayEngine / PlayClient 及
 * components / hooks / play-utils 模块，此文件仅保留 Suspense 包装。
 */
export default function PlayPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlayClient />
    </Suspense>
  );
}
