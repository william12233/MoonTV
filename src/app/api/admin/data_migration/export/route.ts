/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';
import { deflate } from 'pako';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { SimpleCrypto } from '@/lib/crypto';
import { db } from '@/lib/db';
import { CURRENT_VERSION } from '@/lib/version';

export const runtime = 'edge';

// pako 的 gzip 是同步的，不需要 promisify

// 将对象编码为 SSE 事件文本
function encodeSSE(data: any): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  try {
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

    // 检查用户权限（只有站长可以导出数据）
    if (authInfo.username !== process.env.USERNAME) {
      return NextResponse.json({ error: '权限不足，只有站长可以导出数据' }, { status: 401 });
    }

    const config = await db.getAdminConfig();
    if (!config) {
      return NextResponse.json({ error: '无法获取配置' }, { status: 500 });
    }

    // 解析请求体获取密码
    const { password } = await req.json();
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: '请提供加密密码' }, { status: 400 });
    }

    // 收集所有数据
    const exportData = {
      timestamp: new Date().toISOString(),
      serverVersion: CURRENT_VERSION,
      data: {
        // 管理员配置
        adminConfig: config,
        // 所有用户数据
        userData: {} as { [username: string]: any }
      }
    };

    // 站长用户名（用于导出其密码等）
    const adminUsername = process.env.USERNAME as string;

    // 获取所有用户
    let allUsers = await db.getAllUsers();
    // 添加站长用户
    allUsers.push(adminUsername);
    allUsers = Array.from(new Set(allUsers));
    const TOTAL_USERS = allUsers.length;

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

        try {
          // 阶段 1：开始导出
          send({ type: 'stage', message: '正在导出管理员配置...', percent: 0 });

          // 阶段 2：逐用户收集数据
          let userIndex = 0;
          for (const username of allUsers) {
            userIndex++;
            // 用户进度：5% ~ 90%
            const percent = Math.round(5 + (userIndex / TOTAL_USERS) * 85);

            send({
              type: 'user',
              message: `正在导出用户 ${userIndex}/${TOTAL_USERS}: ${username}`,
              username,
              userIndex,
              totalUsers: TOTAL_USERS,
              percent,
            });

            // 并行读取各类型数据以提升导出速度
            const [
              playRecords,
              favorites,
              followings,
              todayUpdated,
              searchHistory,
              skipConfigs,
              userPassword
            ] = await Promise.all([
              db.getAllPlayRecords(username),
              db.getAllFavorites(username),
              db.getAllFollowings(username),
              db.getTodayUpdated(username),
              db.getSearchHistory(username),
              db.getAllSkipConfigs(username),
              getUserPassword(username)
            ]);

            // 记录各类型条数用于日志展示
            const counts: string[] = [];
            const playCount = Object.keys(playRecords || {}).length;
            const favCount = Object.keys(favorites || {}).length;
            const folCount = Object.keys(followings || {}).length;
            const searchCount = Array.isArray(searchHistory) ? searchHistory.length : 0;
            const skipCount = Object.keys(skipConfigs || {}).length;
            if (playCount) counts.push(`播放记录${playCount}`);
            if (favCount) counts.push(`收藏${favCount}`);
            if (folCount) counts.push(`追更${folCount}`);
            if (todayUpdated) counts.push('今日新更');
            if (searchCount) counts.push(`搜索历史${searchCount}`);
            if (skipCount) counts.push(`跳过配置${skipCount}`);
            send({
              type: 'detail',
              message: `用户 ${username}: ${counts.length ? counts.join('、') : '无数据'}`,
              percent,
            });

            exportData.data.userData[username] = {
              // 播放记录
              playRecords,
              // 收藏夹
              favorites,
              // 追更
              followings,
              // 今日新更
              todayUpdated,
              // 搜索历史
              searchHistory,
              // 跳过片头片尾配置
              skipConfigs,
              // 用户密码
              password: userPassword
            };
          }

          // 覆盖站长密码
          exportData.data.userData[adminUsername].password = process.env.PASSWORD as string;

          // 阶段 3：压缩并加密
          send({ type: 'stage', message: '正在压缩并加密数据...', percent: 92 });

          // 将数据转换为JSON字符串
          const jsonData = JSON.stringify(exportData);

          // 先压缩数据
          const compressedData = deflate(jsonData);

          // 使用提供的密码加密压缩后的数据
          const compressedBase64 = Buffer.from(compressedData).toString('base64');
          const encryptedData = SimpleCrypto.encrypt(compressedBase64, password);

          // 生成文件名
          const now = new Date();
          const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
          const filename = `moontv-backup-${timestamp}.dat`;

          // 阶段 4：分块推送加密后的文件数据（base64 字符串）
          send({ type: 'file_start', filename, percent: 95 });

          // 将加密数据分块推送，避免单条 SSE 事件过大
          const CHUNK_SIZE = 64 * 1024; // 64KB
          for (let i = 0; i < encryptedData.length; i += CHUNK_SIZE) {
            send({
              type: 'chunk',
              data: encryptedData.slice(i, i + CHUNK_SIZE),
            });
          }

          send({ type: 'file_end', percent: 100 });
          send({
            type: 'done',
            message: '数据导出成功',
            exportedUsers: TOTAL_USERS,
            filename,
            percent: 100,
          });
          controller.close();
        } catch (error) {
          console.error('数据导出失败:', error);
          const errMsg = error instanceof Error ? error.message : '导出失败';
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
  } catch (error) {
    console.error('数据导出失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导出失败' },
      { status: 500 }
    );
  }
}

// 辅助函数：获取用户密码（通过数据库直接访问）
async function getUserPassword(username: string): Promise<string | null> {
  try {
    const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
    
    // D1 数据库存储
    if (storageType === 'd1') {
      const d1Db = (process.env as any).DB;
      if (d1Db) {
        const result = await d1Db
          .prepare('SELECT password FROM users WHERE username = ?')
          .bind(username)
          .first() as { password: string } | null;
        return result?.password || null;
      }
      return null;
    }
    
    // Redis/Upstash 存储
    const storage = (db as any).storage;
    if (storage && typeof storage.client?.get === 'function') {
      const passwordKey = `u:${username}:pwd`;
      const password = await storage.client.get(passwordKey);
      return password;
    }
    
    return null;
  } catch (error) {
    console.error(`获取用户 ${username} 密码失败:`, error);
    return null;
  }
}
