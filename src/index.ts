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

/**
 * 下载/解码图片，支持 http/https、data URI（base64）、file:// 三种来源
 */
async function downloadImage(url: string, depth = 0): Promise<{ buf: Buffer; ext: string }> {
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
          downloadImage(headers.location as string, depth + 1).then(resolve).catch(reject);
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

  const saveCommandName = normalizeCommandName(config.saveCommand, "存图");
  const getCommandName = normalizeCommandName(config.getCommand, "更图");
  const modeCommandName = normalizeCommandName(config.modeCommand, "存图模式");
  const saveCommandTrigger = `!${saveCommandName}`;
  const getCommandTrigger = `!${getCommandName}`;
  const modeCommandTrigger = `!${modeCommandName}`;

  function canUseModeCommand(session: any): boolean {
    const userId = session?.userId;
    if (!userId) return false;
    return modeAdminSet.has(String(userId));
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
  async function saveImageForScope(scopeKey: string, url: string): Promise<void> {
    const fsp = require("fs").promises as typeof import("fs").promises;
    const { buf, ext } = await downloadImage(url);
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
    const imgs = h.select(elements, "img");
    const url = imgs[0]?.attrs?.src;
    return typeof url === "string" && url ? url : null;
  }

  /** 仅允许从引用消息提取图片 URL。 */
  function extractImageFromQuote(session: any): string | null {
    return extractFirstImageUrl(session?.quote?.elements ?? []);
  }

  // 兼容中文/英文感叹号命令前缀：将开头全角 ！ 归一化为半角 !
  ctx.middleware(async (session, next) => {
    if (session.content?.includes("！")) {
      session.content = session.content.replace(/！/g, "!");
    }
    return next();
  }, true);

  // ── 指令：存图 ───────────────────────────────────────────────────────────────
  ctx
    .command(saveCommandTrigger, "将下一条图片保存到本群（需使用 ! 前缀）")
    .action(async ({ session }) => {
      if (!session!.guildId) return "此指令仅限群聊使用";
      if (!session!.userId) return "无法获取用户信息";

      // 仅允许“引用含图消息”进行存图，不再支持发送指令后等待下一条图片。
      const imgUrl = extractImageFromQuote(session);
      const scopeKey = getScopeKey(session!.guildId, session!.userId);
      if (!imgUrl) {
        return `请使用“引用含图消息 + ${saveCommandTrigger}”进行保存`;
      }

      try {
        await saveImageForScope(scopeKey, imgUrl);
        return "✅ 存图成功！";
      } catch (err: any) {
        logger.error("存图失败：", err);
        return `❌ 存图失败：${err?.message ?? "未知错误"}`;
      }
    });

  // ── 指令：更图 ───────────────────────────────────────────────────────────────
  ctx
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

  // ── 指令：存图模式（管理员）──────────────────────────────────────────────────
  ctx
    .command(`${modeCommandTrigger} [mode:string]`, "管理员切换当前群存图模式（共享/个人，需使用 ! 前缀）")
    .action(async ({ session }, modeText) => {
      if (!session?.guildId) return "此指令仅限群聊使用";
      if (!canUseModeCommand(session)) return;

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
}
