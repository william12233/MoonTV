'use client';

export interface BangumiCalendarData {
  weekday: {
    en: string;
  };
  items: {
    id: number;
    name: string;
    name_cn: string;
    rating: {
      score: number;
    };
    air_date: string;
    images: {
      large: string;
      common: string;
      medium: string;
      small: string;
      grid: string;
    };
  }[];
}

export async function GetBangumiCalendarData(): Promise<BangumiCalendarData[]> {
  try {
    const response = await fetch('https://api.bgm.tv/calendar');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((item: BangumiCalendarData) => ({
      ...item,
      items: item.items.filter((bangumiItem) => bangumiItem.images),
    }));
  } catch (error) {
    console.error('获取 Bangumi 日历失败:', error);
    return [];
  }
}
