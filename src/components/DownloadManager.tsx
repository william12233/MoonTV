'use client';

import { Download, List, Pause, Play, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';

import { downloadM3U8Video, DownloadProgress, M3U8Task, parseM3U8, PauseResumeController, StreamSaverMode } from '@/lib/m3u8-downloader';

import AddDownloadModal from './AddDownloadModal';
import SegmentViewer from './SegmentViewer';
import { formatTime } from '@/lib/formatTime';


interface DownloadTask {
  id: string;
  url: string;
  title: string;
  status: 'waiting' | 'downloading' | 'paused' | 'completed' | 'error' | 'merging';
  progress: number;
  current: number;
  total: number;
  abortController?: AbortController;
  pauseResumeController?: PauseResumeController; // 暂停/恢复控制器
  completeStreamRef?: { current: (() => Promise<void>) | null }; // 完成流函数引用（用于边下边存模式立即保存）
  isEarlyCompleting?: boolean; // 标记是否正在提前完成（用于避免错误处理覆盖状态）
  autoResume?: boolean; // 标记是否需要自动恢复下载（刷新页面导致的暂停）
  // 任务配置信息（用于断点续传）
  config?: {
    downloadType: 'TS' | 'MP4';
    concurrency: number;
    rangeMode: boolean;
    startSegment: number;
    endSegment: number;
    streamMode?: StreamSaverMode;
    maxRetries?: number; // 最大重试次数
    parsedTask?: M3U8Task;
  };
  // 片段信息（用于查看和重试）
  parsedTask?: M3U8Task;
}

interface DownloadManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

const DownloadManager = ({ isOpen, onClose }: DownloadManagerProps) => {
  // 任务列表状态
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  // 添加下载弹窗状态
  const [showAddModal, setShowAddModal] = useState(false);
  // 查看片段的任务ID
  const [viewingSegmentsTaskId, setViewingSegmentsTaskId] = useState<string | null>(null);
  // 使用 ref 保存最新的 tasks，用于事件处理器
  const tasksRef = useRef<DownloadTask[]>([]);
  // 追踪是否已经处理过自动恢复
  const hasAutoResumed = useRef(false);
  // 标记页面是否正在卸载
  const isUnloading = useRef(false);
  // 防止重复触发合并的标记
  const mergingTaskIds = useRef(new Set<string>());

  // 同步 tasks 到 ref
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // 从 localStorage 加载任务
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('downloadTasks');
      if (saved) {
        try {
          const savedTasks = JSON.parse(saved);

          const processedTasks = savedTasks.map((t: DownloadTask & { _originalStatus?: string }) => {
            // 使用 _originalStatus 判断是否需要自动恢复
            const wasDownloading = t._originalStatus === 'downloading' || t.status === 'downloading';
            const { _originalStatus, ...taskWithoutOriginal } = t;

            return {
              ...taskWithoutOriginal,
              // 如果之前正在下载，设为暂停并标记自动恢复
              status: wasDownloading ? 'paused' : t.status,
              autoResume: wasDownloading,
              abortController: undefined
            };
          });

          setTasks(processedTasks);
        } catch {
          // 忽略解析错误
        }
      }
    }
  }, []);

  // 自动恢复因刷新页面而暂停的下载任务
  useEffect(() => {
    // 只执行一次自动恢复
    if (hasAutoResumed.current) return;

    const tasksToResume = tasks.filter(t => t.autoResume && t.status === 'paused');

    if (tasksToResume.length > 0) {
      hasAutoResumed.current = true;

      // 延迟一点时间后开始恢复下载，确保组件已完全加载
      setTimeout(() => {
        tasksToResume.forEach(task => {
          resumeTask(task.id);
        });

        // 清除 autoResume 标记
        setTasks(prev => prev.map(t => ({ ...t, autoResume: false })));
      }, 500);
    }
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // 保存任务到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const tasksToSave = tasks.map(({ abortController: _abortController, pauseResumeController: _pauseResumeController, config, ...rest }) => ({
        ...rest,
        // 保存配置但排除 parsedTask（太大）
        config: config ? {
          downloadType: config.downloadType,
          concurrency: config.concurrency,
          rangeMode: config.rangeMode,
          startSegment: config.startSegment,
          endSegment: config.endSegment,
          streamMode: config.streamMode,
          maxRetries: config.maxRetries,
        } : undefined,
        // 保存原始状态，用于恢复时判断
        _originalStatus: rest.status,
      }));
      localStorage.setItem('downloadTasks', JSON.stringify(tasksToSave));

      // 触发自定义事件，通知任务列表更新
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('downloadTasksUpdated'));
      }
    }
  }, [tasks]);

  // 页面卸载/刷新时取消所有正在下载的任务
  useEffect(() => {
    const handleBeforeUnload = () => {
      // 标记页面正在卸载
      isUnloading.current = true;

      // 使用 ref 获取最新的 tasks
      tasksRef.current.forEach(task => {
        if (task.status === 'downloading' && task.abortController) {
          task.abortController.abort();
        }
        if (task.pauseResumeController) {
          task.pauseResumeController.destroy();
        }
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []); // 空依赖数组，避免重复绑定/解绑

  // 执行下载任务（核心下载逻辑）
  const executeDownload = useCallback(async (
    taskId: string,
    parsedTask: M3U8Task,
    controller: AbortController,
    pauseResumeController: PauseResumeController,
    downloadType: 'TS' | 'MP4',
    concurrency: number,
    rangeMode: boolean,
    startSegment: number,
    endSegment: number,
    streamMode: StreamSaverMode = 'disabled',
    maxRetries = 3,
    completeStreamRef?: { current: (() => Promise<void>) | null }
  ) => {
    try {
      // 不要创建新对象，直接使用传入的 parsedTask
      // 只修改需要的属性
      parsedTask.type = downloadType;

      if (rangeMode) {
        parsedTask.rangeDownload = {
          startSegment: Math.max(1, Math.min(startSegment, parsedTask.tsUrlList.length)),
          endSegment: Math.max(1, Math.min(endSegment, parsedTask.tsUrlList.length)),
          targetSegment: Math.abs(endSegment - startSegment) + 1,
        };
      }

      await downloadM3U8Video(
        parsedTask,
        (prog: DownloadProgress) => {
          setTasks(prev => prev.map(t => {
            if (t.id !== taskId) return t;
            // 合并中时不更新进度
            if (t.status === 'merging') return t;
            // 如果正在提前完成，不更新状态（状态会在立即保存时手动更新）
            if (t.isEarlyCompleting) return t;

            // 只有任务本身是 downloading 时才允许更新状态，避免手动暂停被覆盖
            const shouldUpdateStatus = t.status === 'downloading';

            // 创建新的 parsedTask 引用以触发重新渲染
            // 注意：downloadedSegments 是 Map，需要保持引用以便数据共享
            // 重要：finishList 也保持引用，避免覆盖手动重试的状态
            const updatedParsedTask = t.parsedTask ? {
              ...t.parsedTask,
              finishNum: parsedTask.finishNum,
              errorNum: parsedTask.errorNum,
              // 保持 finishList 的引用，不要覆盖（手动重试可能已更新）
              finishList: parsedTask.finishList,
              // 保持 downloadedSegments 的引用，确保数据共享
              downloadedSegments: parsedTask.downloadedSegments,
            } : undefined;

            return {
              ...t,
              progress: prog.percentage,
              current: prog.current,
              total: prog.total,
              status: shouldUpdateStatus
                ? (prog.status === 'done' ? 'completed' : prog.status === 'error' ? 'error' : 'downloading')
                : t.status,
              parsedTask: updatedParsedTask,
            };
          }));
        },
        controller.signal,
        pauseResumeController,
        concurrency,
        streamMode,
        maxRetries,
        completeStreamRef
      );

      // 下载函数执行完成后，检查是否有失败片段
      const taskAfterDownload = tasksRef.current.find(t => t.id === taskId);
      const hasFailedSegments = taskAfterDownload?.parsedTask?.finishList.some(
        item => item.status === 'error'
      );

      // 边下边存模式下，失败片段已被跳过并写入文件，无需等待重试
      // 只有普通模式下有失败片段才需要保持 abortController 等待手动重试
      if (hasFailedSegments && streamMode === 'disabled') {
        // 普通模式：有失败片段，保持 abortController 以便后续可以区分状态
        // eslint-disable-next-line no-console
        console.log(`⚠️ 任务 ${taskId} 有失败片段，保持下载状态等待重试`);
      } else {
        // 边下边存模式或全部成功，清除 abortController
        setTasks(prev => prev.map(t =>
          t.id === taskId
            ? { ...t, abortController: undefined }
            : t
        ));

        if (hasFailedSegments && streamMode !== 'disabled') {
          // eslint-disable-next-line no-console
          console.log(`✅ 边下边存模式：任务 ${taskId} 已完成，失败片段已跳过`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === '下载已取消') {
        // 检查是否是提前完成的情况
        const taskAfterError = tasksRef.current.find(t => t.id === taskId);
        // 如果任务正在提前完成，或者已经完成，都不需要更新状态
        if (taskAfterError?.isEarlyCompleting || taskAfterError?.status === 'completed') {
          // 如果是提前完成，状态已经在立即保存时更新了，不需要再次更新
          return;
        }

        // 如果是页面卸载导致的取消，不更新状态
        if (!isUnloading.current) {
          setTasks(prev => prev.map(t =>
            t.id === taskId
              ? { ...t, status: 'paused' as const, abortController: undefined }
              : t
          ));
        }
      } else {
        // eslint-disable-next-line no-console
        console.error('下载失败:', error);
        setTasks(prev => prev.map(t =>
          t.id === taskId
            ? { ...t, status: 'error' as const, abortController: undefined }
            : t
        ));
      }
    }
  }, []);

  // 从配置创建并开始下载任务
  const addTaskFromConfig = useCallback((config: {
    url: string;
    title: string;
    downloadType: 'TS' | 'MP4';
    concurrency: number;
    rangeMode: boolean;
    startSegment: number;
    endSegment: number;
    streamMode: StreamSaverMode;
    maxRetries: number;
    parsedTask: M3U8Task;
  }) => {
    const taskId = Date.now().toString();
    const controller = new AbortController();
    const pauseResumeController = new PauseResumeController();
    const completeStreamRef = { current: null as (() => Promise<void>) | null };

    // 创建新任务并直接开始下载
    const newTask: DownloadTask = {
      id: taskId,
      url: config.url,
      title: config.title,
      status: 'downloading',
      progress: 0,
      current: 0,
      total: config.parsedTask.tsUrlList.length,
      config: {
        downloadType: config.downloadType,
        concurrency: config.concurrency,
        rangeMode: config.rangeMode,
        startSegment: config.startSegment,
        endSegment: config.endSegment,
        streamMode: config.streamMode,
          maxRetries: config.maxRetries ?? 3,
        parsedTask: config.parsedTask,
      },
      parsedTask: config.parsedTask, // 保存片段信息
      abortController: controller,
      pauseResumeController: pauseResumeController,
      completeStreamRef: completeStreamRef,
    };

    // 添加到任务列表
    setTasks(prev => [...prev, newTask]);

    // 使用 setTimeout 确保 state 更新后再开始下载
    setTimeout(() => {
      executeDownload(
        taskId,
        config.parsedTask,
        controller,
        pauseResumeController,
        config.downloadType,
        config.concurrency,
        config.rangeMode,
        config.startSegment,
        config.endSegment,
        config.streamMode,
        config.maxRetries || 3,
        completeStreamRef
      );
    }, 0);
  }, [executeDownload]);

  // 监听来自播放页面的添加下载任务事件
  useEffect(() => {
    const handleAddTaskEvent = (event: CustomEvent) => {
      const config = event.detail;
      const taskId = Date.now().toString();
      const controller = new AbortController();
      const pauseResumeController = new PauseResumeController();
      const completeStreamRef = { current: null as (() => Promise<void>) | null };

      // 创建新任务并直接开始下载
      const newTask: DownloadTask = {
        id: taskId,
        url: config.url,
        title: config.title,
        status: 'downloading',
        progress: 0,
        current: 0,
        total: config.parsedTask.tsUrlList.length,
        config: {
          downloadType: config.downloadType,
          concurrency: config.concurrency,
          rangeMode: config.rangeMode,
          startSegment: config.startSegment,
          endSegment: config.endSegment,
          streamMode: config.streamMode,
          maxRetries: config.maxRetries ?? 3,
          parsedTask: config.parsedTask,
        },
        parsedTask: config.parsedTask, // 保存片段信息
        abortController: controller,
        pauseResumeController: pauseResumeController,
        completeStreamRef: completeStreamRef,
      };

      // 添加到任务列表
      setTasks(prev => [...prev, newTask]);

      // 使用 setTimeout 确保 state 更新后再开始下载
      setTimeout(() => {
        executeDownload(
          taskId,
          config.parsedTask,
          controller,
          pauseResumeController,
          config.downloadType,
          config.concurrency,
          config.rangeMode,
          config.startSegment,
          config.endSegment,
          config.streamMode,
          config.maxRetries ?? 3,
          completeStreamRef
        );
      }, 0);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('addDownloadTask', handleAddTaskEvent as EventListener);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('addDownloadTask', handleAddTaskEvent as EventListener);
      }
    };
  }, [executeDownload]); // 直接依赖 executeDownload

  // 执行下载任务（从任务配置启动）
  const startTaskDownload = useCallback(async (taskId: string, parsedTask: M3U8Task) => {
    // 使用 tasksRef 获取最新的 tasks
    const taskToDownload = tasksRef.current.find(t => t.id === taskId);
    if (!taskToDownload?.config) return;

    const controller = new AbortController();
    const pauseResumeController = new PauseResumeController();
    const completeStreamRef = { current: null as (() => Promise<void>) | null };
    const { downloadType, concurrency, rangeMode, startSegment, endSegment, streamMode, maxRetries } = taskToDownload.config;

    // 更新任务状态
    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, status: 'downloading' as const, abortController: controller, pauseResumeController: pauseResumeController, completeStreamRef: completeStreamRef }
        : t
    ));

    executeDownload(taskId, parsedTask, controller, pauseResumeController, downloadType, concurrency, rangeMode, startSegment, endSegment, streamMode || 'disabled', maxRetries ?? 3, completeStreamRef);
  }, [executeDownload]);

  // 删除任务
  const deleteTask = useCallback((taskId: string) => {
    setTasks(prev => {
      const task = prev.find(t => t.id === taskId);
      if (task?.abortController) {
        task.abortController.abort();
      }
      if (task?.pauseResumeController) {
        task.pauseResumeController.destroy();
      }
      return prev.filter(t => t.id !== taskId);
    });
  }, []);

  // 暂停任务
  const pauseTask = useCallback((taskId: string) => {
    setTasks(prev => {
      const task = prev.find(t => t.id === taskId);
      if (task?.pauseResumeController) {
        task.pauseResumeController.pause();
      }
      return prev.map(t =>
        t.id === taskId
          ? { ...t, status: 'paused' as const }
          : t
      );
    });
  }, []);

  // 继续下载任务
  const resumeTask = useCallback(async (taskId: string) => {
    // eslint-disable-next-line no-console
    console.log(`🔄 resumeTask 被调用: taskId=${taskId}`);

    // 使用 tasksRef 获取最新的 tasks
    const taskToResume = tasksRef.current.find(t => t.id === taskId);
    if (!taskToResume) {
      // eslint-disable-next-line no-console
      console.log(`⚠️ 找不到任务: ${taskId}`);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`📋 任务状态: ${taskToResume.status}, abortController: ${!!taskToResume.abortController}`);

    // 检查是否有失败片段
    const hasFailedSegments = taskToResume.parsedTask?.finishList.some(
      item => item.status === 'error'
    );

    // 如果任务正在下载中（有 abortController）且还有失败片段，不重复开始
    if (taskToResume.status === 'downloading' && taskToResume.abortController && hasFailedSegments) {
      // eslint-disable-next-line no-console
      console.log(`⚠️ 任务正在下载中且有失败片段，跳过`);
      return;
    }

    // 如果任务有 pauseResumeController 且处于暂停状态，只需恢复即可
    if (taskToResume.pauseResumeController && taskToResume.pauseResumeController.getPaused()) {
      // eslint-disable-next-line no-console
      console.log(`▶️ 任务处于暂停状态，恢复下载...`);
      taskToResume.pauseResumeController.resume();
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, status: 'downloading' as const }
          : t
      ));
      return;
    }

    // 使用 task.parsedTask 而不是 config.parsedTask，因为手动重试更新的是 task.parsedTask
    const parsedTaskToUse = taskToResume.parsedTask || taskToResume.config?.parsedTask;

    if (parsedTaskToUse) {
      const downloadedCount = parsedTaskToUse.downloadedSegments?.size || 0;
      const isStreamMode = taskToResume.config?.streamMode !== 'disabled';

      // 检查是否还有需要下载的片段(空状态表示待下载)
      const { startSegment, endSegment } = parsedTaskToUse.rangeDownload;
      let pendingCount = 0;
      let successCount = 0;
      let errorCount = 0;

      for (let i = startSegment - 1; i < endSegment; i++) {
        const status = parsedTaskToUse.finishList[i].status;
        if (status === '' || status === 'downloading') pendingCount++;
        else if (status === 'success') successCount++;
        else if (status === 'error') errorCount++;
      }

      const totalInRange = endSegment - startSegment + 1;

      // eslint-disable-next-line no-console
      console.log(`✅ 使用已保存的 parsedTask，范围内片段: ${totalInRange}个，成功: ${successCount}，失败: ${errorCount}，待下载: ${pendingCount}，已保存数据: ${downloadedCount} 个, 边下边存: ${isStreamMode}`);

      // 如果范围内所有片段都已完成(没有pending)
      if (pendingCount === 0) {
        // 全部成功
        if (errorCount === 0) {
          // eslint-disable-next-line no-console
          console.log(`🎉 范围内所有 ${totalInRange} 个片段都已成功下载`);

          // 边下边存模式：数据已直接写入文件，直接标记为完成
          if (isStreamMode) {
            // eslint-disable-next-line no-console
            console.log(`✅ 边下边存模式，数据已写入文件，直接标记为完成`);
            setTasks(prev => prev.map(t =>
              t.id === taskId ? { ...t, status: 'completed' as const, progress: 100 } : t
            ));
            return;
          }

          // 普通模式：需要合并片段数据
          // eslint-disable-next-line no-console
          console.log(`📦 普通模式，开始合并 ${downloadedCount} 个片段数据...`);

          // 先标记为合并中
          setTasks(prev => prev.map(t =>
            t.id === taskId ? { ...t, status: 'merging' as const, progress: 99 } : t
          ));

          // 异步合并和下载
          setTimeout(async () => {
            try {
              // 从 downloadedSegments 按顺序获取片段数据
              const segments: ArrayBuffer[] = [];
              for (let i = startSegment - 1; i < endSegment; i++) {
                const segment = parsedTaskToUse.downloadedSegments?.get(i);
                if (segment) {
                  segments.push(segment);
                }
              }

              if (segments.length === 0) {
                throw new Error('没有可合并的片段数据');
              }

              // eslint-disable-next-line no-console
              console.log(`📦 合并 ${segments.length} 个片段...`);

              // 动态导入合并函数
              const { mergeSegments, triggerDownload } = await import('@/lib/m3u8-downloader');
              const { transmuxTSToMP4 } = await import('@/lib/mp4-transmuxer');

              // 如果是 MP4 格式，进行转码
              const downloadType = taskToResume.config?.downloadType || 'TS';
              let blob: Blob;

              if (downloadType === 'MP4') {
                // 计算范围内的视频时长
                const totalDuration = parsedTaskToUse.durationSecond || 0;
                const totalSegmentsCount = parsedTaskToUse.finishList.length;
                const rangeDuration = (totalInRange / totalSegmentsCount) * totalDuration;

                // eslint-disable-next-line no-console
                console.log(`🎬 转码为 MP4 格式...`);
                blob = transmuxTSToMP4(segments, rangeDuration);
              } else {
                blob = mergeSegments(segments, downloadType);
              }

              // 触发下载
              triggerDownload(blob, parsedTaskToUse.title, downloadType);

              // 标记为完成
              setTasks(prev => prev.map(t =>
                t.id === taskId ? { ...t, status: 'completed' as const, progress: 100 } : t
              ));

              // eslint-disable-next-line no-console
              console.log(`✅ 合并下载完成！`);
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error('合并下载失败:', error);
              setTasks(prev => prev.map(t =>
                t.id === taskId ? { ...t, status: 'error' as const } : t
              ));
            }
          }, 100);

          return;
        } else {
          // 有失败片段，不启动下载，等待手动重试
          // eslint-disable-next-line no-console
          console.log(`⚠️ 范围内有 ${errorCount} 个片段失败，等待手动重试`);
          return;
        }
      }

      // 还有片段未下载完成，继续下载
      // eslint-disable-next-line no-console
      console.log(`▶️ 还有 ${pendingCount} 个片段待下载，继续下载...`);
      startTaskDownload(taskId, parsedTaskToUse);
      return;
    }

    // 否则重新解析并下载
    try {
      const parsedTask = await parseM3U8(taskToResume.url);
      parsedTask.title = taskToResume.title;

      // 保存解析结果到任务配置，保留原有的用户配置
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? {
            ...t,
            config: {
              downloadType: t.config?.downloadType || 'TS',
              concurrency: t.config?.concurrency || 6,
              rangeMode: t.config?.rangeMode || false,
              startSegment: t.config?.startSegment || 1,
              endSegment: t.config?.endSegment || parsedTask.tsUrlList.length,
              streamMode: t.config?.streamMode || 'disabled',
              parsedTask,
            }
          }
          : t
      ));

      startTaskDownload(taskId, parsedTask);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('重新解析失败:', error);
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, status: 'error' as const }
          : t
      ));
    }
  }, [startTaskDownload]);

  // 全部暂停
  const pauseAllTasks = useCallback(() => {
    setTasks(prev => {
      prev.forEach(task => {
        if (task.status === 'downloading' && task.pauseResumeController) {
          task.pauseResumeController.pause();
        }
      });
      return prev.map(t =>
        t.status === 'downloading'
          ? { ...t, status: 'paused' as const }
          : t
      );
    });
  }, []);

  // 全部开始
  const startAllTasks = useCallback(() => {
    // 使用 tasksRef 获取最新的 tasks，避免闭包问题
    tasksRef.current.forEach(task => {
      if (task.status === 'waiting' || task.status === 'paused' || task.status === 'error') {
        resumeTask(task.id);
      }
    });
  }, [resumeTask]); // eslint-disable-line react-hooks/exhaustive-deps

  // 清空所有任务
  const clearAllTasks = useCallback(() => {
    setTasks(prev => {
      prev.forEach(task => {
        if (task.abortController) {
          task.abortController.abort();
        }
        if (task.pauseResumeController) {
          task.pauseResumeController.destroy();
        }
      });
      return [];
    });
  }, []);

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] flex flex-col">
          {/* 头部 */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Download className="h-5 w-5" />
              下载管理器
            </h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* 操作栏 */}
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex gap-2">
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
              添加下载
            </button>
            <button
              onClick={startAllTasks}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-2"
            >
              <Play className="h-4 w-4" />
              全部开始
            </button>
            <button
              onClick={pauseAllTasks}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition-colors flex items-center gap-2"
            >
              <Pause className="h-4 w-4" />
              全部暂停
            </button>
            <button
              onClick={clearAllTasks}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
            >
              清空全部
            </button>
          </div>

          {/* 任务列表 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {tasks.length === 0 ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                暂无下载任务
              </div>
            ) : (
              tasks.map((task) => (
                <div
                  key={task.id}
                  className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-gray-900 dark:text-white truncate">
                        {task.title}
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400 truncate mt-1">
                        {task.url}
                      </p>
                      {/* 下载配置信息 */}
                      {task.config && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                            {task.config.downloadType} 格式
                          </span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                            {task.config.concurrency} 线程
                          </span>
                          {task.config.rangeMode && (
                            (() => {
                              // 计算时长范围
                              let startTime = 0, endTime = 0;
                              if (task.parsedTask && Array.isArray(task.parsedTask.segmentDurations)) {
                                const { startSegment, endSegment } = task.parsedTask.rangeDownload;
                                const segs = task.parsedTask.segmentDurations;
                                startTime = segs.slice(0, startSegment - 1).reduce((a, b) => a + b, 0);
                                endTime = segs.slice(0, endSegment).reduce((a, b) => a + b, 0);
                              }
                              // 格式化
                              // 使用统一的 formatTime
                              return (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400">
                                  范围: {task.config.startSegment}-{task.config.endSegment}
                                  {task.parsedTask && task.parsedTask.segmentDurations && task.parsedTask.segmentDurations.length > 0 && (
                                    <>
                                      &nbsp;|&nbsp;时长: {formatTime(startTime)} ~ {formatTime(endTime)}
                                    </>
                                  )}
                                </span>
                              );
                            })()
                          )}
                          {task.parsedTask && (() => {
                            // 直接同步 SegmentViewer 的失败片段统计逻辑
                            const { startSegment, endSegment } = task.parsedTask.rangeDownload;
                            const filteredSegments = task.parsedTask.finishList.slice(startSegment - 1, endSegment);
                            const errorCount = filteredSegments.filter(item => item.status === 'error').length;
                            return errorCount > 0 ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">
                                失败: {errorCount} 个片段
                              </span>
                            ) : null;
                          })()}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* 立即保存按钮 */}
                      {task.parsedTask && (
                        <button
                          onClick={async () => {
                            // 防止重复触发
                            if (mergingTaskIds.current.has(task.id)) return;
                            // 类型检查：确保 parsedTask 存在
                            if (!task.parsedTask) return;

                            const streamMode = task.config?.streamMode || 'disabled';

                            // 边下边存模式：提示用户确认并完成流
                            if (streamMode !== 'disabled') {
                              const result = await Swal.fire({
                                title: '立即保存',
                                text: '立即保存将跳过后续片段下载，直接完成下载。文件将包含目前已下载的片段。\n\n是否继续？',
                                icon: 'warning',
                                showCancelButton: true,
                                confirmButtonText: '确定',
                                cancelButtonText: '取消',
                                customClass: {
                                  container: 'z-[11000]'
                                },
                              });
                              if (!result.isConfirmed) return;
                              // 调用完成流函数来关闭流并完成下载
                              if (task.completeStreamRef?.current) {
                                try {
                                  // 先标记为正在提前完成，避免错误处理覆盖状态
                                  setTasks(prev => prev.map(t =>
                                    t.id === task.id
                                      ? { ...t, isEarlyCompleting: true }
                                      : t
                                  ));
                                  
                                  // 先取消后续下载，避免继续下载
                                  if (task.abortController) {
                                    task.abortController.abort();
                                  }
                                  
                                  // 等待一小段时间，确保 abort 信号已传播，错误处理已检查 isEarlyCompleting
                                  await new Promise(resolve => setTimeout(resolve, 100));
                                  
                                  // 然后完成流（这会调用 onProgress 更新进度为 100%）
                                  await task.completeStreamRef.current();
                                  
                                  // 最后更新状态为完成（使用函数式更新确保获取最新状态）
                                  setTasks(prev => prev.map(t => {
                                    if (t.id === task.id) {
                                      return {
                                        ...t,
                                        status: 'completed' as const,
                                        progress: 100,
                                        current: t.total,
                                        abortController: undefined,
                                        // 保留 isEarlyCompleting 标记一段时间，防止错误处理覆盖状态
                                        // 稍后通过 setTimeout 清除
                                      };
                                    }
                                    return t;
                                  }));
                                  
                                  // 延迟清除 isEarlyCompleting 标记，确保错误处理已经检查过
                                  setTimeout(() => {
                                    setTasks(prev => prev.map(t =>
                                      t.id === task.id && t.status === 'completed'
                                        ? { ...t, isEarlyCompleting: false }
                                        : t
                                    ));
                                  }, 1000);
                                } catch (error) {
                                  // eslint-disable-next-line no-console
                                  console.error('完成下载失败:', error);
                                  Swal.fire({
                                    icon: 'error',
                                    title: '完成下载失败',
                                    text: error instanceof Error ? error.message : String(error),
                                  });
                                  // 清除标记并恢复状态
                                  setTasks(prev => prev.map(t =>
                                    t.id === task.id
                                      ? { ...t, isEarlyCompleting: false }
                                      : t
                                  ));
                                }
                              } else {
                                Swal.fire({
                                  icon: 'error',
                                  title: '无法完成下载',
                                  text: '流未初始化',
                                });
                              }
                              return;
                            }

                            // 普通模式：合并并下载
                            mergingTaskIds.current.add(task.id);
                            try {
                              const { mergeSegments, triggerDownload } = await import('@/lib/m3u8-downloader');
                              const { transmuxTSToMP4 } = await import('@/lib/mp4-transmuxer');
                              const { startSegment, endSegment } = task.parsedTask.rangeDownload;
                              const downloadType = task.config?.downloadType || 'TS';
                              // 按顺序收集已下载片段
                              const segments: ArrayBuffer[] = [];
                              for (let i = startSegment - 1; i < endSegment; i++) {
                                const segment = task.parsedTask.downloadedSegments?.get(i);
                                if (segment) segments.push(segment);
                              }
                              if (segments.length === 0) {
                                alert('没有可合并的片段数据！');
                                return;
                              }
                              let blob: Blob;
                              if (downloadType === 'MP4') {
                                const totalDuration = task.parsedTask.durationSecond || 0;
                                const totalSegments = endSegment - startSegment + 1;
                                const rangeDuration = (totalDuration / totalSegments) * segments.length;
                                blob = transmuxTSToMP4(segments, rangeDuration);
                              } else {
                                blob = mergeSegments(segments, downloadType);
                              }
                              triggerDownload(blob, task.parsedTask.title, downloadType);
                            } catch (e) {
                              alert('合并下载失败：' + (e instanceof Error ? e.message : e));
                            } finally {
                              setTimeout(() => mergingTaskIds.current.delete(task.id), 2000);
                            }
                          }}
                          className="p-2 hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600 dark:text-green-400 rounded-lg transition-colors"
                          title={task.config?.streamMode === 'disabled' ? '立即合并已下载片段并导出文件' : '立即保存（将跳过后续片段下载，直接完成下载）'}
                        >
                          <Download className="h-4 w-4" />
                        </button>
                      )}
                      {/* 查看片段按钮 */}
                      {task.parsedTask && (
                        <button
                          onClick={() => setViewingSegmentsTaskId(task.id)}
                          className="p-2 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                          title="查看片段"
                        >
                          <List className="h-4 w-4" />
                        </button>
                      )}
                      {task.status === 'downloading' ? (
                        <button
                          onClick={() => pauseTask(task.id)}
                          className="p-2 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                          title="暂停"
                        >
                          <Pause className="h-4 w-4" />
                        </button>
                      ) : (task.status === 'waiting' || task.status === 'paused' || task.status === 'error') ? (
                        <button
                          onClick={() => resumeTask(task.id)}
                          className="p-2 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                          title="开始/继续"
                        >
                          <Play className="h-4 w-4" />
                        </button>
                      ) : null}
                      <button
                        onClick={() => deleteTask(task.id)}
                        className="p-2 hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg transition-colors"
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {/* 进度条 */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-700 dark:text-gray-300">
                        {task.status === 'completed' ? '已完成' :
                          task.status === 'merging' ? '合并中' :
                            task.status === 'downloading' ? '下载中' :
                              task.status === 'error' ? '下载失败' :
                                task.status === 'paused' ? '已暂停' : '等待中'}
                      </span>
                      <span className="text-gray-600 dark:text-gray-400">
                        {Math.floor(task.progress)}%
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-2">
                      <div
                        className="bg-green-600 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                      <span>
                        {task.current} / {task.total} 片段
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 添加下载弹窗 */}
      <AddDownloadModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAddTask={(config) => {
          addTaskFromConfig(config);
          setShowAddModal(false);
        }}
        initialUrl=""
        initialTitle=""
      />

      {/* 片段查看器 */}
      {viewingSegmentsTaskId && (() => {
        const task = tasks.find(t => t.id === viewingSegmentsTaskId);
        return task?.parsedTask ? (
          <SegmentViewer
            task={task.parsedTask}
            isOpen={true}
            onClose={() => setViewingSegmentsTaskId(null)}
            taskExists={() => tasks.some(t => t.id === viewingSegmentsTaskId)}
            concurrency={task.config?.concurrency || 6}
            streamMode={task.config?.streamMode || 'disabled'}
            onSegmentRetry={(_index) => {
              // 重试成功后更新任务进度
              setTasks(prev => prev.map(t => {
                if (t.id === viewingSegmentsTaskId && t.parsedTask) {
                  const { startSegment, endSegment } = t.parsedTask.rangeDownload;

                  // 只检查下载范围内的片段状态
                  let successCount = 0;
                  let errorCount = 0;
                  for (let i = startSegment - 1; i < endSegment; i++) {
                    if (t.parsedTask.finishList[i].status === 'success') {
                      successCount++;
                    } else if (t.parsedTask.finishList[i].status === 'error') {
                      errorCount++;
                    }
                  }

                  const totalInRange = endSegment - startSegment + 1;
                  const progress = (successCount / totalInRange) * 100;

                  // 检查范围内是否所有片段都成功了
                  if (errorCount === 0 && successCount === totalInRange) {
                    // 防止重复触发
                    if (mergingTaskIds.current.has(viewingSegmentsTaskId)) {
                      // eslint-disable-next-line no-console
                      console.log(`⚠️ 任务 ${viewingSegmentsTaskId} 已经在合并中，跳过`);
                      return t;
                    }

                    mergingTaskIds.current.add(viewingSegmentsTaskId);

                    // 所有片段都成功，自动触发合并保存
                    // parsedTask.downloadedSegments 已经在 SegmentViewer 中更新了
                    // eslint-disable-next-line no-console
                    console.log(`✅ 范围内所有 ${totalInRange} 个片段重试成功！downloadedSegments 有 ${t.parsedTask.downloadedSegments?.size || 0} 个片段，自动触发合并保存...`);

                    // 保存 taskId（闭包中的值）
                    const taskIdToResume = viewingSegmentsTaskId;

                    // 先关闭片段查看器
                    setViewingSegmentsTaskId(null);

                    // 清除 abortController，允许 resumeTask 触发合并
                    setTasks(prevTasks => prevTasks.map(task =>
                      task.id === taskIdToResume
                        ? { ...task, abortController: undefined }
                        : task
                    ));

                    // 然后触发合并保存
                    setTimeout(() => {
                      resumeTask(taskIdToResume);
                      // 3秒后清除标记，允许下次触发
                      setTimeout(() => {
                        mergingTaskIds.current.delete(taskIdToResume);
                      }, 3000);
                    }, 500);
                  }

                  // 注意：这里返回的是浅拷贝，parsedTask 引用不变，所以 downloadedSegments 的修改会保留
                  return {
                    ...t,
                    current: successCount,
                    progress,
                  };
                }
                return t;
              }));
            }}
          />
        ) : null;
      })()}
    </>
  );
};

export default DownloadManager;
