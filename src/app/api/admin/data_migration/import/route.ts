/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';
import { inflate } from 'pako';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { configSelfCheck, setCachedConfig } from '@/lib/config';
import { SimpleCrypto } from '@/lib/crypto';
import { db } from '@/lib/db';

export const runtime = 'edge';

// pako 的 gunzip 是同步的，不需要 promisify

// 分批并行执行写入任务，控制并发度以提升导入速度，同时避免一次性发起过多请求
// 每处理完一批就通过 onBatchDone 回调推送一次进度
async function runInBatches<T>(
  items: T[],
  batchSize: number,
  task: (item: T) => Promise<void>,
  onBatchDone: (doneCount: number, totalCount: number) => void
): Promise<void> {
  let doneCount = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(task));
    doneCount += batch.length;
    onBatchDone(doneCount, items.length);
  }
}

// 将对象编码为 SSE 事件文本
function encodeSSE(data: any): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// 统计单个用户需要导入的数据记录总数（用于按总记录条数计算进度）
function countUserRecords(user: any): number {
  let count = 0;
  if (user.playRecords) {
    count += Object.keys(user.playRecords).length;
  }
  if (user.favorites) {
    count += Object.keys(user.favorites).length;
  }
  if (user.followings) {
    count += Object.keys(user.followings).filter((key) => {
      const [source, id] = key.split('+');
      return !!(source && id);
    }).length;
  }
  if (user.todayUpdated) {
    count += 1; // 今日新更整体算 1 条
  }
  if (user.searchHistory && Array.isArray(user.searchHistory)) {
    count += user.searchHistory.length;
  }
  if (user.skipConfigs) {
    count += Object.keys(user.skipConfigs).filter((key) => {
      const [source, id] = key.split('+');
      return !!(source && id);
    }).length;
  }
  return count;
}

