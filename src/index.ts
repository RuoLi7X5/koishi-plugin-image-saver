import { Context, Schema, h } from "koishi";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

export const name = "image-saver";

// ── 配置 Schema ──────────────────────────────────────────────────────────────

export interface Config {
  saveCommand: string;
  getCommand: string;
  modeCommand: string;
  bindMode: "guild" | "user";
  modeAdminUserIds: string[];
  guildModeOverrides: {
    guildId: string;
    mode: "guild" | "user";
  }[];
}

export const Config: Schema<Config> = Schema.object({
  saveCommand: Schema.string()
    .default("存图")
    .description("保存图片的指令名称"),
  getCommand: Schema.string()
    .default("更图")
    .description("发出已保存图片的指令名称"),
  modeCommand: Schema.string()
    .default("存图模式")
    .description("切换当前群存图模式的管理员指令名称"),
  bindMode: Schema.union([
    Schema.const("guild").description("群聊共享模式：同一群共用一张图"),
    Schema.const("user").description("群内个人模式：同一群内每人各存一张图"),
  ] as const)
    .default("guild")
    .description("存图绑定模式"),
  modeAdminUserIds: Schema.array(Schema.string().required())
    .role("table")
    .default([])
    .description("可执行模式切换指令的管理员 QQ 号（userId）白名单"),
  guildModeOverrides: Schema.array(
    Schema.object({
      guildId: Schema.string().required().description("群 ID"),
      mode: Schema.union([
        Schema.const("guild").description("群聊共享"),
        Schema.const("user").description("群内个人"),
      ] as const).required().description("该群绑定模式"),
    }),
  )
    .role("table")
    .default([])
    .description("按群覆盖绑定模式（未匹配时使用默认 bindMode）"),
}).description("指令设置");

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 通过 magic bytes 判断图片格式，兜底用 Content-Type
 */
function detectExt(buf: Buffer, contentType: string): string {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
    // RIFF....WEBP
    if (
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.length >= 12 && buf.slice(8, 12).toString("ascii") === "WEBP"
    ) return "webp";
  }
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

function buildRelativeDownloadCandidates(relativeUrl: string, base: string): string[] {
  const set = new Set<string>();
  const push = (value: string) => {
    try {
      set.add(new URL(value).toString());
    } catch {}
  };

  try {
    push(new URL(relativeUrl, base).toString());
  } catch {}

  try {
    const parsedBase = new URL(base);
    push(new URL(relativeUrl, parsedBase.origin).toString());
    const basePath = parsedBase.pathname.replace(/\/+$/, "");
    if (basePath && basePath !== "/") {
      const noLeadingRelative = relativeUrl.replace(/^\/+/, "");
      push(new URL(`${basePath}/${noLeadingRelative}`, parsedBase.origin).toString());
    }
  } catch {}

  return [...set];
}

/**
 * 下载/解码图片，支持 http/https、data URI（base64）、file:// 三种来源
 */
async function downloadImage(url: string, depth = 0, relativeUrlBases: string[] = []): Promise<{ buf: Buffer; ext: string }> {
  if (depth > 3) throw new Error("重定向次数过多");

  // ── data URI（base64 编码）────────────────────────────────────────────────
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) throw new Error("无效的 data URI");
    const buf = Buffer.from(match[2], "base64");
    return { buf, ext: detectExt(buf, match[1]) };
  }

  // ── file:// URL（bot 发图时常见）──────────────────────────────────────────
  if (url.startsWith("file://")) {
    const { fileURLToPath } = require("url") as typeof import("url");
    const fsp = require("fs").promises as typeof import("fs").promises;
    const buf = await fsp.readFile(fileURLToPath(url));
    return { buf, ext: detectExt(buf, "") };
  }

  // 兼容相对下载链接（如 /download?appid=...）：尝试使用已知基址补全为绝对 URL
  if (url.startsWith("/") && url.includes("?")) {
    let lastError: any = null;
    for (const base of relativeUrlBases) {
      const absoluteCandidates = buildRelativeDownloadCandidates(url, base);
      for (const absoluteUrl of absoluteCandidates) {
        try {
          return await downloadImage(absoluteUrl, depth + 1, relativeUrlBases);
        } catch (err: any) {
          lastError = err;
        }
      }
    }
    if (relativeUrlBases.length === 0) {
      throw new Error(`相对图片地址无法下载：${url}（缺少可用下载基址）`);
    }
    throw new Error(`相对图片地址无法下载：${url}（已尝试 ${relativeUrlBases.length} 个基址，最后错误：${lastError?.message ?? lastError}）`);
  }

  // 兼容适配器直接给出本地绝对路径（如 /root/... 或 C:\...\）
  // 但排除类似 /download?appid=... 这类“URL 查询”，避免误当成文件路径读取
  if ((url.startsWith("/") && !url.includes("?")) || /^[a-zA-Z]:[\\/]/.test(url)) {
    const fsp = require("fs").promises as typeof import("fs").promises;
    const buf = await fsp.readFile(url);
    return { buf, ext: detectExt(buf, "") };
  }

  // ── http / https ──────────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const lib: typeof import("https") = url.startsWith("https")
      ? require("https")
      : require("http");

    const req = lib.get(
      url,
      {
        timeout: 30_000,
        headers: { "User-Agent": "Mozilla/5.0 Koishi-image-saver/1.0" },
      } as any,
      (res: any) => {
        const { statusCode, headers } = res;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          downloadImage(headers.location as string, depth + 1, relativeUrlBases).then(resolve).catch(reject);
          return;
        }

        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }

        const contentType: string = (headers["content-type"] as string) ?? "";
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ buf, ext: detectExt(buf, contentType) });
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("图片下载超时"));
    });
  });
}

/** 将任意作用域键转成安全文件名（去掉非法字符） */
function safeScopeKey(scopeKey: string): string {
  return scopeKey.replace(/[^\w-]/g, "_");
}

