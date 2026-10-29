'use strict';

const http = require('http');
const os = require('os');
const busboy = require('busboy');
const { ImagePool } = require('@squoosh/lib');
const { compressImage } = require('./compressor');

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
    os.cpus().length;

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
            fileStream.resume(); // 丢弃后续流
            return;
          }
          chunks.push(chunk);
        });

        fileStream.on('limit', () => {
          fileTooLarge = true;
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
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              code: 'PAYLOAD_TOO_LARGE',
              message: `File size exceeds the limit of ${maxFileSizeMb}MB`,
            }),
          );
          logAccess(413, `File exceeds ${maxFileSizeMb}MB limit`);
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

        try {
          const mode = fields.mode || 'auto';
          const type = fields.type || '';
          const quality = fields.quality
            ? parseInt(fields.quality, 10)
            : undefined;

          const result = await compressImage(pool, fileBuffer, {
            mode,
            type,
            quality,
          });

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
        } catch (err) {
          console.error('处理图片请求异常:', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                code: 'INTERNAL_ERROR',
                message: 'Failed to process image compression',
              }),
            );
            logAccess(500, `Internal error: ${err.message}`);
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
