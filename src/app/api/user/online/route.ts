/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { configSelfCheck, getConfig } from '@/lib/config';
import { getStorage } from '@/lib/db';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { ok: false, reason: 'localstorage 模式不支持管理员配置写入' },
      { status: 400 }
    );
  }

  try {
    const auth = getAuthInfoFromCookie(request);
    if (!auth?.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const username = auth.username;
    const adminConfig = await getConfig();

    const userEntry = adminConfig.UserConfig.Users.find((u) => u.username === username);
    if (!userEntry) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    }
    if (userEntry.banned) {
      return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
    }

    userEntry.lastOnline = Date.now();

    const storage = getStorage();
    if (storage && typeof (storage as any).setAdminConfig === 'function') {
      await (storage as any).setAdminConfig(configSelfCheck(adminConfig));
    }

    return NextResponse.json({ ok: true, lastOnline: userEntry.lastOnline }, { status: 200 });
  } catch (error) {
    console.error('更新用户上线时间失败:', error);
    return NextResponse.json(
      { error: '更新用户上线时间失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}