// ── 插件入口 ─────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger("image-saver");
  const modeAdminSet = new Set((config.modeAdminUserIds ?? []).map(id => id.trim()).filter(Boolean));
  const guildModeMap = new Map<string, "guild" | "user">(
    (config.guildModeOverrides ?? [])
      .filter(item => item?.guildId)
      .map(item => [item.guildId, item.mode]),
  );

  // ── 存储目录 ────────────────────────────────────────────────────────────────
  function getStorageDir(): string {
    const dir = ctx.baseDir
      ? join(ctx.baseDir, "data", "image-saver")
      : join(process.cwd(), "data", "image-saver");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  const runtimeModePath = join(getStorageDir(), "guild-mode-overrides.json");
  const runtimeModeMap = new Map<string, "guild" | "user">();

  function loadRuntimeModeOverrides() {
    if (!existsSync(runtimeModePath)) return;
    try {
      const raw = readFileSync(runtimeModePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, "guild" | "user">;
      for (const [guildId, mode] of Object.entries(parsed)) {
        if (mode === "guild" || mode === "user") {
          runtimeModeMap.set(guildId, mode);
        }
      }
    } catch (err: any) {
      logger.warn(`[模式覆盖] 读取失败，已忽略：${err?.message ?? err}`);
    }
  }

  function saveRuntimeModeOverrides() {
    const data: Record<string, "guild" | "user"> = {};
    for (const [guildId, mode] of runtimeModeMap.entries()) data[guildId] = mode;
    writeFileSync(runtimeModePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  function normalizeMode(input?: string): "guild" | "user" | null {
    const text = (input ?? "").trim().toLowerCase();
    if (!text) return null;
    if (["guild", "shared", "share", "g", "共享", "群共享", "群聊共享"].includes(text)) return "guild";
    if (["user", "private", "u", "个人", "独立", "群内个人", "按人"].includes(text)) return "user";
    return null;
  }

  function getModeLabel(mode: "guild" | "user"): string {
    return mode === "user" ? "群内个人模式" : "群共享模式";
  }

  function normalizeCommandName(input: string, fallback: string): string {
    const normalized = (input ?? "").trim().replace(/^[!！\s]+/, "");
    return normalized || fallback;
  }

  function buildBangTriggers(commandName: string): string[] {
    return [...new Set([
      `!${commandName}`,
      `！${commandName}`,
      `﹗${commandName}`,
      `︕${commandName}`,
    ])];
  }

  function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const saveCommandName = normalizeCommandName(config.saveCommand, "存图");
  const getCommandName = normalizeCommandName(config.getCommand, "更图");
  const modeCommandName = normalizeCommandName(config.modeCommand, "存图模式");
  const saveCommandTriggers = buildBangTriggers(saveCommandName);
  const getCommandTriggers = buildBangTriggers(getCommandName);
  const modeCommandTriggers = buildBangTriggers(modeCommandName);
  const saveCommandTrigger = saveCommandTriggers[0];
  const getCommandTrigger = getCommandTriggers[0];
  const modeCommandTrigger = modeCommandTriggers[0];

  function readAuthority(value: any): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function isSuperAdminSession(session: any): boolean {
    const authority =
      readAuthority(session?.user?.authority) ??
      readAuthority((session as any)?.authority) ??
      readAuthority(session?.author?.authority);
    return authority != null && authority >= 4;
  }

  function canUseModeCommand(session: any): boolean {
    if (isSuperAdminSession(session)) return true;
    const userId = session?.userId;
    if (!userId) return false;
    return modeAdminSet.has(String(userId));
  }

  function normalizeHttpBase(value: any): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed
      .replace(/^ws:\/\//i, "http://")
      .replace(/^wss:\/\//i, "https://");
    if (!/^https?:\/\//i.test(normalized)) return null;
    try {
      return new URL(normalized).toString();
    } catch {
      return null;
    }
  }

  function collectRelativeUrlBases(session: any): string[] {
    const envBasesRaw = (process.env.IMAGE_SAVER_RELATIVE_URL_BASES ?? process.env.IMAGE_SAVER_RELATIVE_URL_BASE ?? "")
      .split(/[,\s]+/)
      .filter(Boolean);
    const candidateValues: any[] = [
      ...envBasesRaw,
      (session as any)?.bot?.config?.endpoint,
      (session as any)?.bot?.config?.baseUrl,
      (session as any)?.bot?.config?.selfUrl,
      (session as any)?.bot?.selfUrl,
      (session as any)?.bot?.internal?.config?.endpoint,
      (session as any)?.bot?.internal?._config?.endpoint,
      (session as any)?.event?._data?.self?.url,
      (session as any)?.event?.raw?.self?.url,
    ];
    const seen = new Set<string>();
    const bases: string[] = [];
    for (const value of candidateValues) {
      const base = normalizeHttpBase(value);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      bases.push(base);
    }
    return bases;
  }

  loadRuntimeModeOverrides();

  /** 查找该作用域已存的图片路径，不存在返回 null */
  function findSavedImage(scopeKey: string): string | null {
    const base = join(getStorageDir(), safeScopeKey(scopeKey));
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
      const p = `${base}.${ext}`;
      if (existsSync(p)) return p;
    }
    return null;
  }

  /** 下载图片并保存（覆盖该作用域旧图） */
  async function saveImageForScope(scopeKey: string, url: string, session?: any): Promise<void> {
    const fsp = require("fs").promises as typeof import("fs").promises;
    const relativeUrlBases = collectRelativeUrlBases(session);
    const { buf, ext } = await downloadImage(url, 0, relativeUrlBases);
    const dir = getStorageDir();
    const base = join(dir, safeScopeKey(scopeKey));

    // 删除旧格式文件
    for (const oldExt of ["png", "jpg", "jpeg", "gif", "webp"]) {
      try { await fsp.unlink(`${base}.${oldExt}`); } catch {}
    }

    await fsp.writeFile(`${base}.${ext}`, buf);
    logger.info(
      `[存图] 作用域 ${scopeKey} 保存成功（${(buf.length / 1024).toFixed(0)} KB，格式 ${ext}）`,
    );
  }

  function resolveBindMode(guildId: string): "guild" | "user" {
    if (runtimeModeMap.has(guildId)) return runtimeModeMap.get(guildId)!;
    return guildModeMap.get(guildId) ?? config.bindMode;
  }

  function getScopeKey(guildId: string, userId: string): string {
    const bindMode = resolveBindMode(guildId);
    if (bindMode === "user") return `g_${guildId}_u_${userId}`;
    return `g_${guildId}`;
  }

  /**
   * 从消息元素树中提取第一个图片 URL。
   * h.select 会递归搜索，可处理引用消息中的图片。
   */
  function extractFirstImageUrl(elements: h[]): string | null {
    const nodes = [
      ...h.select(elements, "img"),
      ...h.select(elements, "image"),
    ];
    for (const node of nodes) {
      const attrs: any = (node as any)?.attrs ?? {};
      const candidates = [attrs.src, attrs.url, attrs.file];
      for (const value of candidates) {
        if (typeof value === "string" && value) return value;
      }
    }
    return null;
  }

  function extractImageFromContentString(content?: string): string | null {
    if (!content) return null;
    try {
      const fromParsed = extractFirstImageUrl(h.parse(content));
      if (fromParsed) return fromParsed;
    } catch {}

    // onebot 常见格式：[CQ:image,file=...,url=...]
    const urlMatch = content.match(/\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/i);
    const fileMatch = content.match(/\[CQ:image,[^\]]*file=([^,\]]+)[^\]]*\]/i);
    const decodedFile = fileMatch?.[1] ? decodeURIComponent(fileMatch[1]) : null;
    if (decodedFile && (
      /^https?:\/\//i.test(decodedFile) ||
      /^file:\/\//i.test(decodedFile) ||
      /^[a-zA-Z]:[\\/]/.test(decodedFile) ||
      decodedFile.startsWith("/")
    )) {
      return decodedFile;
    }
    if (urlMatch?.[1]) return decodeURIComponent(urlMatch[1]);
    if (decodedFile) return decodedFile;
    return null;
  }

  function isLikelyAvatarLike(value: string): boolean {
    const text = value.toLowerCase();
    return (
      text.includes("qlogo.cn") ||
      text.includes("/avatar") ||
      text.includes("avatar") ||
      text.includes("portrait") ||
      text.includes("/head/") ||
      text.includes("/headimg")
    );
  }

  function extractStrictMessageImage(elements: any[]): string | null {
    const nodes = [
      ...h.select(elements as h[], "img"),
      ...h.select(elements as h[], "image"),
    ];
    for (const node of nodes) {
      const attrs: any = (node as any)?.attrs ?? {};
      const candidates = [attrs.src, attrs.url, attrs.file];
      for (const value of candidates) {
        if (typeof value !== "string" || !value) continue;
        if (isLikelyAvatarLike(value)) continue;
        return value;
      }
    }
    return null;
  }

  function extractStrictQuotedImageFromMessageObject(message: any): string | null {
    if (!message || typeof message !== "object") return null;

    // onebot 风格：raw_message 通常直接包含 [CQ:image,...]，比 h.parse 更稳定
    let rawImageCandidate: string | null = null;
    const rawCandidates: Array<string | undefined> = [
      message.raw_message,
      message.raw,
      message.content,
      message.text,
      typeof message.message === "string" ? message.message : undefined,
      message?.data?.raw_message,
      message?.data?.raw,
      message?.data?.content,
    ];
    for (const cand of rawCandidates) {
      const found = extractImageFromContentString(cand);
      if (found) {
        if (isLikelyAvatarLike(found)) continue;
        rawImageCandidate = found;
        break;
      }
    }

    const directElements = message?.elements;
    if (Array.isArray(directElements)) {
      const fromPicElements = extractImageSourceFromElements(directElements);
      if (fromPicElements) return fromPicElements;
      const found = extractStrictMessageImage(directElements);
      if (found) return found;
    }

    const directContent = typeof message?.content === "string" ? message.content : "";
    if (directContent) {
      try {
        const parsed = h.parse(directContent);
        const found = extractStrictMessageImage(parsed);
        if (found) return found;
      } catch {}
    }

    // 常见 onebot 返回体里 message 字段可能就是正文消息段数组
    if (Array.isArray(message?.message)) {
      const fromPicElements = extractImageSourceFromElements(message.message);
      if (fromPicElements) return fromPicElements;
      const found = extractStrictMessageImage(message.message);
      if (found) return found;
    }

    // 少数实现会把正文挂在 data.message / data.elements
    const data = message?.data;
    if (data && typeof data === "object") {
      if (Array.isArray(data.elements)) {
        const fromPicElements = extractImageSourceFromElements(data.elements);
        if (fromPicElements) return fromPicElements;
        const found = extractStrictMessageImage(data.elements);
        if (found) return found;
      }
      if (Array.isArray(data.message)) {
        const fromPicElements = extractImageSourceFromElements(data.message);
        if (fromPicElements) return fromPicElements;
        const found = extractStrictMessageImage(data.message);
        if (found) return found;
      }
      if (typeof data.content === "string") {
        try {
          const parsed = h.parse(data.content);
          const found = extractStrictMessageImage(parsed);
          if (found) return found;
        } catch {}
      }
    }

    if (rawImageCandidate) return rawImageCandidate;
    return null;
  }

  function summarizeValue(input: any, depth = 0, seen = new WeakSet<object>()): string {
    if (input == null) return String(input);
    if (typeof input === "string") return input.slice(0, 160);
    if (typeof input === "number" || typeof input === "boolean") return String(input);
    if (Array.isArray(input)) return `Array(len=${input.length})`;
    if (typeof input !== "object") return typeof input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (depth > 1) return `Object(keys=${Object.keys(input).slice(0, 12).join(",")})`;
    const obj = input as Record<string, any>;
    const preview: Record<string, string> = {};
    for (const key of Object.keys(obj).slice(0, 10)) {
      preview[key] = summarizeValue(obj[key], depth + 1, seen);
    }
    try {
      return JSON.stringify(preview);
    } catch {
      return `Object(keys=${Object.keys(obj).slice(0, 12).join(",")})`;
    }
  }

  function extractReplyIdFromContent(content?: string): string | null {
    if (!content) return null;
    const cq = content.match(/\[CQ:reply,[^\]]*id=([^,\]]+)[^\]]*\]/i);
    if (cq?.[1]) return cq[1];
    const xml = content.match(/<quote\b[^>]*\bid="([^"]+)"[^>]*\/?>/i);
    if (xml?.[1]) return xml[1];
    return null;
  }

  function normalizeNonZeroId(value: any): string | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const normalized = String(value).trim();
    if (!normalized || normalized === "0") return null;
    return normalized;
  }

  function expandMessageIdCandidates(value?: string | null): string[] {
    const normalized = normalizeNonZeroId(value);
    if (!normalized) return [];
    const set = new Set<string>([normalized]);
    if (/^-?\d+$/.test(normalized)) {
      try {
        const n = BigInt(normalized);
        const asUnsigned = BigInt.asUintN(32, n).toString();
        const asSigned = BigInt.asIntN(32, n).toString();
        if (asUnsigned !== "0") set.add(asUnsigned);
        if (asSigned !== "0") set.add(asSigned);
      } catch {}
    }
    return [...set];
  }

  function buildGetMessageIdCandidates(session: any, quoteId: string): string[] {
    const normalizedQuoteId = normalizeNonZeroId(quoteId);
    if (!normalizedQuoteId) return [];
    if (!/^-?\d+$/.test(normalizedQuoteId)) return [normalizedQuoteId];
    try {
      const n = BigInt(normalizedQuoteId);
      const asUnsigned = BigInt.asUintN(32, n).toString();
      const asSigned = BigInt.asIntN(32, n).toString();
      const set = new Set<string>();
      const platformText = `${session?.platform ?? ""} ${session?.bot?.platform ?? ""}`.toLowerCase();
      const isOnebotLike = platformText.includes("onebot") || platformText.includes("llbot");
      if (normalizedQuoteId.startsWith("-")) {
        // onebot/llbot 里 message_id 可能同时出现“负数签名值”与“无符号值”，按顺序都尝试。
        // 先试原值可避免“只转无符号导致消息不存在(retcode=1200)”。
        set.add(normalizedQuoteId);
        if (asUnsigned !== "0") set.add(asUnsigned);
        if (!isOnebotLike && asSigned !== "0") set.add(asSigned);
      } else {
        set.add(normalizedQuoteId);
        if (asSigned !== normalizedQuoteId && asSigned !== "0") set.add(asSigned);
        if (isOnebotLike && asUnsigned !== normalizedQuoteId && asUnsigned !== "0") set.add(asUnsigned);
      }
      return [...set];
    } catch {
      return [normalizedQuoteId];
    }
  }

  function toMaybeNumericMessageId(candidate: string): string | number {
    if (!/^-?\d+$/.test(candidate)) return candidate;
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed)) return parsed;
    return candidate;
  }

  function normalizeNonEmptyString(value: any): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized || null;
  }

  function isUsableImageSource(value: string): boolean {
    return (
      /^https?:\/\//i.test(value) ||
      /^file:\/\//i.test(value) ||
      /^data:image\//i.test(value) ||
      /^[a-zA-Z]:[\\/]/.test(value) ||
      value.startsWith("/")
    );
  }

  function extractThumbPathSource(thumbPath: any): string | null {
    const values: string[] = [];
    if (typeof thumbPath === "string") {
      values.push(thumbPath);
    } else if (Array.isArray(thumbPath)) {
      for (const item of thumbPath) {
        if (typeof item === "string") values.push(item);
      }
    } else if (thumbPath instanceof Map) {
      for (const item of thumbPath.values()) {
        if (typeof item === "string") values.push(item);
      }
    } else if (thumbPath && typeof thumbPath === "object") {
      for (const item of Object.values(thumbPath as Record<string, any>)) {
        if (typeof item === "string") values.push(item);
      }
    }
    for (const value of values) {
      const normalized = normalizeNonEmptyString(value);
      if (normalized && isUsableImageSource(normalized)) return normalized;
    }
    return null;
  }

  function extractImageSourceFromPicLike(picLike: any): string | null {
    if (!picLike || typeof picLike !== "object") return null;
    const pic = picLike as Record<string, any>;
    const directCandidates = [
      pic.sourcePath,
      pic.source_path,
      pic.localPath,
      pic.local_path,
      pic.filePath,
      pic.file_path,
      pic.path,
    ];
    for (const value of directCandidates) {
      const normalized = normalizeNonEmptyString(value);
      if (normalized && isUsableImageSource(normalized)) return normalized;
    }

    const thumbSource = extractThumbPathSource(pic.thumbPath ?? pic.thumb_path);
    if (thumbSource) return thumbSource;

    const urlCandidates = [
      pic.originImageUrl,
      pic.originImageURL,
      pic.url,
      pic.downloadUrl,
      pic.resourceUrl,
    ];
    for (const value of urlCandidates) {
      const normalized = normalizeNonEmptyString(value);
      if (normalized && isUsableImageSource(normalized)) return normalized;
    }

    return null;
  }

  function extractImageSourceFromElements(elements: any[]): string | null {
    for (const el of elements) {
      const element = el as Record<string, any>;
      const segmentType = normalizeNonEmptyString(element?.type)?.toLowerCase();
      if (segmentType === "image" || segmentType === "img") {
        const data = (element?.data && typeof element.data === "object") ? (element.data as Record<string, any>) : {};
        const segmentCandidates = [
          data.url,
          data.file,
          data.path,
          data.src,
          data.originImageUrl,
          element?.url,
          element?.file,
        ];
        for (const value of segmentCandidates) {
          const normalized = normalizeNonEmptyString(value);
          if (!normalized || !isUsableImageSource(normalized)) continue;
          if (isLikelyAvatarLike(normalized)) continue;
          return normalized;
        }
      }
      const source =
        extractImageSourceFromPicLike(element?.picElement) ??
        extractImageSourceFromPicLike(element?.picElem) ??
        extractImageSourceFromPicLike(element?.imageElement);
      if (source) return source;
    }
    return null;
  }

  function hasSourceTraceMarkers(obj: Record<string, any>): boolean {
    if (obj.sourceMsgIsIncPic === true) return true;
    const markerKeys = [
      "sourceMsgIdInRecords",
      "sourceMsgTextElems",
      "sourceMsgText",
      "sourceMsgSeqInRecords",
      "replyMsgId",
      "replayMsgId",
      "replyMsgSeq",
      "replayMsgSeq",
      "replyMsgRootMsgId",
      "replayMsgRootMsgId",
      "replyMsgRootSeq",
      "replayMsgRootSeq",
      "sourceMsgId",
      "source_msg_id",
      "sourceMsgSeq",
    ];
    for (const key of markerKeys) {
      if (obj[key] != null) return true;
    }
    return false;
  }

  function collectSemiRelaxedSources(
    eventData: any,
    trackedHint?: { msgId?: string | null; msgSeq?: string | null },
  ): string[] {
    const hintIds = expandMessageIdCandidates(trackedHint?.msgId);
    const hintSeq = normalizeNonZeroId(trackedHint?.msgSeq);
    const seen = new WeakSet<object>();
    const sourceSet = new Set<string>();
    const sources: string[] = [];
    const pushSource = (value: string | null) => {
      if (!value || sourceSet.has(value)) return;
      sourceSet.add(value);
      sources.push(value);
    };

    const walk = (node: any, depth: number) => {
      if (node == null || depth > 10) return;
      if (typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);
      const obj = node as Record<string, any>;

      const msgIdCandidates = [
        obj.msgId,
        obj.msg_id,
        obj.id,
        obj.message_id,
        obj.sourceMsgIdInRecords,
        obj.sourceMsgId,
        obj.replyMsgId,
        obj.replayMsgId,
      ]
        .map(normalizeNonZeroId)
        .filter(Boolean)
        .flatMap(value => expandMessageIdCandidates(value as string));
      const msgSeqCandidates = [
        obj.msgSeq,
        obj.msg_seq,
        obj.seq,
        obj.message_seq,
        obj.replyMsgSeq,
        obj.replayMsgSeq,
        obj.sourceMsgSeq,
        obj.sourceMsgSeqInRecords,
        obj.replyMsgRootSeq,
        obj.replayMsgRootSeq,
      ].map(normalizeNonZeroId).filter(Boolean) as string[];

      const hitHint =
        (hintIds.length > 0 && msgIdCandidates.some(id => hintIds.includes(id))) ||
        (hintSeq && msgSeqCandidates.includes(hintSeq));
      const traced = hitHint || hasSourceTraceMarkers(obj);

      if (traced) {
        if (Array.isArray(obj.sourceMsgTextElems)) {
          pushSource(extractImageSourceFromElements(obj.sourceMsgTextElems));
        }
        if (Array.isArray(obj.records)) {
          for (const rec of obj.records) {
            if (!rec || typeof rec !== "object") continue;
            const recObj = rec as Record<string, any>;
            if (Array.isArray(recObj.elements)) pushSource(extractImageSourceFromElements(recObj.elements));
            if (Array.isArray(recObj.message)) pushSource(extractImageSourceFromElements(recObj.message));
            pushSource(
              extractImageSourceFromPicLike(recObj.picElement) ??
              extractImageSourceFromPicLike(recObj.picElem) ??
              extractImageSourceFromPicLike(recObj.imageElement),
            );
          }
        }
        if (Array.isArray(obj.elements)) pushSource(extractImageSourceFromElements(obj.elements));
        if (Array.isArray(obj.message)) pushSource(extractImageSourceFromElements(obj.message));
        if (Array.isArray(obj.data?.elements)) pushSource(extractImageSourceFromElements(obj.data.elements));
        if (Array.isArray(obj.data?.message)) pushSource(extractImageSourceFromElements(obj.data.message));
        pushSource(
          extractImageSourceFromPicLike(obj.picElement) ??
          extractImageSourceFromPicLike(obj.picElem) ??
          extractImageSourceFromPicLike(obj.imageElement),
        );
      }

      for (const value of Object.values(obj)) walk(value, depth + 1);
    };

    walk(eventData, 0);
    return sources;
  }

  function buildEventDataCandidates(session: any): Array<{ label: string; data: any }> {
    const ev = (session as any)?.event;
    const quote = (session as any)?.quote;
    const rawCandidates: Array<{ label: string; data: any }> = [
      { label: "event._data", data: ev?._data },
      { label: "event.raw", data: ev?.raw },
      { label: "event", data: ev },
      { label: "session.quote", data: quote },
    ];
    const seen = new Set<any>();
    const candidates: Array<{ label: string; data: any }> = [];
    for (const item of rawCandidates) {
      const data = item.data;
      if (!data || typeof data !== "object") continue;
      if (seen.has(data)) continue;
      seen.add(data);
      candidates.push(item);
    }
    return candidates;
  }

  function extractSourceMsgIdInRecords(eventData: any): string | null {
    const seen = new WeakSet<object>();
    const walk = (node: any, depth: number): string | null => {
      if (node == null || depth > 10) return null;
      if (typeof node !== "object") return null;
      if (seen.has(node)) return null;
      seen.add(node);
      const obj = node as Record<string, any>;
      const v = normalizeNonZeroId(obj.sourceMsgIdInRecords);
      if (v) return v;
      for (const value of Object.values(obj)) {
        const found = walk(value, depth + 1);
        if (found) return found;
      }
      return null;
    };
    return walk(eventData, 0);
  }

  function extractReplyMsgIdInRecords(eventData: any): string | null {
    const seen = new WeakSet<object>();
    const walk = (node: any, depth: number): string | null => {
      if (node == null || depth > 10) return null;
      if (typeof node !== "object") return null;
      if (seen.has(node)) return null;
      seen.add(node);
      const obj = node as Record<string, any>;
      const keys = ["replyMsgId", "replayMsgId", "sourceMsgId", "source_msg_id"];
      for (const key of keys) {
        const value = normalizeNonZeroId(obj[key]);
        if (value) return value;
      }
      for (const value of Object.values(obj)) {
        const found = walk(value, depth + 1);
        if (found) return found;
      }
      return null;
    };
    return walk(eventData, 0);
  }

  function extractReplyMsgSeqInRecords(eventData: any): string | null {
    const seen = new WeakSet<object>();
    const walk = (node: any, depth: number): string | null => {
      if (node == null || depth > 10) return null;
      if (typeof node !== "object") return null;
      if (seen.has(node)) return null;
      seen.add(node);
      const obj = node as Record<string, any>;
      const keys = ["replyMsgSeq", "replayMsgSeq", "sourceMsgSeq", "sourceMsgSeqInRecords"];
      for (const key of keys) {
        const value = normalizeNonZeroId(obj[key]);
        if (value) return value;
      }
      for (const value of Object.values(obj)) {
        const found = walk(value, depth + 1);
        if (found) return found;
      }
      return null;
    };
    return walk(eventData, 0);
  }

  function extractPicElementSourcePath(
    eventData: any,
    target?: { msgId?: string | null; msgSeq?: string | null } | null,
  ): string | null {
    const targetMsgId = normalizeNonZeroId(target?.msgId);
    const targetMsgIdCandidates = expandMessageIdCandidates(targetMsgId);
    const targetMsgSeq = normalizeNonZeroId(target?.msgSeq);
    const hasTarget = Boolean(targetMsgIdCandidates.length > 0 || targetMsgSeq);
    if (!hasTarget) return null;
    const seen = new WeakSet<object>();
    const walk = (node: any, depth: number): string | null => {
      if (node == null || depth > 10) return null;
      if (typeof node !== "object") return null;
      if (seen.has(node)) return null;
      seen.add(node);
      const obj = node as Record<string, any>;

      // 优先：如果当前对象是“某条消息”，且 msgId/msgSeq 命中目标，则只提取该消息内的图片来源。
      const msgIdCandidates = [
        obj.msgId,
        obj.msg_id,
        obj.id,
        obj.message_id,
        obj.sourceMsgIdInRecords,
        obj.sourceMsgId,
        obj.replyMsgId,
        obj.replayMsgId,
      ]
        .map(normalizeNonZeroId)
        .filter(Boolean)
        .flatMap(value => expandMessageIdCandidates(value as string));
      const msgSeqCandidates = [
        obj.msgSeq,
        obj.msg_seq,
        obj.seq,
        obj.message_seq,
        obj.replyMsgSeq,
        obj.replayMsgSeq,
        obj.sourceMsgSeq,
        obj.sourceMsgSeqInRecords,
        obj.replyMsgRootSeq,
        obj.replayMsgRootSeq,
      ].map(normalizeNonZeroId).filter(Boolean) as string[];
      const isTargetMessage =
        (targetMsgIdCandidates.length > 0 && msgIdCandidates.some(id => targetMsgIdCandidates.includes(id))) ||
        (targetMsgSeq && msgSeqCandidates.includes(targetMsgSeq));
      if (isTargetMessage) {
        const arrays = [
          obj.elements,
          obj.sourceMsgTextElems,
          obj.message,
          obj.records,
          obj.data?.elements,
          obj.data?.message,
        ];
        for (const arr of arrays) {
          if (!Array.isArray(arr)) continue;
          const found = extractImageSourceFromElements(arr);
          if (found) return found;
        }
        const directSource =
          extractImageSourceFromPicLike(obj.picElement) ??
          extractImageSourceFromPicLike(obj.picElem) ??
          extractImageSourceFromPicLike(obj.imageElement);
        if (directSource) return directSource;
      }

      for (const value of Object.values(obj)) {
        const found = walk(value, depth + 1);
        if (found) return found;
      }
      return null;
    };
    return walk(eventData, 0);
  }

  function resolveFallbackSourcePathFromEvent(
    session: any,
    diagnostics?: string[],
    trackedHint?: { msgId?: string | null; msgSeq?: string | null },
  ): string | null {
    const candidates = buildEventDataCandidates(session);
    const hintMsgId = normalizeNonZeroId(trackedHint?.msgId);
    const hintMsgSeq = normalizeNonZeroId(trackedHint?.msgSeq);
    let lastTargetMsgId: string | null = null;
    let lastTargetMsgSeq: string | null = null;
    if (hintMsgId) lastTargetMsgId = hintMsgId;
    if (hintMsgSeq) lastTargetMsgSeq = hintMsgSeq;
    for (const item of candidates) {
      const sourceMsgIdInRecords = normalizeNonZeroId(extractSourceMsgIdInRecords(item.data));
      const replyMsgId = normalizeNonZeroId(extractReplyMsgIdInRecords(item.data));
      const replyMsgSeq = normalizeNonZeroId(extractReplyMsgSeqInRecords(item.data));
      const trackedMsgId = sourceMsgIdInRecords ?? replyMsgId ?? hintMsgId;
      const trackedMsgSeq = replyMsgSeq ?? hintMsgSeq;
      if (trackedMsgId) lastTargetMsgId = trackedMsgId;
      if (trackedMsgSeq) lastTargetMsgSeq = trackedMsgSeq;
      if (!trackedMsgId && !trackedMsgSeq) {
        if (diagnostics) {
          diagnostics.push(
            `fallbackSourcePath=skip from=${item.label} reason=no-tracking-fields`,
          );
        }
        continue;
      }
      const fallbackSourcePath = extractPicElementSourcePath(item.data, { msgId: trackedMsgId, msgSeq: trackedMsgSeq });
      if (!fallbackSourcePath) {
        const relaxedSources = collectSemiRelaxedSources(item.data, {
          msgId: trackedMsgId,
          msgSeq: trackedMsgSeq,
        });
        if (relaxedSources.length === 1) {
          if (diagnostics) {
            diagnostics.push(
              `fallbackSourcePath=found from=${item.label} mode=semi-relaxed ` +
              `targetMsgId=${trackedMsgId ?? "none"} targetMsgSeq=${trackedMsgSeq ?? "none"}`,
            );
          }
          return relaxedSources[0];
        }
        if (relaxedSources.length > 1) {
          if (diagnostics) {
            diagnostics.push(
              `fallbackSourcePath=ambiguous from=${item.label} mode=semi-relaxed count=${relaxedSources.length} ` +
              `targetMsgId=${trackedMsgId ?? "none"} targetMsgSeq=${trackedMsgSeq ?? "none"}`,
            );
          }
          continue;
        }
        if (diagnostics) {
          diagnostics.push(
            `fallbackSourcePath=miss from=${item.label} targetMsgId=${trackedMsgId ?? "none"} targetMsgSeq=${trackedMsgSeq ?? "none"}`,
          );
        }
        continue;
      }
      if (diagnostics) {
        diagnostics.push(
          `fallbackSourcePath=found from=${item.label} mode=strict ` +
          `targetMsgId=${trackedMsgId ?? "none"} targetMsgSeq=${trackedMsgSeq ?? "none"}`,
        );
      }
      return fallbackSourcePath;
    }
    if (diagnostics) {
      diagnostics.push(
        `fallbackSourcePath=none targetMsgId=${lastTargetMsgId ?? "none"} targetMsgSeq=${lastTargetMsgSeq ?? "none"}`,
      );
    }
    return null;
  }

  /**
   * 仅允许从引用消息提取图片 URL。
   * 同时兼容两种结构：
   * 1) session.quote.elements
   * 2) session.elements 里的 <quote> 子树
   */
  async function extractImageFromQuote(session: any): Promise<string | null> {
    const diagnostics: string[] = [];

    const rawContent = session?.__imageSaverRawContent ?? session?.content;
    diagnostics.push(`rawContent=${summarizeValue(rawContent)}`);

    const directQuoteImage = extractStrictQuotedImageFromMessageObject(session?.quote);
    if (directQuoteImage) return directQuoteImage;

    const currentMessageId =
      normalizeNonZeroId(session?.event?._data?.message_id) ??
      normalizeNonZeroId(session?.event?._data?.messageId) ??
      normalizeNonZeroId(session?.event?.message_id) ??
      normalizeNonZeroId(session?.event?.messageId) ??
      normalizeNonZeroId(session?.event?.id) ??
      normalizeNonZeroId(session?.event?._data?.id);

    const eventRawMessage =
      session?.event?._data?.raw_message ??
      session?.event?.raw?.raw_message ??
      session?.event?.raw_message;

    const replyIdFromRawMessage = normalizeNonZeroId(extractReplyIdFromContent(eventRawMessage));
    const replyIdFromQuoteObject =
      normalizeNonZeroId(session?.quote?.id) ??
      normalizeNonZeroId(session?.quote?.messageId) ??
      normalizeNonZeroId(session?.quote?.msgId);
    let replyIdFromEventMetadata: string | null = null;
    let replySeqFromEventMetadata: string | null = null;
    for (const item of buildEventDataCandidates(session)) {
      const candidateSourceId = normalizeNonZeroId(extractSourceMsgIdInRecords(item.data));
      const candidateReplyId = normalizeNonZeroId(extractReplyMsgIdInRecords(item.data));
      const candidateId = candidateSourceId ?? candidateReplyId;
      const candidateSeq = normalizeNonZeroId(extractReplyMsgSeqInRecords(item.data));
      if (!candidateId && !candidateSeq) continue;
      if (candidateId) replyIdFromEventMetadata = candidateId;
      if (candidateSeq) replySeqFromEventMetadata = candidateSeq;
      diagnostics.push(
        `reply evidence=${item.label}.` +
        `${candidateSourceId ? "sourceMsgIdInRecords" : ""}` +
        `${!candidateSourceId && candidateReplyId ? "reply/replayMsgId" : ""}` +
        `${candidateId && candidateSeq ? "+" : ""}` +
        `${candidateSeq ? "replyMsgSeq" : ""}`,
      );
      if (candidateId) break;
    }

    const quoteId =
      replyIdFromRawMessage ??
      replyIdFromQuoteObject ??
      replyIdFromEventMetadata;
    const hasReplyEvidence = Boolean(quoteId || replySeqFromEventMetadata);

    // 没有明确的引用标识时，不允许回查 getMessage（避免空发指令触发 get_msg）。
    if (!hasReplyEvidence) {
      diagnostics.push("reply evidence missing(raw_message/session.quote/sourceMsgIdInRecords/replyMsgId/replyMsgSeq). skip getMessage");
      const fallbackSourcePath = resolveFallbackSourcePathFromEvent(session, diagnostics, {
        msgId: replyIdFromQuoteObject ?? replyIdFromRawMessage,
        msgSeq: replySeqFromEventMetadata,
      });
      if (fallbackSourcePath) return fallbackSourcePath;

      logger.warn(`[存图] 抓图失败。原因链路：${diagnostics.join(" | ")}`);
      return null;
    }

    if (quoteId && currentMessageId && quoteId === currentMessageId) {
      diagnostics.push("reply id equals current message id. skip getMessage");
      const fallbackSourcePath = resolveFallbackSourcePathFromEvent(session, diagnostics, {
        msgId: quoteId,
        msgSeq: replySeqFromEventMetadata,
      });
      if (fallbackSourcePath) return fallbackSourcePath;
      logger.warn(`[存图] 抓图失败。原因链路：${diagnostics.join(" | ")}`);
      return null;
    }
    if (quoteId) diagnostics.push(`quoteId=${quoteId}`);
    else diagnostics.push(`quoteId=none replySeq=${replySeqFromEventMetadata ?? "none"} skip getMessage`);

    const channelId = session?.channelId;
    const getMessage = session?.bot?.getMessage;
    const internal = (session as any)?.bot?.internal;
    if (quoteId) {
      const getMessageIdCandidates = buildGetMessageIdCandidates(session, quoteId);
      const platformText = `${session?.platform ?? ""} ${session?.bot?.platform ?? ""}`.toLowerCase();
      const isOnebotLike = platformText.includes("onebot") || platformText.includes("llbot");
      diagnostics.push(
        `getMessageIds=${getMessageIdCandidates.length ? getMessageIdCandidates.join(",") : "none"}`,
      );
      const tryFetches: Array<{ label: string; run: () => Promise<any> }> = [];
      const canUseGetMessage = typeof getMessage === "function";
      const canUseInternal = Boolean(internal && typeof internal === "object");
      let internalGetMsgMethod: { name: "get_msg" | "getMsg"; fn: (...args: any[]) => any } | null = null;

      // onebot/llbot 场景优先走内部 get_msg，减少 getMessage 包装层参数丢失风险。
      if (canUseInternal && isOnebotLike) {
        const internalAny = internal as any;
        if (typeof internalAny?.get_msg === "function") {
          internalGetMsgMethod = { name: "get_msg", fn: internalAny.get_msg };
        } else if (typeof internalAny?.getMsg === "function") {
          internalGetMsgMethod = { name: "getMsg", fn: internalAny.getMsg };
        }
        diagnostics.push(
          `internalMsgMethod=${internalGetMsgMethod?.name ?? "none"}`,
        );
        for (const candidate of getMessageIdCandidates) {
          const internalMessageId = toMaybeNumericMessageId(candidate);
          if (!internalGetMsgMethod) continue;
          tryFetches.push({
            label: `internal.${internalGetMsgMethod.name}(${candidate})#scalar`,
            run: () => Promise.resolve(internalGetMsgMethod!.fn.call(internal, internalMessageId)),
          });
        }
      }

      const shouldUseGetMessageWrapper = canUseGetMessage && (!isOnebotLike || !internalGetMsgMethod);
      if (shouldUseGetMessageWrapper) {
        for (const candidate of getMessageIdCandidates) {
          if (isOnebotLike) {
            // onebot/llbot 在部分实现里 getMessage(channelId, messageId) 可能丢参，回退时仅传 messageId。
            tryFetches.push({
              label: `getMessage(${candidate})#onebot-safe`,
              run: () => getMessage.call(session.bot, candidate),
            });
          } else if (channelId) {
            // Satori 协议标准签名：getMessage(channelId, messageId)
            // 避免在 onebot/llbot 适配链路中触发 get_msg 空参数调用。
            tryFetches.push({
              label: `getMessage(channelId,${candidate})`,
              run: () => getMessage.call(session.bot, channelId, candidate),
            });
          } else {
            tryFetches.push({
              label: `getMessage(${candidate})`,
              run: () => getMessage.call(session.bot, candidate),
            });
          }
        }
      } else if (canUseGetMessage && isOnebotLike) {
        diagnostics.push("skip getMessage wrapper in onebot-like platform");
      }

      if (!tryFetches.length) {
        diagnostics.push(
          `quote fetch unavailable internal=${canUseInternal} getMessage=${canUseGetMessage} channelId=${channelId ?? "none"}`,
        );
      }

      for (const item of tryFetches) {
        try {
          const quoted = await item.run();
          const fromQuoted = extractStrictQuotedImageFromMessageObject(quoted);
          if (fromQuoted) return fromQuoted;
          diagnostics.push(`${item.label}=miss:${summarizeValue(quoted)}`);
        } catch (err: any) {
          diagnostics.push(`${item.label}=error:${err?.message ?? err}`);
        }
      }
    }

    // 引用消息直查失败或引用关系断裂（如 replayMsgId=0）时，再走字段追踪兜底。
    const fallbackSourcePath = resolveFallbackSourcePathFromEvent(session, diagnostics, {
      msgId: quoteId,
      msgSeq: replySeqFromEventMetadata,
    });
    if (fallbackSourcePath) return fallbackSourcePath;

    logger.warn(
      `[存图] 抓图失败。原因链路：${diagnostics.join(" | ")}`,
    );
    return null;
  }

  // 兼容中文/英文感叹号命令前缀：将常见全角/变体叹号归一化为半角 !
  ctx.middleware(async (session, next) => {
    (session as any).__imageSaverRawContent = session.content ?? "";
    if (session.content) {
      // 兼容：！(FF01)、﹗(FE57)、︕(FE15)
      session.content = session.content.replace(/[\uFF01\uFE57\uFE15]/g, "!");
    }
    // 兼容引用消息时自动携带的 @前缀（如 @某人!存图 / [CQ:at]!存图 / <at/>!存图）
    if (session.content?.includes("!")) {
      session.content = session.content
        .replace(/^(?:<quote\b[^>]*\/>\s*)+/i, "")
        .replace(/^(?:<at\b[^>]*\/>\s*)+/i, "")
        .replace(/^(?:\[CQ:(?:reply|at),[^\]]+\]\s*)+/i, "")
        // 只剥离开头的 @名字，不吞掉紧随其后的 !存图 / !更图
        .replace(/^(?:@[^!\s]+\s*)+(?=!)/, "");
    }
    // 兼容 "! 存图"、"@bot! 存图" 这类写法，统一归一为 "!存图"
    if (session.content?.includes("!")) {
      const names = [modeCommandName, saveCommandName, getCommandName]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      let normalized = session.content;
      for (const name of names) {
        const pattern = new RegExp(`!\\s*(${escapeRegExp(name)})(?=\\s|$)`, "g");
        normalized = normalized.replace(pattern, `!$1`);
      }
      session.content = normalized;
    }
    return next();
  }, true);

  // ── 指令：存图 ───────────────────────────────────────────────────────────────
  const saveCommand = ctx
    .command(saveCommandTrigger, "将下一条图片保存到本群（需使用 ! 前缀）")
    .action(async ({ session }) => {
      if (!session!.guildId) return "此指令仅限群聊使用";
      if (!session!.userId) return "无法获取用户信息";

      // 仅允许“引用含图消息”进行存图，不再支持发送指令后等待下一条图片。
      const imgUrl = await extractImageFromQuote(session);
      const scopeKey = getScopeKey(session!.guildId, session!.userId);
      if (!imgUrl) {
        logger.debug(
          `[存图] 未从引用中提取到图片，content=${session?.content ?? ""} ` +
          `quoteId=${session?.quote?.id ?? session?.quote?.messageId ?? "none"}`,
        );
        return `请使用“引用含图消息 + ${saveCommandTrigger}”进行保存`;
      }

      try {
        await saveImageForScope(scopeKey, imgUrl, session);
        return "✅ 存图成功！";
      } catch (err: any) {
        logger.error("存图失败：", err);
        logger.warn(`[存图] 主下载链路失败 url=${imgUrl} err=${err?.message ?? err}`);
        // 若下载失败/链接不可达，尝试从事件记录直接取本地 picElement.sourcePath 作为兜底
        try {
          const fallbackSourcePath = resolveFallbackSourcePathFromEvent(session, undefined, {
            msgId:
              normalizeNonZeroId((session as any)?.quote?.id) ??
              normalizeNonZeroId((session as any)?.quote?.messageId) ??
              normalizeNonZeroId((session as any)?.quote?.msgId),
          });
          if (fallbackSourcePath && fallbackSourcePath !== imgUrl) {
            await saveImageForScope(scopeKey, fallbackSourcePath, session);
            return "✅ 存图成功！";
          }
        } catch (err2: any) {
          logger.error("存图回退失败：", err2);
        }
        return `❌ 存图失败：${err?.message ?? "未知错误"}`;
      }
    });
  for (const alias of saveCommandTriggers.slice(1)) saveCommand.alias(alias);

  // ── 指令：更图 ───────────────────────────────────────────────────────────────
  const getCommand = ctx
    .command(getCommandTrigger, "发出本群已保存的图片（需使用 ! 前缀）")
    .action(async ({ session }) => {
      if (!session!.guildId) return "此指令仅限群聊使用";
      if (!session!.userId) return "无法获取用户信息";

      const scopeKey = getScopeKey(session!.guildId, session!.userId);
      const imgPath = findSavedImage(scopeKey);
      if (!imgPath) {
        return resolveBindMode(session!.guildId) === "user"
          ? "你在本群还没有存图，请先使用存图指令保存一张图片"
          : "本群暂无存图，请先使用存图指令保存一张图片";
      }

      try {
        const fsp = require("fs").promises as typeof import("fs").promises;
        const buf = await fsp.readFile(imgPath) as Buffer;
        const ext = imgPath.split(".").pop() ?? "png";

        const mimeMap: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
        };
        const mime = mimeMap[ext] ?? "image/png";

        // 优先 base64（速度快），失败后降级 file://（绕过 base64 大小限制）
        try {
          await session!.send(
            h.image(`data:${mime};base64,${buf.toString("base64")}`),
          );
        } catch {
          await session!.send(h.image(`file://${imgPath}`));
        }
      } catch (err: any) {
        logger.error("更图失败：", err);
        return `❌ 更图失败：${err?.message ?? "未知错误"}`;
      }
    });
  for (const alias of getCommandTriggers.slice(1)) getCommand.alias(alias);

  // ── 指令：存图模式（管理员）──────────────────────────────────────────────────
  const modeCommand = ctx
    .command(`${modeCommandTrigger} [mode:string]`, "管理员切换当前群存图模式（共享/个人，需使用 ! 前缀）")
    .userFields(["authority"])
    .action(async ({ session }, modeText) => {
      if (!session?.guildId) return "此指令仅限群聊使用";
      if (!canUseModeCommand(session)) {
        const authority = readAuthority(session?.user?.authority) ?? readAuthority((session as any)?.authority);
        logger.info(
          `[模式切换] 拒绝 userId=${session?.userId ?? "none"} guildId=${session?.guildId ?? "none"} authority=${authority ?? "none"}：非白名单且非超级管理员`,
        );
        return "❌ 你没有权限切换存图模式";
      }

      const guildId = session.guildId;
      const normalizedMode = normalizeMode(modeText);
      if (!normalizedMode) {
        const current = resolveBindMode(guildId);
        return `当前模式：${getModeLabel(current)}\n用法：${modeCommandTrigger} 共享 或 ${modeCommandTrigger} 个人`;
      }

      runtimeModeMap.set(guildId, normalizedMode);
      try {
        saveRuntimeModeOverrides();
      } catch (err: any) {
        logger.error("保存群模式覆盖失败：", err);
        return `❌ 切换失败：${err?.message ?? "写入配置失败"}`;
      }
      return `✅ 已切换为${getModeLabel(normalizedMode)}`;
    });
  for (const alias of modeCommandTriggers.slice(1)) modeCommand.alias(alias);
}
