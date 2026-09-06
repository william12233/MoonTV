import { AdminConfig } from './admin.types';

// 播放记录数据结构
export interface PlayRecord {
  title: string;
  source_name: string;
  cover: string;
  year: string;
  index: number; // 第几集
  total_episodes: number; // 总集数
  play_time: number; // 播放进度（秒）
  total_time: number; // 总进度（秒）
  save_time: number; // 记录保存时间（时间戳）
  search_title: string; // 搜索时使用的标题
}

// 收藏数据结构
export interface Favorite {
  source_name: string;
  total_episodes: number; // 总集数
  title: string;
  year: string;
  cover: string;
  save_time: number; // 记录保存时间（时间戳）
  search_title: string; // 搜索时使用的标题
}

// 追更数据结构
export interface Following {
  source_name: string;
  total_episodes: number;
  watched_episodes: number;
  title: string;
  year: string;
  cover: string;
  save_time: number;
  search_title: string;
  source?: string;
  id?: string;
}

// 存储接口
export interface IStorage {
  // 播放记录相关
  getPlayRecord(userName: string, key: string): Promise<PlayRecord | null>;
  setPlayRecord(
    userName: string,
    key: string,
    record: PlayRecord
  ): Promise<void>;
  getAllPlayRecords(userName: string): Promise<{ [key: string]: PlayRecord }>;
  deletePlayRecord(userName: string, key: string): Promise<void>;

  // 收藏相关
  getFavorite(userName: string, key: string): Promise<Favorite | null>;
  setFavorite(userName: string, key: string, favorite: Favorite): Promise<void>;
  getAllFavorites(userName: string): Promise<{ [key: string]: Favorite }>;
  deleteFavorite(userName: string, key: string): Promise<void>;

  // 追更相关
  getFollowing(userName: string, key: string): Promise<Following | null>;
  setFollowing(
    userName: string,
    key: string,
    following: Following
  ): Promise<void>;
  getAllFollowings(userName: string): Promise<{ [key: string]: Following }>;
  deleteFollowing(userName: string, key: string): Promise<void>;

  // 用户相关
  registerUser(userName: string, password: string): Promise<void>;
  verifyUser(userName: string, password: string): Promise<boolean>;
  // 检查用户是否存在（无需密码）
  checkUserExist(userName: string): Promise<boolean>;
  // 修改用户密码
  changePassword(userName: string, newPassword: string): Promise<void>;
  // 删除用户（包括密码、搜索历史、播放记录、收藏夹）
  deleteUser(userName: string): Promise<void>;

  // 搜索历史相关
  getSearchHistory(userName: string): Promise<string[]>;
  addSearchHistory(userName: string, keyword: string): Promise<void>;
  deleteSearchHistory(userName: string, keyword?: string): Promise<void>;

  // 用户列表
  getAllUsers(): Promise<string[]>;

  // 管理员配置相关
  getAdminConfig(): Promise<AdminConfig | null>;
  setAdminConfig(config: AdminConfig): Promise<void>;

  // 跳过片头片尾配置相关
  getSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<SkipConfig | null>;
  setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void>;
  deleteSkipConfig(userName: string, source: string, id: string): Promise<void>;
  getAllSkipConfigs(userName: string): Promise<{ [key: string]: SkipConfig }>;

  // “今日新更”相关（保留一天、跟随账号跨设备）
  getTodayUpdated(userName: string): Promise<TodayUpdatedRecord | null>;
  setTodayUpdated(
    userName: string,
    record: TodayUpdatedRecord
  ): Promise<void>;

  // 数据清理
  clearAllData(): Promise<void>;
}

// 搜索结果数据结构
export interface SearchResult {
  id: string;
  title: string;
  poster: string;
  episodes: string[];
  episodes_titles: string[];
  source: string;
  source_name: string;
  class?: string;
  year: string;
  desc?: string;
  type_name?: string;
  douban_id?: number;
}

// 豆瓣数据结构
export interface DoubanItem {
  id: string;
  title: string;
  poster: string;
  rate: string;
  year: string;
}

export interface DoubanResult {
  code: number;
  message: string;
  list: DoubanItem[];
}

// 跳过片头片尾配置数据结构
export interface SkipConfig {
  enable: boolean; // 是否启用跳过片头片尾
  intro_time: number; // 片头时间（秒）
  outro_time: number; // 片尾时间（秒）
}

// “今日新更”条目数据结构（追更页当天检测到有新集数更新的影片）
export interface TodayUpdatedItem {
  source: string;
  id: string;
  title: string;
  poster: string;
  episodes: number;
  watchedEpisodes: number;
  unwatchedEpisodes: number;
  source_name: string;
  year: string;
  save_time: number;
  oldEpisodes: number;
  newEpisodes: number;
}

// “今日新更”记录：按日期（YYYY-MM-DD）保存当天条目，跨天自动清空
export interface TodayUpdatedRecord {
  date: string; // YYYY-MM-DD
  items: TodayUpdatedItem[];
}

// 弹幕数据结构
export interface DanmakuItem {
  time: number; // 弹幕出现时间（秒）
  type: number; // 弹幕类型：1-滚动，2-顶部，3-底部
  color: number; // 弹幕颜色（十进制）
  text: string; // 弹幕文本
  size?: number; // 字体大小（可选）
  pool?: number; // 弹幕池（可选）
}

// 弹幕 API 响应数据结构（实际格式）
export interface DanmakuComment {
  cid: number;
  p: string; // 属性字符串，格式: "时间,类型,颜色,作者"
  m: string; // 弹幕文本内容
  t: number; // 时间（秒）
}

export interface DanmakuResponse {
  count?: number;
  comments?: DanmakuComment[]; // 实际的弹幕数组
  // 兼容其他格式
  code?: number;
  message?: string;
  data?: DanmakuItem[];
}
