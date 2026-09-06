/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { AlertCircle, AlertTriangle, CheckCircle, Download, FileCheck, Lock, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface DataMigrationProps {
  onRefreshConfig?: () => Promise<void>;
}

interface AlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'success' | 'error' | 'warning';
  title: string;
  message?: string;
  html?: string;
  confirmText?: string;
  onConfirm?: () => void;
  showConfirm?: boolean;
  timer?: number;
}

const AlertModal = ({
  isOpen,
  onClose,
  type,
  title,
  message,
  html,
  confirmText = '确定',
  onConfirm,
  showConfirm = false,
  timer
}: AlertModalProps) => {
  const [isVisible, setIsVisible] = useState(false);

  // 控制动画状态
  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      if (timer) {
        setTimeout(() => {
          onClose();
        }, timer);
      }
    } else {
      setIsVisible(false);
    }
  }, [isOpen, timer, onClose]);

  if (!isOpen) return null;

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle className="w-12 h-12 text-green-500" />;
      case 'error':
        return <AlertCircle className="w-12 h-12 text-red-500" />;
      case 'warning':
        return <AlertTriangle className="w-12 h-12 text-yellow-500" />;
      default:
        return null;
    }
  };

  const getBgColor = () => {
    switch (type) {
      case 'success':
        return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
      case 'error':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      case 'warning':
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
      default:
        return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800';
    }
  };

  return createPortal(
    <div className={`fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`} onClick={onClose}>
      <div className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full border ${getBgColor()} transition-all duration-200 ${isVisible ? 'scale-100' : 'scale-95'}`} onClick={(e) => e.stopPropagation()}>
        <div className="p-6 text-center">
          <div className="flex justify-center mb-4">
            {getIcon()}
          </div>

          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {title}
          </h3>

          {message && (
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              {message}
            </p>
          )}

          {html && (
            <div
              className="text-left text-gray-600 dark:text-gray-400 mb-4"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          <div className="flex justify-center space-x-3">
            {showConfirm && onConfirm ? (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    onConfirm();
                    onClose();
                  }}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                >
                  {confirmText}
                </button>
              </>
            ) : (
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
              >
                确定
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

// 导入进度弹窗组件
interface ImportLogItem {
  text: string;
  type: 'info' | 'success' | 'error';
}

interface ImportProgressModalProps {
  isOpen: boolean;
  percent: number;
  currentMessage: string;
  logs: ImportLogItem[];
  isError: boolean;
  // 弹窗标题（默认“正在导入数据”）
  title?: string;
  // 失败标题（默认“导入失败”）
  errorTitle?: string;
  // 图标类型：import 用红色上传图标，export 用蓝色下载图标
  iconType?: 'import' | 'export';
}

const ImportProgressModal = ({
  isOpen,
  percent,
  currentMessage,
  logs,
  isError,
  title = '正在导入数据',
  errorTitle = '导入失败',
  iconType = 'import',
}: ImportProgressModalProps) => {
  const logContainerRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  if (!isOpen) return null;

  const isExport = iconType === 'export';

  return createPortal(
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full border border-gray-200 dark:border-gray-700">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                isExport
                  ? 'bg-blue-50 dark:bg-blue-900/20'
                  : 'bg-red-50 dark:bg-red-900/20'
              }`}
            >
              {isExport ? (
                <Download className={`w-4 h-4 ${isExport ? 'text-blue-600 dark:text-blue-400' : ''}`} />
              ) : (
                <Upload className="w-4 h-4 text-red-600 dark:text-red-400" />
              )}
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {isError ? errorTitle : title}
            </h3>
          </div>

          {/* 进度条 */}
          <div className="mb-4">
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
              <span className="truncate mr-2">{currentMessage}</span>
              <span className="flex-shrink-0">{Math.round(percent)}%</span>
            </div>
            <div className="w-full h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  isError
                    ? 'bg-red-500'
                    : isExport
                      ? 'bg-blue-600'
                      : 'bg-red-600'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              ></div>
            </div>
          </div>

          {/* 日志列表 */}
          <div
            ref={logContainerRef}
            className="h-48 overflow-y-auto bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-xs font-mono space-y-1"
          >
            {logs.length === 0 ? (
              <div className="text-gray-400 dark:text-gray-500">准备中...</div>
            ) : (
              logs.map((log, index) => (
                <div
                  key={index}
                  className={
                    log.type === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : log.type === 'success'
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-gray-700 dark:text-gray-300'
                  }
                >
                  {log.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

const DataMigration = ({ onRefreshConfig }: DataMigrationProps) => {
  const [exportPassword, setExportPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [alertModal, setAlertModal] = useState<{
    isOpen: boolean;
    type: 'success' | 'error' | 'warning';
    title: string;
    message?: string;
    html?: string;
    confirmText?: string;
    onConfirm?: () => void;
    showConfirm?: boolean;
    timer?: number;
  }>({
    isOpen: false,
    type: 'success',
    title: '',
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 导入进度状态
  const [importProgress, setImportProgress] = useState({
    isOpen: false,
    percent: 0,
    currentMessage: '准备导入...',
    logs: [] as ImportLogItem[],
    isError: false,
  });

  // 导出进度状态
  const [exportProgress, setExportProgress] = useState({
    isOpen: false,
    percent: 0,
    currentMessage: '准备导出...',
    logs: [] as ImportLogItem[],
    isError: false,
  });

  const showAlert = (config: Omit<typeof alertModal, 'isOpen'>) => {
    setAlertModal({ ...config, isOpen: true });
  };

  const hideAlert = () => {
    setAlertModal(prev => ({ ...prev, isOpen: false }));
  };

  // 追加导入日志
  const appendImportLog = (text: string, type: ImportLogItem['type'] = 'info') => {
    setImportProgress(prev => ({
      ...prev,
      logs: [...prev.logs, { text, type }],
    }));
  };

  // 更新导入进度
  const updateImportProgress = (percent: number, currentMessage: string) => {
    setImportProgress(prev => ({
      ...prev,
      percent,
      currentMessage,
    }));
  };

  // 追加导出日志
  const appendExportLog = (text: string, type: ImportLogItem['type'] = 'info') => {
    setExportProgress(prev => ({
      ...prev,
      logs: [...prev.logs, { text, type }],
    }));
  };

  // 更新导出进度
  const updateExportProgress = (percent: number, currentMessage: string) => {
    setExportProgress(prev => ({
      ...prev,
      percent,
      currentMessage,
    }));
  };

  // 导出数据（SSE 流式响应，实时显示导出进度）
  const handleExport = async () => {
    if (!exportPassword.trim()) {
      showAlert({
        type: 'error',
        title: '错误',
        message: '请输入加密密码',
      });
      return;
    }

    // 打开导出进度弹窗
    setExportProgress({
      isOpen: true,
      percent: 0,
      currentMessage: '准备导出...',
      logs: [],
      isError: false,
    });

    try {
      setIsExporting(true);

      const response = await fetch('/api/admin/data_migration/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password: exportPassword,
        }),
      });

      // 如果返回的不是 SSE 流（如 JSON 错误），则按普通 JSON 处理
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        let errorMsg = `导出失败: ${response.status}`;
        try {
          const errData = await response.json();
          errorMsg = errData.error || errorMsg;
        } catch {
          // 忽略解析错误
        }
        throw new Error(errorMsg);
      }

      if (!response.body) {
        throw new Error('浏览器不支持流式读取');
      }

      // 读取 SSE 流
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let filename = 'moontv-backup.dat';
      let fileData = '';
      let exportDone = false;
      let reading = true;

      while (reading) {
        const { done, value } = await reader.read();
        if (done) {
          reading = false;
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // 按空行分割 SSE 事件
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // 保留最后一个不完整的事件

        for (const event of events) {
          const dataLine = event.split('\n').find(line => line.startsWith('data:'));
          if (!dataLine) continue;

          const dataStr = dataLine.slice(5).trim();
          if (!dataStr) continue;

          let data: any;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }

          switch (data.type) {
            case 'stage':
              updateExportProgress(data.percent ?? 0, data.message || '');
              appendExportLog(data.message || '');
              break;
            case 'user':
              // 更新进度条（user 事件携带 percent），并显示当前用户
              if (typeof data.percent === 'number') {
                updateExportProgress(data.percent, data.message || '');
              } else {
                setExportProgress(prev => ({
                  ...prev,
                  currentMessage: data.message || '',
                }));
              }
              appendExportLog(data.message || '');
              break;
            case 'detail':
              // 仅更新消息，保留进度条百分比
              setExportProgress(prev => ({
                ...prev,
                currentMessage: data.message || '',
              }));
              appendExportLog(data.message || '');
              break;
            case 'file_start':
              filename = data.filename || filename;
              updateExportProgress(data.percent ?? 95, '正在生成备份文件...');
              appendExportLog(`生成备份文件: ${filename}`);
              break;
            case 'chunk':
              // 拼接加密数据分块
              fileData += data.data || '';
              break;
            case 'file_end':
              updateExportProgress(data.percent ?? 100, '文件生成完成，准备下载...');
              break;
            case 'error':
              setExportProgress(prev => ({
                ...prev,
                isError: true,
                currentMessage: data.message || '导出失败',
              }));
              appendExportLog(`错误: ${data.message || '导出失败'}`, 'error');
              throw new Error(data.message || '导出失败');
            case 'done':
              exportDone = true;
              updateExportProgress(100, '导出完成');
              appendExportLog('导出完成', 'success');
              break;
            default:
              break;
          }
        }
      }

      // 流结束后，如果成功则触发文件下载
      if (exportDone && fileData) {
        // 关闭进度弹窗
        setExportProgress(prev => ({ ...prev, isOpen: false }));

        // 下载文件（加密数据为 base64 字符串文本）
        const blob = new Blob([fileData], { type: 'application/octet-stream' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        a.style.position = 'fixed';
        a.style.top = '0';
        a.style.left = '0';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        showAlert({
          type: 'success',
          title: '导出成功',
          message: '数据已成功导出，请妥善保管备份文件和密码',
          timer: 3000,
        });

        setExportPassword('');
      } else {
        // 流结束但没有 done 事件（异常中断）
        setExportProgress(prev => ({ ...prev, isError: true, currentMessage: '导出中断' }));
        appendExportLog('导出中断，未收到完成信号', 'error');
      }
    } catch (error) {
      // 错误时保持进度弹窗打开并显示错误
      setExportProgress(prev => ({
        ...prev,
        isError: true,
        currentMessage: error instanceof Error ? error.message : '导出过程中发生错误',
      }));
      appendExportLog(error instanceof Error ? error.message : '导出过程中发生错误', 'error');
    } finally {
      setIsExporting(false);
    }
  };

  // 文件选择处理
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
    }
  };

  // 导入数据（SSE 流式读取进度）
  const handleImport = async () => {
    if (!selectedFile) {
      showAlert({
        type: 'error',
        title: '错误',
        message: '请选择备份文件',
      });
      return;
    }

    if (!importPassword.trim()) {
      showAlert({
        type: 'error',
        title: '错误',
        message: '请输入解密密码',
      });
      return;
    }

    // 打开进度弹窗
    setImportProgress({
      isOpen: true,
      percent: 0,
      currentMessage: '准备导入...',
      logs: [],
      isError: false,
    });

    try {
      setIsImporting(true);

      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('password', importPassword);

      const response = await fetch('/api/admin/data_migration/import', {
        method: 'POST',
        body: formData,
      });

      // 如果返回的不是 SSE 流（如 JSON 错误），则按普通 JSON 处理
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        let errorMsg = `导入失败: ${response.status}`;
        try {
          const errData = await response.json();
          errorMsg = errData.error || errorMsg;
        } catch {
          // 忽略解析错误
        }
        throw new Error(errorMsg);
      }

      if (!response.body) {
        throw new Error('浏览器不支持流式读取');
      }

      // 读取 SSE 流
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let importResult: any = null;
      let reading = true;

      while (reading) {
        const { done, value } = await reader.read();
        if (done) {
          reading = false;
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // 按空行分割 SSE 事件
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // 保留最后一个不完整的事件

        for (const event of events) {
          const dataLine = event.split('\n').find(line => line.startsWith('data:'));
          if (!dataLine) continue;

          const dataStr = dataLine.slice(5).trim();
          if (!dataStr) continue;

          let data: any;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }

          switch (data.type) {
            case 'stage':
              updateImportProgress(data.percent ?? 0, data.message || '');
              appendImportLog(data.message || '');
              break;
            case 'user':
              // 仅更新当前消息，保留进度条百分比（user 事件不携带 percent）
              setImportProgress(prev => ({
                ...prev,
                currentMessage: data.message || '',
              }));
              appendImportLog(data.message || '');
              break;
            case 'detail':
              // 显示当前正在导入的具体内容（仅更新消息，保留进度条百分比不变，
              // 避免用闭包中的旧 percent 覆盖实时进度导致进度条跳回 0）
              setImportProgress(prev => ({
                ...prev,
                currentMessage: data.message || '',
              }));
              appendImportLog(data.message || '');
              break;
            case 'progress':
              // 更新进度条（使用服务端计算的 percent）
              if (typeof data.percent === 'number') {
                updateImportProgress(data.percent, data.message || `${data.dataType || ''} ${data.done}/${data.total}`);
              }
              break;
            case 'error':
              setImportProgress(prev => ({
                ...prev,
                isError: true,
                currentMessage: data.message || '导入失败',
              }));
              appendImportLog(`错误: ${data.message || '导入失败'}`, 'error');
              throw new Error(data.message || '导入失败');
            case 'done':
              importResult = data;
              updateImportProgress(100, '导入完成');
              appendImportLog('导入完成', 'success');
              break;
            default:
              break;
          }
        }
      }

      // 流结束后，如果成功则显示成功弹窗
      if (importResult) {
        setImportProgress(prev => ({ ...prev, isOpen: false }));
        showAlert({
          type: 'success',
          title: '导入成功',
          html: `
            <div class="text-left">
              <p><strong>导入完成！</strong></p>
              <p class="mt-2">导入的用户数量: ${importResult.importedUsers}</p>
              <p>备份时间: ${new Date(importResult.timestamp).toLocaleString('zh-CN')}</p>
              <p>服务器版本: ${importResult.serverVersion || '未知版本'}</p>
              <p class="mt-3 text-orange-600">请刷新页面以查看最新数据。</p>
            </div>
          `,
          confirmText: '刷新页面',
          showConfirm: true,
          onConfirm: async () => {
            // 清理状态
            setSelectedFile(null);
            setImportPassword('');
            if (fileInputRef.current) {
              fileInputRef.current.value = '';
            }

            // 刷新配置
            if (onRefreshConfig) {
              await onRefreshConfig();
            }

            // 刷新页面
            window.location.reload();
          },
        });
      } else {
        // 流结束但没有 done 事件（异常中断）
        setImportProgress(prev => ({ ...prev, isError: true, currentMessage: '导入中断' }));
        appendImportLog('导入中断，未收到完成信号', 'error');
      }
    } catch (error) {
      // 错误时保持进度弹窗打开并显示错误，同时关闭导入状态
      setImportProgress(prev => ({
        ...prev,
        isError: true,
        currentMessage: error instanceof Error ? error.message : '导入过程中发生错误',
      }));
      appendImportLog(error instanceof Error ? error.message : '导入过程中发生错误', 'error');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* 简洁警告提示 */}
        <div className="flex items-center gap-3 p-4 border border-amber-200 dark:border-amber-700 rounded-lg bg-amber-50/30 dark:bg-amber-900/5">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <p className="text-sm text-amber-800 dark:text-amber-200">
            数据迁移操作请谨慎，确保已备份重要数据
          </p>
        </div>

        {/* 主要操作区域 - 响应式布局 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 数据导出 */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-white dark:bg-gray-800 hover:shadow-sm transition-shadow flex flex-col">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center">
                <Download className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">数据导出</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">创建加密备份文件</p>
              </div>
            </div>

            <div className="flex-1 flex flex-col">
              <div className="space-y-4">
                {/* 密码输入 */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    <Lock className="w-4 h-4" />
                    加密密码
                  </label>
                  <input
                    type="password"
                    value={exportPassword}
                    onChange={(e) => setExportPassword(e.target.value)}
                    placeholder="设置强密码保护备份文件"
                    className="w-full px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                    disabled={isExporting}
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    导入时需要使用相同密码
                  </p>
                </div>

                {/* 备份内容列表 */}
                <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
                  <p className="font-medium text-gray-700 dark:text-gray-300 mb-2">备份内容：</p>
                  <div className="grid grid-cols-2 gap-1">
                    <div>• 管理配置</div>
                    <div>• 用户数据</div>
                    <div>• 播放记录</div>
                    <div>• 收藏夹</div>
                    <div>• 追更</div>
                    <div>• 今日新更</div>
                    <div>• 搜索历史</div>
                    <div>• 跳过片头片尾</div>
                  </div>
                </div>
              </div>

              {/* 导出按钮 */}
              <button
                onClick={handleExport}
                disabled={isExporting || !exportPassword.trim()}
                className={`w-full px-4 py-2.5 rounded-lg font-medium transition-colors mt-10 ${isExporting || !exportPassword.trim()
                  ? 'bg-gray-100 dark:bg-gray-700 cursor-not-allowed text-gray-500 dark:text-gray-400'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}
              >
                {isExporting ? (
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    导出中...
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2">
                    <Download className="w-4 h-4" />
                    导出数据
                  </div>
                )}
              </button>
            </div>
          </div>

          {/* 数据导入 */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-white dark:bg-gray-800 hover:shadow-sm transition-shadow flex flex-col">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-8 h-8 rounded-lg bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
                <Upload className="w-4 h-4 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">数据导入</h3>
                <p className="text-sm text-red-600 dark:text-red-400">⚠️ 将清空现有数据</p>
              </div>
            </div>

            <div className="flex-1 flex flex-col">
              <div className="space-y-4">
                {/* 文件选择 */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    <FileCheck className="w-4 h-4" />
                    备份文件
                    {selectedFile && (
                      <span className="ml-auto text-xs text-green-600 dark:text-green-400 font-normal">
                        {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                      </span>
                    )}
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".dat"
                    onChange={handleFileSelect}
                    className="w-full px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-red-500 focus:border-red-500 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-gray-50 dark:file:bg-gray-600 file:text-gray-700 dark:file:text-gray-300 hover:file:bg-gray-100 dark:hover:file:bg-gray-500 transition-colors"
                    disabled={isImporting}
                  />
                </div>

                {/* 密码输入 */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    <Lock className="w-4 h-4" />
                    解密密码
                  </label>
                  <input
                    type="password"
                    value={importPassword}
                    onChange={(e) => setImportPassword(e.target.value)}
                    placeholder="输入导出时的加密密码"
                    className="w-full px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-colors"
                    disabled={isImporting}
                  />
                </div>
              </div>

              {/* 导入按钮 */}
              <button
                onClick={handleImport}
                disabled={isImporting || !selectedFile || !importPassword.trim()}
                className={`w-full px-4 py-2.5 rounded-lg font-medium transition-colors mt-10 ${isImporting || !selectedFile || !importPassword.trim()
                  ? 'bg-gray-100 dark:bg-gray-700 cursor-not-allowed text-gray-500 dark:text-gray-400'
                  : 'bg-red-600 hover:bg-red-700 text-white'
                  }`}
              >
                {isImporting ? (
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    导入中...
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2">
                    <Upload className="w-4 h-4" />
                    导入数据
                  </div>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 弹窗组件 */}
      <AlertModal
        isOpen={alertModal.isOpen}
        onClose={hideAlert}
        type={alertModal.type}
        title={alertModal.title}
        message={alertModal.message}
        html={alertModal.html}
        confirmText={alertModal.confirmText}
        onConfirm={alertModal.onConfirm}
        showConfirm={alertModal.showConfirm}
        timer={alertModal.timer}
      />

      {/* 导入进度弹窗 */}
      <ImportProgressModal
        isOpen={importProgress.isOpen}
        percent={importProgress.percent}
        currentMessage={importProgress.currentMessage}
        logs={importProgress.logs}
        isError={importProgress.isError}
      />

      {/* 导出进度弹窗 */}
      <ImportProgressModal
        isOpen={exportProgress.isOpen}
        percent={exportProgress.percent}
        currentMessage={exportProgress.currentMessage}
        logs={exportProgress.logs}
        isError={exportProgress.isError}
        title="正在导出数据"
        errorTitle="导出失败"
        iconType="export"
      />
    </>
  );
};

export default DataMigration;