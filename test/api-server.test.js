const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createServer } = require('../server/api-server');

function makeMultipartBody(boundary, fields = {}, files = {}) {
  const parts = [];
  for (const [key, val] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`,
      ),
    );
  }
  for (const [key, item] of Object.entries(files)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${
          item.filename
        }"\r\nContent-Type: ${
          item.contentType || 'application/octet-stream'
        }\r\n\r\n`,
      ),
    );
    parts.push(item.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

function sendRequest(port, method, reqPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- 开始测试 api-server.js ---');

  const TEST_PORT = 18081;
  const server = await createServer({
    port: TEST_PORT,
    maxFileSizeMb: 1, // 测试环境设为 1MB 便于测试超限拦截
    workerCount: 2,
  });

  try {
    // 1. GET /health
    console.log('1. 测试 GET /health...');
    const healthRes = await sendRequest(TEST_PORT, 'GET', '/health');
    assert.strictEqual(healthRes.statusCode, 200);
    const healthJson = JSON.parse(healthRes.body.toString());
    assert.strictEqual(healthJson.status, 'ok');
    console.log('  GET /health 正常通过');

    // 2. POST /api/compress 缺少 file 字段
    console.log('2. 测试缺少 file 字段返回 400...');
    const boundary = '----TestBoundary12345';
    const noFileBody = makeMultipartBody(boundary, { mode: 'auto' }, {});
    const noFileRes = await sendRequest(
      TEST_PORT,
      'POST',
      '/api/compress',
      {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': noFileBody.length,
      },
      noFileBody,
    );
    assert.strictEqual(noFileRes.statusCode, 400);
    const errJson = JSON.parse(noFileRes.body.toString());
    assert.strictEqual(errJson.code, 'BAD_REQUEST');
    console.log('  缺少 file 400 校验通过');

    // 3. POST /api/compress 大文件超限拦截 413
    console.log('3. 测试单图超限拦截 413...');
    const bigData = Buffer.alloc(1.5 * 1024 * 1024); // 1.5MB > 1MB 限制
    const bigBody = makeMultipartBody(
      boundary,
      { mode: 'auto' },
      {
        file: { filename: 'big.png', data: bigData, contentType: 'image/png' },
      },
    );
    const bigRes = await sendRequest(
      TEST_PORT,
      'POST',
      '/api/compress',
      {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bigBody.length,
      },
      bigBody,
    );
    assert.strictEqual(bigRes.statusCode, 413);
    console.log('  单图超限 413 拦截通过');

    // 4. POST /api/compress 自动模式压缩 PNG
    console.log('4. 测试 auto 模式压缩 PNG...');
    const pngBuf = fs.readFileSync(
      path.join(__dirname, '../codecs/example_palette.png'),
    );
    const pngBody = makeMultipartBody(
      boundary,
      { mode: 'auto' },
      {
        file: {
          filename: 'example_palette.png',
          data: pngBuf,
          contentType: 'image/png',
        },
      },
    );
    const pngRes = await sendRequest(
      TEST_PORT,
      'POST',
      '/api/compress',
      {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': pngBody.length,
      },
      pngBody,
    );
    assert.strictEqual(pngRes.statusCode, 200);
    assert.strictEqual(pngRes.headers['content-type'], 'image/png');
    assert.strictEqual(pngRes.headers['x-compression-status'], 'success');
    assert.strictEqual(
      pngRes.headers['x-original-size'],
      String(pngBuf.length),
    );
    assert(Number(pngRes.headers['x-compressed-size']) < pngBuf.length);
    console.log(
      '  PNG auto 压缩成功，原大小:',
      pngBuf.length,
      '压缩后:',
      pngRes.body.length,
    );

    // 5. POST /api/compress 强制转码 JPEG
    console.log('5. 测试 jpeg 模式强制转码...');
    const webpBuf = fs.readFileSync(
      path.join(__dirname, '../codecs/example.webp'),
    );
    const jpegBody = makeMultipartBody(
      boundary,
      { mode: 'jpeg', quality: '75' },
      {
        file: {
          filename: 'example.webp',
          data: webpBuf,
          contentType: 'image/webp',
        },
      },
    );
    const jpegRes = await sendRequest(
      TEST_PORT,
      'POST',
      '/api/compress',
      {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': jpegBody.length,
      },
      jpegBody,
    );
    assert.strictEqual(jpegRes.statusCode, 200);
    assert.strictEqual(jpegRes.headers['content-type'], 'image/jpeg');
    assert.strictEqual(jpegRes.headers['x-compression-status'], 'success');
    assert.strictEqual(jpegRes.body[0], 0xff);
    assert.strictEqual(jpegRes.body[1], 0xd8);
    console.log(
      '  WebP -> JPEG 转码成功，输出类型:',
      jpegRes.headers['content-type'],
    );

    // 6. POST /api/compress 不支持格式直通返回原文件 (GIF)
    console.log('6. 测试不支持格式直通原文件...');
    const fakeGifBuf = Buffer.from('GIF89a--test-gif-stream-data--');
    const gifBody = makeMultipartBody(
      boundary,
      { mode: 'auto' },
      {
        file: {
          filename: 'avatar.gif',
          data: fakeGifBuf,
          contentType: 'image/gif',
        },
      },
    );
    const gifRes = await sendRequest(
      TEST_PORT,
      'POST',
      '/api/compress',
      {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': gifBody.length,
      },
      gifBody,
    );
    assert.strictEqual(gifRes.statusCode, 200);
    assert.strictEqual(gifRes.headers['x-compression-status'], 'bypassed');
    assert.strictEqual(gifRes.headers['content-type'], 'image/gif');
    assert.deepStrictEqual(gifRes.body, fakeGifBuf);
    console.log('  GIF 不支持格式直通原文件验证通过');

    // 7. POST /api/compress 中文文件名处理
    console.log('7. 测试中文文件名识别与 Content-Disposition 编码...');
    const chineseFilename = '房产证.png';
    const chineseBody = makeMultipartBody(
      boundary,
      { mode: 'auto' },
      {
        file: {
          filename: chineseFilename,
          data: pngBuf,
          contentType: 'image/png',
        },
      },
    );
    const chineseRes = await sendRequest(
      TEST_PORT,
      'POST',
      '/api/compress',
      {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': chineseBody.length,
      },
      chineseBody,
    );
    assert.strictEqual(chineseRes.statusCode, 200);
    assert(
      chineseRes.headers['content-disposition'].includes(
        "filename*=UTF-8''compressed-%E6%88%BF%E4%BA%A7%E8%AF%81.png",
      ),
    );
    console.log('  中文文件名及 Content-Disposition RFC 5987 验证通过');

    console.log('--- 全部 api-server 测试通过 ---');
  } finally {
    await server.close();
  }
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
