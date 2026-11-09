const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  validateJpeg,
  validatePng,
  validateWebp,
  validateImage,
} = require('../server/image-validator');

async function runTests() {
  console.log('--- 开始测试 image-validator.js ---');

  // 1. 测试 JPEG 校验
  console.log('1. 测试 JPEG 校验...');
  const jpegHeader = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  ]);
  const jpegResult = validateJpeg(jpegHeader);
  assert.strictEqual(jpegResult.valid, false); // 不完整
  console.log('  不完整 JPEG 正确标记为无效');

  // 1.1 测试 JPEG 连续 0xFF 填充字节不会误报失败
  console.log('1.1 测试 JPEG 连续 0xFF 填充字节...');
  const jpegWithFillBytes = Buffer.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xff,
    0xff,
    0xc0, // 3 个 0xFF + SOF0
    0x00,
    0x0b, // Length = 11
    0x08, // Precision = 8
    0x00,
    0x64, // Height = 100
    0x00,
    0xc8, // Width = 200
    0x03, // Components = 3 (YCbCr)
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9, // EOI
  ]);
  const fillResult = validateImage(jpegWithFillBytes);
  assert.strictEqual(fillResult.valid, true);
  assert.strictEqual(fillResult.info.width, 200);
  assert.strictEqual(fillResult.info.height, 100);
  console.log('  连续 0xFF 填充字节正确处理:', fillResult.info);

  // 1.2 测试 JPEG APP2 ICC_PROFILE CMYK 精准拦截
  console.log('1.2 测试 JPEG APP2 ICC_PROFILE CMYK...');
  const iccHeader = Buffer.alloc(36, 0);
  iccHeader.write('ICC_PROFILE\0', 0, 'ascii');
  iccHeader[12] = 1; // Chunk 1
  iccHeader[13] = 1; // Total 1
  iccHeader.write('CMYK', 14 + 16, 'ascii'); // ICC offset 16..20 = 'CMYK'

  const jpegWithCmykIcc = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe2, 0x00, 38]), // SOI + APP2 (len=38)
    iccHeader,
    Buffer.from([0xff, 0xd9]),
  ]);
  const iccRes = validateImage(jpegWithCmykIcc);
  assert.strictEqual(iccRes.valid, false);
  assert.ok(iccRes.reason.includes('ICC Profile 标识为 CMYK'));
  console.log('  APP2 ICC Profile CMYK 正确拦截:', iccRes.reason);

  // 1.3 测试 SOS 之后被截断的 JPEG（头部完整但缺 EOI）必须被拦截，
  //     否则解码器会静默产出一张残缺图并回报 success
  console.log('1.3 测试截断 JPEG（缺少 EOI）...');
  const jpegHead = Buffer.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    0x64,
    0x00,
    0xc8,
    0x03,
    0x01,
    0x11,
    0x00, // SOF0 200x100
    0xff,
    0xda,
    0x00,
    0x0c,
    0x03,
    0x01,
    0x00,
    0x02,
    0x11,
    0x03,
    0x11,
    0x00,
    0x3f,
    0x00, // SOS
  ]);
  const truncatedJpeg = Buffer.concat([
    jpegHead,
    Buffer.from([0x01, 0x02, 0x03, 0x04]), // 熵数据被截断，无 EOI
  ]);
  const truncatedRes = validateImage(truncatedJpeg);
  assert.strictEqual(truncatedRes.valid, false);
  assert.ok(truncatedRes.reason.includes('缺少 EOI'));
  const completeJpeg = Buffer.concat([
    truncatedJpeg,
    Buffer.from([0xff, 0xd9]), // 补上 EOI 后应当放行
  ]);
  const completeRes = validateImage(completeJpeg);
  assert.strictEqual(completeRes.valid, true);
  console.log('  截断 JPEG 正确拦截:', truncatedRes.reason);

  // 1.4 测试默认像素上限（100MP）：120MP 拦截、64MP 放行
  console.log('1.4 测试超大像素上限...');
  const overLimitJpeg = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x2e,
    0xe0,
    0x27,
    0x10,
    0x03,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9, // 12000 x 10000 = 120MP
  ]);
  const overLimitRes = validateImage(overLimitJpeg);
  assert.strictEqual(overLimitRes.valid, false);
  assert.ok(overLimitRes.reason.includes('尺寸过大'));
  const withinLimitJpeg = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x1f,
    0x40,
    0x1f,
    0x40,
    0x03,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9, // 8000 x 8000 = 64MP
  ]);
  assert.strictEqual(validateImage(withinLimitJpeg).valid, true);
  console.log('  120MP 拦截 / 64MP 放行:', overLimitRes.reason);

  // 2. 测试 PNG 校验
  console.log('2. 测试 PNG 校验...');
  // PNG 最小完整结构: Signature (8B) + IHDR chunk (4+4+13+4 = 25B) = 33B
  const pngHeader = Buffer.alloc(33, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    pngHeader,
    0,
  );
  pngHeader.writeUInt32BE(13, 8); // IHDR length
  pngHeader.write('IHDR', 12, 'ascii');
  pngHeader.writeUInt32BE(1, 16); // width = 1
  pngHeader.writeUInt32BE(1, 20); // height = 1
  pngHeader[24] = 8; // bit depth
  pngHeader[25] = 2; // color type
  const pngResult = validatePng(pngHeader);
  assert.strictEqual(pngResult.valid, true);
  assert.strictEqual(pngResult.info.width, 1);
  assert.strictEqual(pngResult.info.height, 1);
  console.log('  有效 PNG 正确解析:', pngResult.info);

  // 2.1 测试 PNG 宽高最高位为 1 时不会因负数溢出而绕过校验
  console.log('2.1 测试 PNG 宽高位运算溢出...');
  const pngNegativeOverflow = Buffer.alloc(33, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    pngNegativeOverflow,
    0,
  );
  pngNegativeOverflow.writeUInt32BE(13, 8);
  pngNegativeOverflow.write('IHDR', 12, 'ascii');
  pngNegativeOverflow.writeUInt32BE(0x80000001, 16); // 触发有符号负数的宽度
  pngNegativeOverflow.writeUInt32BE(100, 20);
  pngNegativeOverflow[24] = 8;
  const overflowResult = validateImage(pngNegativeOverflow);
  assert.strictEqual(overflowResult.valid, false);
  console.log('  宽高溢出正确拦截:', overflowResult.reason);

  // 3. 测试 WebP 校验
  console.log('3. 测试 WebP 校验...');
  // WebP 最小完整结构: RIFF header (12B) + Chunk (8B) + VP8 frame header (10B) = 30B
  const webpHeader = Buffer.alloc(30, 0);
  webpHeader.write('RIFF', 0, 'ascii');
  webpHeader.writeUInt32LE(18, 4); // RIFF content size
  webpHeader.write('WEBP', 8, 'ascii');
  webpHeader.write('VP8 ', 12, 'ascii');
  webpHeader.writeUInt32LE(10, 16); // VP8 chunk size
  // VP8 frame signature at offset 23-25
  webpHeader[23] = 0x9d;
  webpHeader[24] = 0x01;
  webpHeader[25] = 0x2a;
  webpHeader.writeUInt16LE(100, 26); // width (14-bit)
  webpHeader.writeUInt16LE(100, 28); // height (14-bit)
  const webpResult = validateWebp(webpHeader);
  assert.strictEqual(webpResult.valid, true);
  console.log('  有效 WebP 正确解析:', webpResult.info);

  // 3.1 测试 WebP 超大尺寸拦截
  console.log('3.1 测试 WebP 超大尺寸...');
  // 构造一个超大 WebP (VP8X 扩展格式，宽度 16384 x 高度 16384 = 268MP)
  const hugeWebp = Buffer.alloc(30, 0);
  hugeWebp.write('RIFF', 0, 'ascii');
  hugeWebp.write('WEBP', 8, 'ascii');
  hugeWebp.write('VP8X', 12, 'ascii');
  hugeWebp[20] = 0x00; // flags
  // 宽高各 24-bit 小端 + 1
  hugeWebp.writeUIntLE(16383, 24, 3); // width = 16383 + 1 = 16384
  hugeWebp.writeUIntLE(16383, 27, 3); // height = 16383 + 1 = 16384
  const hugeWebpResult = validateWebp(hugeWebp);
  assert.strictEqual(hugeWebpResult.valid, false);
  assert.ok(hugeWebpResult.reason.includes('尺寸过大'));
  console.log('  超大 WebP 正确拦截:', hugeWebpResult.reason);

  // 4. 测试综合校验
  console.log('4. 测试综合校验...');
  assert.strictEqual(validateImage(pngHeader).valid, true);
  assert.strictEqual(validateImage(Buffer.from('test')).valid, false);
  console.log('  综合校验测试通过');

  // 5. 测试真实图片
  console.log('5. 测试真实图片...');
  const examplePng = fs.readFileSync(
    path.join(__dirname, '../codecs/example_palette.png'),
  );
  const realPngResult = validateImage(examplePng);
  assert.strictEqual(realPngResult.valid, true);
  console.log('  真实 PNG 校验通过:', realPngResult.info);

  const exampleWebp = fs.readFileSync(
    path.join(__dirname, '../codecs/example.webp'),
  );
  const realWebpResult = validateImage(exampleWebp);
  assert.strictEqual(realWebpResult.valid, true);
  console.log('  真实 WebP 校验通过:', realWebpResult.info);

  console.log('--- 全部 image-validator 测试通过 ---');
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
