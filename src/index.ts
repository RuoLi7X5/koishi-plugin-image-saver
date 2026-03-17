import { Context, Schema, h } from "koishi";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

export const name = "image-saver";

// ── 配置 Schema ──────────────────────────────────────────────────────────────

export interface Config {
  saveCommand: string;
  getCommand: string;
  waitTimeout: number;
  captureAny: boolean;
}

export const Config: Schema<Config> = Schema.object({
  saveCommand: Schema.string()
    .default("存图")
    .description("保存图片的指令名称"),
  getCommand: Schema.string()
    .default("更图")
    .description("发出已保存图片的指令名称"),
  waitTimeout: Schema.number()
    .default(60)
    .min(10)
    .max(300)
    .description("等待用户发送图片的超时时间（秒）"),
  captureAny: Schema.boolean()
    .default(true)
    .description("等待期间群内任何人发的图片都可被存入（关闭后仅限发指令的人）"),
}).description("指令设置");

// ── 内部类型 ─────────────────────────────────────────────────────────────────

interface PendingEntry {
  timer: ReturnType<typeof setTimeout>;
}

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
 * 下载远端图片（自动跟随一次 301/302 重定向）
 */
async function downloadImage(url: string, depth = 0): Promise<{ buf: Buffer; ext: string }> {
  if (depth > 3) throw new Error("重定向次数过多");

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

/**
 * 将 guildId 转成安全的文件名（去掉非法字符）
 */
function safeGuildId(guildId: string): string {
  return guildId.replace(/[^\w-]/g, "_");
}

// ── 插件入口 ─────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger("image-saver");

  // ── 存储目录 ────────────────────────────────────────────────────────────────
  function getStorageDir(): string {
    const dir = ctx.baseDir
      ? join(ctx.baseDir, "data", "image-saver")
      : join(process.cwd(), "data", "image-saver");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 查找该群已存的图片路径，不存在返回 null */
  function findSavedImage(guildId: string): string | null {
    const base = join(getStorageDir(), safeGuildId(guildId));
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
      const p = `${base}.${ext}`;
      if (existsSync(p)) return p;
    }
    return null;
  }

  /** 下载图片并保存（覆盖该群旧图） */
  async function saveImageForGuild(guildId: string, url: string): Promise<void> {
    const fsp = require("fs").promises as typeof import("fs").promises;
    const { buf, ext } = await downloadImage(url);
    const dir = getStorageDir();
    const base = join(dir, safeGuildId(guildId));

    // 删除旧格式文件
    for (const oldExt of ["png", "jpg", "jpeg", "gif", "webp"]) {
      try { await fsp.unlink(`${base}.${oldExt}`); } catch {}
    }

    await fsp.writeFile(`${base}.${ext}`, buf);
    logger.info(
      `[存图] 群 ${guildId} 保存成功（${(buf.length / 1024).toFixed(0)} KB，格式 ${ext}）`,
    );
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

  // ── 等待状态表（guildId:userId -> timer） ────────────────────────────────
  const pending = new Map<string, PendingEntry>();

  // 插件卸载时清理所有定时器
  ctx.on("dispose", () => {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  });

  // ── 中间件：拦截等待图片的用户消息 ──────────────────────────────────────────
  // prepend=true：在指令处理器之前运行，确保能捕获到图片消息
  ctx.middleware(async (session, next) => {
    if (!session.guildId) return next();

    // 根据 captureAny 决定匹配策略：
    //   开启时：查找该群是否存在任何待处理请求（不限发指令的人）
    //   关闭时：仅匹配发出存图指令的那个用户
    let matchedKey: string | undefined;
    if (config.captureAny) {
      const prefix = `${session.guildId}:`;
      for (const k of pending.keys()) {
        if (k.startsWith(prefix)) { matchedKey = k; break; }
      }
    } else {
      const k = `${session.guildId}:${session.userId}`;
      if (pending.has(k)) matchedKey = k;
    }

    if (!matchedKey) return next();

    // 检查消息中是否包含图片（直接发图 或 引用含图消息）
    const imgUrl = extractFirstImageUrl(session.elements ?? []);
    if (!imgUrl) return next();

    // 取消超时定时器，删除等待状态
    clearTimeout(pending.get(matchedKey)!.timer);
    pending.delete(matchedKey);

    try {
      await saveImageForGuild(session.guildId, imgUrl);
      await session.send("✅ 存图成功！");
    } catch (err: any) {
      logger.error("存图失败：", err);
      await session.send(`❌ 存图失败：${err?.message ?? "未知错误"}`);
    }
    // 不调用 next()，此消息已被消费
  }, true);

  // ── 指令：存图 ───────────────────────────────────────────────────────────────
  ctx
    .command(config.saveCommand, "将下一条图片保存到本群（指令名可在配置中修改）")
    .action(async ({ session }) => {
      if (!session!.guildId) return "此指令仅限群聊使用";

      // 优先检查指令消息本身是否已附带图片（引用含图消息时直接捕获）
      const imgUrl = extractFirstImageUrl(session!.elements ?? []);
      if (imgUrl) {
        try {
          await saveImageForGuild(session!.guildId, imgUrl);
          return "✅ 存图成功！";
        } catch (err: any) {
          logger.error("存图失败：", err);
          return `❌ 存图失败：${err?.message ?? "未知错误"}`;
        }
      }

      // 当前消息无图片，进入等待模式
      const key = `${session!.guildId}:${session!.userId}`;

      // 若用户已有待处理请求，先取消旧的
      if (pending.has(key)) {
        clearTimeout(pending.get(key)!.timer);
        pending.delete(key);
      }

      const timeoutMs = config.waitTimeout * 1000;
      const timer = setTimeout(async () => {
        pending.delete(key);
        try {
          await session!.send(`⏰ 已超过 ${config.waitTimeout} 秒未收到图片，存图已取消`);
        } catch {}
      }, timeoutMs);

      pending.set(key, { timer });

      return `📷 请在 ${config.waitTimeout} 秒内发送或引用含图的消息`;
    });

  // ── 指令：更图 ───────────────────────────────────────────────────────────────
  ctx
    .command(config.getCommand, "发出本群已保存的图片（指令名可在配置中修改）")
    .action(async ({ session }) => {
      if (!session!.guildId) return "此指令仅限群聊使用";

      const imgPath = findSavedImage(session!.guildId);
      if (!imgPath) return "本群暂无存图，请先使用存图指令保存一张图片";

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
}