export async function POST(req: NextRequest) {
  // 检查存储类型
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '不支持本地存储进行数据迁移' },
      { status: 400 }
    );
  }

  // 验证身份和权限
  const authInfo = getAuthInfoFromCookie(req);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  // 检查用户权限（只有站长可以导入数据）
  if (authInfo.username !== process.env.USERNAME) {
    return NextResponse.json({ error: '权限不足，只有站长可以导入数据' }, { status: 401 });
  }

  // 解析表单数据
  const formData = await req.formData();
  const file = formData.get('file') as File;
  const password = formData.get('password') as string;

  if (!file) {
    return NextResponse.json({ error: '请选择备份文件' }, { status: 400 });
  }

  if (!password) {
    return NextResponse.json({ error: '请提供解密密码' }, { status: 400 });
  }

  // 读取文件内容
  const encryptedData = await file.text();

  // 解密数据
  let decryptedData: string;
  try {
    decryptedData = SimpleCrypto.decrypt(encryptedData, password);
  } catch (error) {
    return NextResponse.json({ error: '解密失败，请检查密码是否正确' }, { status: 400 });
  }

  // 解压缩数据
  const compressedBuffer = Buffer.from(decryptedData, 'base64');
  const decompressedBuffer = inflate(compressedBuffer);
  const decompressedData = new TextDecoder().decode(decompressedBuffer);

  // 解析JSON数据
  let importData: any;
  try {
    importData = JSON.parse(decompressedData);
  } catch (error) {
    return NextResponse.json({ error: '备份文件格式错误' }, { status: 400 });
  }

  // 验证数据格式
  if (!importData.data || !importData.data.adminConfig || !importData.data.userData) {
    return NextResponse.json({ error: '备份文件格式无效' }, { status: 400 });
  }

  const userData = importData.data.userData;
  const usernames = Object.keys(userData);
  const TOTAL_USERS = usernames.length;
  // 并行写入的批次大小（控制并发度，兼顾速度与稳定性）
  const BATCH_SIZE = 50;

  // 预统计所有用户所有类型的数据记录总数（作为进度条分母）
  const totalRecords = usernames.reduce((sum, username) => {
    return sum + countUserRecords(userData[username]);
  }, 0);

  // 创建 SSE 流
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 推送 SSE 事件
      const send = (data: any) => {
        try {
          controller.enqueue(encoder.encode(encodeSSE(data)));
        } catch (err) {
          // 客户端断开时忽略
        }
      };

      // 已处理的数据记录数（作为进度条分子）
      let processedRecords = 0;

      // 根据已处理记录数计算并推送全局进度
      const sendProgress = (dataType: string, done: number, total: number) => {
        const percent =
          totalRecords > 0
            ? Math.min(100, Math.round(((processedRecords + done) / totalRecords) * 100))
            : 0;
        send({
          type: 'progress',
          dataType,
          done,
          total,
          percent,
          message: `${dataType} ${done}/${total}`,
        });
      };

      try {
        // 阶段 1：清空现有数据
        send({ type: 'stage', message: '正在清空现有数据...', percent: 0 });
        await db.clearAllData();

        // 阶段 2：导入管理员配置
        send({ type: 'stage', message: '正在导入管理员配置...', percent: 2 });
        importData.data.adminConfig = configSelfCheck(importData.data.adminConfig);
        await db.saveAdminConfig(importData.data.adminConfig);
        await setCachedConfig(importData.data.adminConfig);

        // 阶段 3：逐用户导入
        let userIndex = 0;
        for (const username of usernames) {
          const user = userData[username];
          userIndex++;

          send({
            type: 'user',
            message: `正在处理用户 ${userIndex}/${TOTAL_USERS}: ${username}`,
            username,
            userIndex,
            totalUsers: TOTAL_USERS,
          });

          // 重新注册用户（包含密码）
          if (user.password) {
            send({ type: 'detail', message: `注册用户: ${username}` });
            await db.registerUser(username, String(user.password));
          }

          // 导入播放记录（优先使用 D1 批量导入，规避单次 invocation 的 subrequest 限制）
          if (user.playRecords) {
            const entries = Object.entries(user.playRecords);
            send({
              type: 'detail',
              message: `导入播放记录 (${entries.length} 条)...`,
              dataType: '播放记录',
              total: entries.length,
            });
            const batched = await db.batchImportPlayRecords(
              username,
              entries as Array<[string, any]>,
              (done) => {
                sendProgress('播放记录', done, entries.length);
              }
            );
            if (!batched) {
              // 非 D1 存储：分批并行逐条写入
              await runInBatches(
                entries,
                BATCH_SIZE,
                async ([key, record]) => {
                  await (db as any).storage.setPlayRecord(username, key, record);
                },
                (done) => {
                  sendProgress('播放记录', done, entries.length);
                }
              );
            }
            processedRecords += entries.length;
          }

          // 导入收藏夹（优先使用 D1 批量导入）
          if (user.favorites) {
            const entries = Object.entries(user.favorites);
            send({
              type: 'detail',
              message: `导入收藏夹 (${entries.length} 条)...`,
              dataType: '收藏夹',
              total: entries.length,
            });
            const batched = await db.batchImportFavorites(
              username,
              entries as Array<[string, any]>,
              (done) => {
                sendProgress('收藏夹', done, entries.length);
              }
            );
            if (!batched) {
              await runInBatches(
                entries,
                BATCH_SIZE,
                async ([key, favorite]) => {
                  await (db as any).storage.setFavorite(username, key, favorite);
                },
                (done) => {
                  sendProgress('收藏夹', done, entries.length);
                }
              );
            }
            processedRecords += entries.length;
          }

          // 导入追更（优先使用 D1 批量导入）
          if (user.followings) {
            const entries = Object.entries(user.followings).filter(([key]) => {
              const [source, id] = key.split('+');
              return !!(source && id);
            });
            send({
              type: 'detail',
              message: `导入追更 (${entries.length} 条)...`,
              dataType: '追更',
              total: entries.length,
            });
            const batched = await db.batchImportFollowings(
              username,
              entries as Array<[string, any]>,
              (done) => {
                sendProgress('追更', done, entries.length);
              }
            );
            if (!batched) {
              await runInBatches(
                entries,
                BATCH_SIZE,
                async ([key, following]) => {
                  const [source, id] = key.split('+');
                  await db.saveFollowing(username, source, id, following as any);
                },
                (done) => {
                  sendProgress('追更', done, entries.length);
                }
              );
            }
            processedRecords += entries.length;
          }

          // 导入今日新更
          if (user.todayUpdated) {
            const todayUpdated = user.todayUpdated as any;
            // 兜底处理：确保 date 字段存在，避免 D1 的 NOT NULL 约束报错
            if (!todayUpdated.date) {
              todayUpdated.date = new Date().toISOString().slice(0, 10);
            }
            send({ type: 'detail', message: `导入今日新更 (date=${todayUpdated.date})...`, dataType: '今日新更' });
            const batched = await db.batchImportTodayUpdated(username, todayUpdated);
            if (!batched) {
              await db.setTodayUpdated(username, todayUpdated);
            }
            processedRecords += 1;
            sendProgress('今日新更', 1, 1);
          }

          // 导入搜索历史（优先使用 D1 批量导入；非 D1 的 list 操作需保持顺序，故串行）
          if (user.searchHistory && Array.isArray(user.searchHistory)) {
            const history = [...user.searchHistory];
            send({
              type: 'detail',
              message: `导入搜索历史 (${history.length} 条)...`,
              dataType: '搜索历史',
              total: history.length,
            });
            const batched = await db.batchImportSearchHistory(
              username,
              history,
              (done) => {
                sendProgress('搜索历史', done, history.length);
              }
            );
            if (!batched) {
              let historyDone = 0;
              for (const keyword of history.reverse()) { // 反转以保持顺序
                await db.addSearchHistory(username, keyword);
                historyDone++;
                sendProgress('搜索历史', historyDone, history.length);
              }
            }
            processedRecords += history.length;
          }

          // 导入跳过片头片尾配置（优先使用 D1 批量导入）
          if (user.skipConfigs) {
            const entries = Object.entries(user.skipConfigs).filter(([key]) => {
              const [source, id] = key.split('+');
              return !!(source && id);
            });
            send({
              type: 'detail',
              message: `导入跳过配置 (${entries.length} 条)...`,
              dataType: '跳过配置',
              total: entries.length,
            });
            const batched = await db.batchImportSkipConfigs(
              username,
              entries as Array<[string, any]>,
              (done) => {
                sendProgress('跳过配置', done, entries.length);
              }
            );
            if (!batched) {
              await runInBatches(
                entries,
                BATCH_SIZE,
                async ([key, skipConfig]) => {
                  const [source, id] = key.split('+');
                  await db.setSkipConfig(username, source, id, skipConfig as any);
                },
                (done) => {
                  sendProgress('跳过配置', done, entries.length);
                }
              );
            }
            processedRecords += entries.length;
          }

          send({ type: 'detail', message: `用户 ${username} 处理完成` });
        }

        // 完成
        send({
          type: 'done',
          message: '数据导入成功',
          importedUsers: TOTAL_USERS,
          timestamp: importData.timestamp,
          serverVersion: typeof importData.serverVersion === 'string' ? importData.serverVersion : '未知版本',
          percent: 100,
        });
        controller.close();
      } catch (error) {
        console.error('数据导入失败:', error);
        const errMsg = error instanceof Error ? error.message : '导入失败';
        // 打印完整错误信息（含堆栈），便于定位键约束等底层问题
        if (error instanceof Error) {
          console.error('错误名称:', error.name);
          console.error('错误堆栈:', error.stack);
          const anyErr = error as any;
          if (anyErr.cause) {
            console.error('错误原因(cause):', anyErr.cause);
          }
        }
        send({ type: 'error', message: errMsg });
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
