import { API_BASE, UPLOADS_BASE, USER_AGENT, cleanText, pickLocalized, type MdManga } from "./common";

/** 相邻 API 请求的最小间隔：MangaDex 全局限速约 5 req/s */
const MIN_GAP_MS = 220;

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + MIN_GAP_MS - now;
  if (wait > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export type QueryValue = string | number | boolean | ReadonlyArray<string | number> | null | undefined;

/** 构造查询串，数组参数输出为 `key[]=v1&key[]=v2` */
export function buildQuery(params: Record<string, QueryValue> = {}): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      // key 已带 [] 时不再重复追加，避免出现 includes[][]=x
      const arrayKey = key.endsWith("[]") ? key : `${key}[]`;
      for (const item of value) {
        parts.push(`${encodeURIComponent(arrayKey)}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

type Json = Record<string, unknown>;

/** 调用 MangaDex API，统一处理 UA、节流与错误 */
export async function mdGet<T = Json>(
  path: string,
  params: Record<string, QueryValue> = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  await throttle();
  const url = `${API_BASE}${path}${buildQuery(params)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 25000),
    });
  } catch (error) {
    throw new Error(`MangaDex 请求失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (res.status === 429) {
    // 限流不立即失败：等 2 秒重试一次（MangaDex 限速约 5 req/s，批量翻页容易踩）
    await sleep(2000);
    await throttle();
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 25000),
    });
    if (res.status === 429) {
      throw new Error("MangaDex 限流（429），请稍后再试");
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { errors?: Array<{ detail?: string; title?: string }> };
      detail = parsed.errors?.[0]?.detail ?? parsed.errors?.[0]?.title ?? "";
    } catch {
      detail = body.slice(0, 120);
    }
    throw new Error(`MangaDex 返回 ${res.status}${detail ? `：${detail}` : ""}`);
  }

  return (await res.json()) as T;
}

export type MdListResponse = {
  result: string;
  data: MdManga[];
  total: number;
  limit: number;
  offset: number;
};

const LIST_INCLUDES = ["cover_art", "author", "artist"];
const DEFAULT_RATINGS = ["safe", "suggestive"];

export type SearchOptions = {
  title?: string;
  page?: number;
  limit?: number;
  order?: Record<string, string>;
  status?: string[];
  ratings?: string[];
  originalLanguage?: string;
  availableLanguage?: string;
};

/** 搜索 / 排行榜通用列表接口 */
export async function listManga(options: SearchOptions = {}): Promise<MdListResponse> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const page = Math.max(options.page ?? 1, 1);
  const params: Record<string, QueryValue> = {
    limit,
    offset: (page - 1) * limit,
    "includes[]": LIST_INCLUDES,
    "contentRating[]": options.ratings && options.ratings.length > 0 ? options.ratings : DEFAULT_RATINGS,
    hasAvailableChapters: true,
  };
  if (options.title) {
    params.title = options.title;
  }
  if (options.status && options.status.length > 0) {
    params["status[]"] = options.status;
  }
  if (options.originalLanguage) {
    params.originalLanguage = options.originalLanguage;
  }
  if (options.availableLanguage) {
    params["availableTranslatedLanguage[]"] = options.availableLanguage;
  }
  if (options.order) {
    for (const [key, dir] of Object.entries(options.order)) {
      params[`order[${key}]`] = dir;
    }
  } else {
    params["order[relevance]"] = "desc";
  }
  return mdGet<MdListResponse>("/manga", params);
}

export type MdChapter = {
  id: string;
  attributes: {
    volume?: string | null;
    chapter?: string | null;
    title?: string | null;
    translatedLanguage?: string;
    pages?: number;
    externalUrl?: string | null;
    publishAt?: string;
    readableAt?: string;
  };
  relationships?: Array<{ id: string; type: string; attributes?: Record<string, unknown> }>;
};

export type MdChapterFeed = {
  result: string;
  data: MdChapter[];
  total: number;
  limit: number;
  offset: number;
};

export type ChapterFeedResult = {
  /** 可读章节（MangaDex 自托管、有页图） */
  readable: MdChapter[];
  /** 全部章节（含外链到官方平台的） */
  all: MdChapter[];
  /** 外链章节数量 */
  externalCount: number;
};

/** 拉取某作品的章节列表（按用户语言过滤，最多 1000 话） */
export async function fetchChapterFeed(mangaId: string, language: string): Promise<MdChapter[]> {
  const result = await fetchChapterFeedDetailed(mangaId, language);
  return result.readable;
}

/** 拉取章节列表并区分「可读」与「官方外链」 */
export async function fetchChapterFeedDetailed(mangaId: string, language: string): Promise<ChapterFeedResult> {
  const collected: MdChapter[] = [];
  let offset = 0;
  const limit = 500;

  for (let round = 0; round < 2; round += 1) {
    const res = await mdGet<MdChapterFeed>(`/manga/${mangaId}/feed`, {
      limit,
      offset,
      "translatedLanguage[]": language,
      "includes[]": ["scanlation_group"],
      "order[volume]": "asc",
      "order[chapter]": "asc",
      "contentRating[]": DEFAULT_RATINGS,
    });
    const batch = res.data ?? [];
    collected.push(...batch);
    if (batch.length < limit || collected.length >= (res.total ?? 0)) {
      break;
    }
    offset += limit;
  }

  // MangaDex 上有两类章节：自托管（有页图）与外链到官方平台（无页图）
  const readable = collected.filter((chapter) => {
    const attr = chapter.attributes;
    if (attr.externalUrl) {
      return false;
    }
    return (attr.pages ?? 0) > 0;
  });

  return {
    readable,
    all: collected,
    externalCount: collected.filter((chapter) => Boolean(chapter.attributes?.externalUrl)).length,
  };
}

export type AtHomeResponse = {
  result: string;
  baseUrl: string;
  chapter: {
    hash: string;
    data: string[];
    dataSaver: string[];
  };
};

/** 获取章节图片服务地址 */
export async function fetchAtHome(chapterId: string, dataSaver: boolean): Promise<AtHomeResponse> {
  return mdGet<AtHomeResponse>(`/at-home/server/${chapterId}`, dataSaver ? { forcePort443: true } : { forcePort443: true });
}

/** 拼接章节图片完整地址 */
export function buildImageUrl(atHome: AtHomeResponse, fileName: string, dataSaver: boolean): string {
  const base = cleanText(atHome.baseUrl).replace(/\/$/, "");
  const hash = atHome.chapter?.hash ?? "";
  const quality = dataSaver ? "data-saver" : "data";
  if (!base || !hash || !fileName) {
    return "";
  }
  return `${base}/${quality}/${hash}/${fileName}`;
}

/** 章节显示名：优先「第 X 话 - 标题」 */
export function chapterDisplayName(chapter: MdChapter): string {
  const attr = chapter.attributes ?? {};
  const number = cleanText(attr.chapter);
  const title = cleanText(attr.title);
  const volume = cleanText(attr.volume);
  const prefix = number ? `第 ${number} 话` : "无编号";
  const volumeText = volume ? `卷 ${volume} ` : "";
  return `${volumeText}${prefix}${title ? ` · ${title}` : ""}`;
}

export { UPLOADS_BASE, pickLocalized };
