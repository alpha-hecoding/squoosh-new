'use strict';

const http = require('http');
const os = require('os');
const busboy = require('busboy');
const { ImagePool } = require('@squoosh/lib');
const { compressImage } = require('./compressor');

/** 压缩超时专用错误，用于与编码器自身异常区分（不靠 message 字符串匹配） */
class CompressTimeoutError extends Error {}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + sizes[i];
}

function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 创建并配置 API 服务实例
 * @param {object} [options]
 * @param {number} [options.port=8081]
 * @param {number} [options.maxFileSizeMb=50]
 * @param {number} [options.workerCount]
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
function createServer(options = {}) {
  const port = options.port || parseInt(process.env.PORT, 10) || 8081;
  const maxFileSizeMb =
    options.maxFileSizeMb || parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50;
  const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;
  const workerCount =
    options.workerCount ||
    parseInt(process.env.SQUOOSH_WORKERS, 10) ||
    Math.min(os.cpus().length, 4);

  // 超时秒数必须是正数，否则 Node 会把 NaN 当成 1ms 处理，导致所有请求秒变 504
  const timeoutSeconds = (() => {
    const raw = Number(process.env.SQUOOSH_TIMEOUT);
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
  })();
  const compressTimeoutMs = timeoutSeconds * 1000;

  // 排队中的请求各自持有最多 maxFileSizeMb 的缓冲，必须限流而不是无限排队
  const maxInFlight =
    options.maxInFlight ||
    parseInt(process.env.SQUOOSH_MAX_INFLIGHT, 10) ||
    workerCount * 2;
  let inFlight = 0;

  const pool = new ImagePool(workerCount);

  const server = http.createServer((req, res) => {
    const startTime = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    function logAccess(statusCode, message = '') {
      const duration = Date.now() - startTime;
      const detail = message ? ` | ${message}` : '';
      console.log(
        `[squoosh-api] ${getTimestamp()} ${
          req.method
        } ${pathname} ${statusCode} ${duration}ms${detail}`,
      );
    }

    // 统一设置基础响应头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // 直通路径会把任意字节按 application/octet-stream 回传，禁止浏览器嗅探类型
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      logAccess(204);
      return;
    }

    // 健康检查端点
    if (
      req.method === 'GET' &&
      (pathname === '/health' || pathname === '/api/health')
    ) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          workers: workerCount,
          maxFileSizeMb,
          inFlight,
          maxInFlight,
          timeoutSeconds,
          memoryUsage: process.memoryUsage(),
        }),
      );
      logAccess(200);
      return;
    }

    // 图片压缩端点
    if (
      req.method === 'POST' &&
      (pathname === '/api/compress' || pathname === '/compress')
    ) {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            code: 'BAD_REQUEST',
            message: 'Content-Type must be multipart/form-data',
          }),
        );
        logAccess(400, 'Content-Type must be multipart/form-data');
        return;
      }

      let bb;
      try {
        bb = busboy({
          headers: req.headers,
          defCharset: 'utf8',
          defParamCharset: 'utf8',
          limits: {
            fileSize: maxFileSizeBytes,
            files: 1,
          },
        });
      } catch (err) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            code: 'BAD_REQUEST',
            message: `Failed to parse form: ${err.message}`,
          }),
        );
        logAccess(400, `Failed to parse form: ${err.message}`);
        return;
      }

      const fields = {};
      let fileBuffer = null;
      let filename = 'image';
      let fileTooLarge = false;

      // 超限即刻回 413。Connection: close 让 Node 在响应刷完后关闭 socket；
      // 绝不在响应之前 destroy 请求流——请求体未读完时 destroy 会让客户端只拿到 ECONNRESET
      function respondTooLarge() {
        if (res.headersSent) return;
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Connection', 'close');
        res.end(
          JSON.stringify({
            code: 'PAYLOAD_TOO_LARGE',
            message: `File size exceeds the limit of ${maxFileSizeMb}MB`,
          }),
        );
        logAccess(413, `File exceeds ${maxFileSizeMb}MB limit`);
      }

      bb.on('field', (name, val) => {
        fields[name] = val;
      });

      bb.on('file', (name, fileStream, info) => {
        filename = info.filename || 'image';
        const chunks = [];
        let totalBytes = 0;

        fileStream.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxFileSizeBytes) {
            fileTooLarge = true;
            respondTooLarge();
            fileStream.resume(); // 丢弃后续流
            return;
          }
          chunks.push(chunk);
        });

        fileStream.on('limit', () => {
          fileTooLarge = true;
          respondTooLarge();
        });

        fileStream.on('end', () => {
          if (!fileTooLarge) {
            fileBuffer = Buffer.concat(chunks);
          }
        });
      });

      bb.on('error', (err) => {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              code: 'BAD_REQUEST',
              message: err.message,
            }),
          );
          logAccess(400, `Form error: ${err.message}`);
        }
      });

      bb.on('finish', async () => {
        if (res.headersSent) return;

        if (fileTooLarge) {
          respondTooLarge();
          return;
        }

        if (!fileBuffer || fileBuffer.length === 0) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              code: 'BAD_REQUEST',
              message: 'Missing file in multipart form-data',
            }),
          );
          logAccess(400, 'Missing file');
          return;
        }

        const mode = fields.mode || 'auto';
        const type = fields.type || '';
        // quality 必须是 1-100 的整数，否则回落编码器默认值；NaN 直接进编码器会产出不可用的小图
        const rawQuality = Number(fields.quality);
        const quality =
          Number.isInteger(rawQuality) && rawQuality >= 1 && rawQuality <= 100
            ? rawQuality
            : undefined;

        // 并发闸门：池的 jobQueue 无界，超限直接拒绝，避免排队缓冲把内存吃穿
        if (inFlight >= maxInFlight) {
          res.statusCode = 429;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Retry-After', '5');
          res.end(
            JSON.stringify({
              code: 'TOO_MANY_REQUESTS',
              message: `Concurrency limit reached (${maxInFlight})`,
            }),
          );
          logAccess(429, `并发超限 ${inFlight}/${maxInFlight}`);
          return;
        }

        const compressPromise = compressImage(pool, fileBuffer, {
          mode,
          type,
          quality,
        });

        // 槽位在压缩任务真正结束时释放：超时后任务仍会在池里跑完，不能提前放行
        inFlight += 1;
        const releaseSlot = () => {
          inFlight -= 1;
        };
        compressPromise.then(releaseSlot, releaseSlot);

        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(new CompressTimeoutError(`压缩超时 (${timeoutSeconds}s)`)),
            compressTimeoutMs,
          );
        });

        try {
          const result = await Promise.race([compressPromise, timeoutPromise]);
          clearTimeout(timeoutId); // ✅ 成功路径：立即清除定时器，防止触发 unhandled rejection

          res.statusCode = 200;
          res.setHeader('Content-Type', result.mime);
          const targetFilename = `compressed-${filename}`;
          const asciiFilename = targetFilename.replace(/[^\x20-\x7E]/g, '_');
          const encodedFilename = encodeURIComponent(targetFilename);
          res.setHeader(
            'Content-Disposition',
            `inline; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
          );
          res.setHeader(
            'X-Compression-Status',
            result.bypassed ? 'bypassed' : 'success',
          );
          res.setHeader('X-Original-Size', String(fileBuffer.length));
          res.setHeader('X-Compressed-Size', String(result.data.length));
          const ratio = (
            (result.data.length / fileBuffer.length) *
            100
          ).toFixed(1);
          res.setHeader('X-Compression-Ratio', `${ratio}%`);

          res.end(result.data);

          const sizeInfo = result.bypassed
            ? `${formatBytes(fileBuffer.length)} -> ${formatBytes(
                result.data.length,
              )} (直通)`
            : `${formatBytes(fileBuffer.length)} -> ${formatBytes(
                result.data.length,
              )} (${ratio}%)`;
          logAccess(
            200,
            `file: ${filename} | mode: ${mode} | ${sizeInfo} | status: ${
              result.bypassed ? 'bypassed' : 'success'
            }`,
          );

          if (
            global.gc &&
            (process.memoryUsage().external > 256 * 1024 * 1024 ||
              process.memoryUsage().heapUsed > 256 * 1024 * 1024)
          ) {
            global.gc();
          }
        } catch (err) {
          clearTimeout(timeoutId); // ✅ 失败/超时路径：同样清除定时器
          const isTimeout = err instanceof CompressTimeoutError;

          // 超时后压缩任务仍会在池里跑完，其 rejection 已由 releaseSlot 分支接住，
          // 这里无需再做兜底（清空 result.data 对 WASM 内存毫无作用）

          console.error('处理图片请求异常:', err);
          if (!res.headersSent) {
            res.statusCode = isTimeout ? 504 : 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                code: isTimeout ? 'GATEWAY_TIMEOUT' : 'INTERNAL_ERROR',
                message: isTimeout
                  ? err.message
                  : 'Failed to process image compression',
              }),
            );
            logAccess(res.statusCode, `Error: ${err.message}`);
          }
        }
      });

      req.pipe(bb);
      return;
    }

    // 默认 404
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
      }),
    );
    logAccess(404);
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(
        `[squoosh-api] 压缩服务已启动，监听端口: ${port} (工作线程: ${workerCount})`,
      );
      resolve({
        server,
        port,
        close: async () => {
          await new Promise((cb) => server.close(cb));
          await pool.close();
        },
      });
    });
    server.on('error', reject);
  });
}

// 直接以脚本形式启动
if (require.main === module) {
  process.env.NODE_NO_WARNINGS = '1';
  createServer()
    .then(({ close, port }) => {
      const shutdown = async () => {
        console.log(
          `\n[squoosh-api] 接收到退出信号，正在关闭服务 (端口 ${port})...`,
        );
        try {
          await close();
          console.log('[squoosh-api] 服务已优雅退出');
          process.exit(0);
        } catch (err) {
          console.error('[squoosh-api] 退出异常:', err);
          process.exit(1);
        }
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[squoosh-api] 服务启动失败:', err);
      process.exit(1);
    });
}

module.exports = {
  createServer,
};
