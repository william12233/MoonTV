'use client';

import { useEffect } from 'react';

import { detectStreamingCapability } from '@/lib/stream-saver-fallback';

/**
 * Service Worker 注册组件
 * 用于支持边下边存功能的流式下载
 * 
 * 注意：在 Cloudflare Pages/Vercel/Netlify 等平台上，
 * Service Worker 可能因为构建输出方式不同而无法正常工作。
 * 会自动降级到 File System Access API 或 Blob 方案。
 */
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // 检测流式下载能力
    const cap = detectStreamingCapability();

    // 如果支持 Service Worker，尝试注册
    if (cap.method === 'service-worker') {
      // 先检查 sw.js 是否存在
      fetch('/sw.js', { method: 'HEAD' })
        .then((response) => {
          if (!response.ok) {
            throw new Error('Service Worker 文件不存在');
          }
          
          return navigator.serviceWorker.register('/sw.js', { 
            scope: '/',
            updateViaCache: 'none'
          });
        })
        .then((reg) => {
          // eslint-disable-next-line no-console
          console.log('✅ Service Worker 注册成功，支持完整的边下边存功能');
          
          reg.addEventListener('updatefound', () => {
            // eslint-disable-next-line no-console
            console.log('Service Worker 发现更新');
          });
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('⚠️ Service Worker 注册失败，将使用降级方案:', err.message);
        });
    } else if (cap.method === 'file-system-access') {
      // eslint-disable-next-line no-console
      console.log('✅ 支持 File System Access API，可以使用边下边存功能（Chrome/Edge）');
    } else if (cap.method === 'blob') {
      // eslint-disable-next-line no-console
      console.warn(
        '⚠️ 当前环境使用 Blob 降级方案\n' +
        `限制: ${cap.limitation}\n` +
        '建议：使用 Chrome/Edge 浏览器或本地部署版本以获得更好的下载体验'
      );
    }
  }, []);

  return null;
}
