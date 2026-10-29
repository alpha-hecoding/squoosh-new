const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ImagePool } = require('@squoosh/lib');
const { detectImageFormat, compressImage } = require('../server/compressor');

async function runTests() {
  console.log('--- 开始测试 compressor.js ---');

  // 1. 测试二进制特征嗅探 (detectImageFormat)
  console.log('1. 测试二进制特征嗅探...');
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assert.strictEqual(detectImageFormat(jpegHeader).ext, 'jpg');
  assert.strictEqual(detectImageFormat(jpegHeader).mime, 'image/jpeg');
  assert.strictEqual(detectImageFormat(jpegHeader).supported, true);

  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  assert.strictEqual(detectImageFormat(pngHeader).ext, 'png');
  assert.strictEqual(detectImageFormat(pngHeader).mime, 'image/png');
  assert.strictEqual(detectImageFormat(pngHeader).supported, true);

  const webpHeader = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBP'),
  ]);
  assert.strictEqual(detectImageFormat(webpHeader).ext, 'webp');
  assert.strictEqual(detectImageFormat(webpHeader).mime, 'image/webp');
  assert.strictEqual(detectImageFormat(webpHeader).supported, true);

  const gifHeader = Buffer.from('GIF89a...');
  assert.strictEqual(detectImageFormat(gifHeader).ext, 'gif');
  assert.strictEqual(detectImageFormat(gifHeader).mime, 'image/gif');
  assert.strictEqual(detectImageFormat(gifHeader).supported, false);

  const unknownData = Buffer.from('Hello plain text');
  assert.strictEqual(detectImageFormat(unknownData).ext, 'bin');
  assert.strictEqual(detectImageFormat(unknownData).supported, false);

  // 2. 测试图片压缩与直通逻辑 (compressImage)
  console.log('2. 测试图片压缩与直通...');
  const pool = new ImagePool(2);

  try {
    const exampleWebp = fs.readFileSync(
      path.join(__dirname, '../codecs/example.webp'),
    );
    const examplePng = fs.readFileSync(
      path.join(__dirname, '../codecs/example_palette.png'),
    );

    // 2.1 自动模式压缩 WebP
    const resWebp = await compressImage(pool, exampleWebp, { mode: 'auto' });
    assert.strictEqual(resWebp.bypassed, false);
    assert.strictEqual(resWebp.ext, 'webp');
    assert.strictEqual(resWebp.mime, 'image/webp');
    assert(Buffer.isBuffer(resWebp.data));
    assert(resWebp.data.length > 0);
    console.log(
      '  WebP auto 压缩通过, 原始:',
      exampleWebp.length,
      '压缩后:',
      resWebp.data.length,
    );

    // 2.2 强制转码 JPEG 模式
    const resJpeg = await compressImage(pool, exampleWebp, { mode: 'jpeg' });
    assert.strictEqual(resJpeg.bypassed, false);
    assert.strictEqual(resJpeg.ext, 'jpg');
    assert.strictEqual(resJpeg.mime, 'image/jpeg');
    assert(Buffer.isBuffer(resJpeg.data));
    console.log(
      '  WebP -> JPEG 转码通过, 原始:',
      exampleWebp.length,
      '压缩后:',
      resJpeg.data.length,
    );

    // 2.3 自动模式压缩 PNG (oxipng)
    const resPng = await compressImage(pool, examplePng, { mode: 'auto' });
    assert.strictEqual(resPng.bypassed, false);
    assert.strictEqual(resPng.ext, 'png');
    assert.strictEqual(resPng.mime, 'image/png');
    assert(resPng.data.length > 0);
    console.log(
      '  PNG auto 压缩通过, 原始:',
      examplePng.length,
      '压缩后:',
      resPng.data.length,
    );

    // 2.4 不支持格式直通 (GIF)
    const fakeGif = Buffer.from('GIF89a-not-real-image-data-but-gif-header');
    const resGif = await compressImage(pool, fakeGif, { mode: 'auto' });
    assert.strictEqual(resGif.bypassed, true);
    assert.strictEqual(resGif.ext, 'gif');
    assert.strictEqual(resGif.mime, 'image/gif');
    assert.deepStrictEqual(resGif.data, fakeGif);
    console.log('  GIF 不支持格式直通通过');

    // 2.5 损坏数据异常捕获降级
    const corruptJpg = Buffer.concat([
      jpegHeader,
      Buffer.from('completely invalid image content'),
    ]);
    const resCorrupt = await compressImage(pool, corruptJpg, { mode: 'auto' });
    assert.strictEqual(resCorrupt.bypassed, true);
    assert.deepStrictEqual(resCorrupt.data, corruptJpg);
    console.log('  损坏图片异常降级直通通过');

    console.log('--- 全部 compressor 测试通过 ---');
  } finally {
    await pool.close();
  }
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
