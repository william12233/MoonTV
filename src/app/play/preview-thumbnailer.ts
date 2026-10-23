/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

/**
 * 进度条悬停预览的抽帧器。
 *
 * 用一个独立的隐藏 <video>（复用自己的 hls.js 实例，loader 与主播放器保持一致，
 * 因此分片请求同样优先命中 Cache Storage / 同源代理）在悬停时 seek 到目标时间，
 * 再用 canvas 截取当前帧返回 dataURL。不依赖任何后端预生成雪碧图。
 */
export class PreviewThumbnailer {
  private video: HTMLVideoElement | null = null;
  private hls: any = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private disposed = false;
  private manifestReady = false;
  private sourceUrl = '';
  private events: any = null;
  private cancelCapture: (() => void) | null = null;
  private thumbnails = new Map<string, string>();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
  }

  /**
   * 绑定新的视频源（切集 / 换源后调用）。
   *
   * - `Hls`：hls.js 构造器（与主播放器同一个动态加载模块）。
   * - `loader`：与主播放器相同的「去广告 + 缓存优先」Loader，保证预览分片同样命中缓存。
   */
  load(url: string, Hls: any, loader: any): void {
    this.destroy();
    // destroy() 会把 disposed 置为 true，这里要复原，否则 capture() 会在首行被 disposed 拦截直接返回 null
    this.disposed = false;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.cssText =
      'position:absolute;width:2px;height:2px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
    video.setAttribute('aria-hidden', 'true');
    document.body.appendChild(video);
    this.video = video;

    const hls = new Hls({
      enableWorker: true, // 后台处理预览分片，缓存 loader 仍在主线程运行
      lowLatencyMode: false,
      autoStartLoad: false,
      maxBufferLength: 1,
      maxMaxBufferLength: 2,
      maxBufferSize: 2 * 1000 * 1000,
      backBufferLength: 15,
      loader,
    });
    this.hls = hls;
    this.events = Hls.Events;
    this.sourceUrl = url;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.manifestReady = true;
    });
    hls.attachMedia(video);
    // 播放列表也延迟到首次抽帧请求，取消后可重新加载。
  }

  /** 悬停到目标时间点，返回该处帧的 JPEG dataURL；失败 / 超时返回 null。 */
  async capture(time: number): Promise<string | null> {
    this.cancel();
    const video = this.video;
    const hls = this.hls;
    if (!video || !hls || !this.ctx || this.disposed || !Number.isFinite(time)) {
      return null;
    }
    const target = Math.max(
      0,
      Number.isFinite(video.duration)
        ? Math.min(time, Math.max(0, video.duration - 0.05))
        : time
    );
    const key = target.toFixed(1);
    const cached = this.thumbnails.get(key);
    if (cached) return cached;

    return new Promise<string | null>((resolve) => {
      let settled = false;
      let loading = false;
      const mediaEvents = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked'];
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        mediaEvents.forEach((event) => video.removeEventListener(event, onReady));
        video.removeEventListener('error', onError);
        hls.off(this.events.MANIFEST_PARSED, startLoading);
        hls.off(this.events.ERROR, onHlsError);
        this.cancelCapture = null;
        video.pause();
        hls.stopLoad();
        if (result) {
          // 仅保留少量已生成缩略图，重复悬停无需再次下载或解码。
          this.thumbnails.set(key, result);
          if (this.thumbnails.size > 64) {
            this.thumbnails.delete(this.thumbnails.keys().next().value as string);
          }
        }
        resolve(result);
      };
      const onError = () => finish(null);
      const onHlsError = (_event: any, data: any) => {
        if (data.fatal) finish(null);
      };
      const onReady = () => {
        if (settled) return;
        if (this.disposed || this.video !== video) {
          finish(null);
          return;
        }
        if (video.readyState >= 1 && Math.abs(video.currentTime - target) > 0.3) {
          try {
            video.currentTime = target;
          } catch {
            finish(null);
          }
          return;
        }
        if (!video.seeking && video.readyState >= 2) {
          const image = this.extract();
          if (image) finish(image);
        }
      };
      const startLoading = () => {
        if (settled || loading) return;
        loading = true;
        try {
          // 未有元数据时也直接从目标分片启动，不再先下载片头。
          hls.config.startPosition = target;
          if (video.readyState >= 1) video.currentTime = target;
          hls.startLoad(target);
          // 激活隐藏视频的解码管线；拿到目标帧后立即暂停。
          video.play().catch(() => undefined);
        } catch {
          finish(null);
        }
      };
      // 超时覆盖播放列表、分片下载和解码，而非仅覆盖 seek。
      const timer = setTimeout(() => finish(null), 10000);
      const poll = setInterval(onReady, 50);
      this.cancelCapture = () => finish(null);
      mediaEvents.forEach((event) => video.addEventListener(event, onReady));
      video.addEventListener('error', onError);
      hls.on(this.events.MANIFEST_PARSED, startLoading);
      hls.on(this.events.ERROR, onHlsError);
      onReady();
      if (settled) return;
      if (this.manifestReady) {
        startLoading();
      } else {
        try {
          hls.loadSource(this.sourceUrl);
        } catch {
          finish(null);
        }
      }
    });
  }

  /** 取消过时的抽帧并中止下载，不影响主播放器或缓存预取器。 */
  cancel(): void {
    this.cancelCapture?.();
    this.video?.pause();
    this.hls?.stopLoad();
  }

  destroy(): void {
    this.cancel();
    this.disposed = true;
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        // 忽略：实例可能已处于销毁中
      }
      this.hls = null;
    }
    if (this.video) {
      try {
        this.video.remove();
      } catch {
        // 忽略
      }
      this.video = null;
    }
    this.manifestReady = false;
    this.sourceUrl = '';
    this.thumbnails.clear();
  }

  private extract(): string | null {
    const video = this.video;
    const ctx = this.ctx;
    if (!video || !ctx) return null;
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const targetWidth = 160;
      const targetHeight = Math.max(1, Math.round((vh / vw) * targetWidth));
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
      ctx.drawImage(video, 0, 0, vw, vh, 0, 0, targetWidth, targetHeight);
      return this.canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      return null;
    }
  }
}
