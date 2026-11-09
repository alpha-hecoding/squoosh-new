'use strict';

/**
 * 图片预处理校验模块
 * 在进入 WASM 编解码前检测已知问题，防止卡死或内存溢出 (OOM)
 */

// 解码后 RGBA 约 4 字节/像素，100MP 单图即 ~400MB。默认保持 100MP，
// 并发压力大时可用 SQUOOSH_MAX_MEGAPIXELS 下调。
const MAX_MEGAPIXELS = (() => {
  const fromEnv = Number(process.env.SQUOOSH_MAX_MEGAPIXELS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100;
})();
const MAX_16BIT_PNG_MEGAPIXELS = MAX_MEGAPIXELS / 2;

// JPEG 结束标记；熵数据内 0xFF 后必跟 0x00 填充，因此首个 0xFFD9 即真正的 EOI
const EOI_MARKER = Buffer.from([0xff, 0xd9]);

/**
 * 校验结果
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - 是否可以安全处理
 * @property {string} [reason] - 跳过原因（如果 valid=false）
 * @property {Object} info - 图片信息
 */

/**
 * 校验 JPEG 文件
 * @param {Buffer} buffer
 * @returns {ValidationResult}
 */
function validateJpeg(buffer) {
  const info = { format: 'jpeg' };

  // 检查类型与最小长度
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) {
    return { valid: false, reason: '文件过小，不是有效的 JPEG', info };
  }

  // 检查 SOI 标记 (0xFF 0xD8)
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return { valid: false, reason: '无效的 JPEG 文件头', info };
  }

  let offset = 2;
  let hasSOF = false;
  let sawEoi = false;
  let entropyStart = -1;
  let width = 0;
  let height = 0;
  let numComponents = 0;

  while (offset < buffer.length - 1) {
    // 非 0xFF 开头说明头部扫描异常或已进入非预期数据流
    if (buffer[offset] !== 0xff) {
      entropyStart = offset;
      break;
    }

    const marker = buffer[offset + 1];

    // 1. 连续的 0xFF 是合法填充字节 (Fill byte)，仅前进 1 字节
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    // 2. 0x00 字节填充，或不含长度字段的独立标记 (TEM: 0x01, RST0-RST7: 0xD0-0xD7, SOI: 0xD8)
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd8)
    ) {
      offset += 2;
      continue;
    }

    // 3. EOI (0xD9, 图像结束) -> 头部扫描正常结束
    if (marker === 0xd9) {
      sawEoi = true;
      break;
    }

    // SOS (0xDA, 扫描线压缩数据开始) -> 记录熵数据起点后停止扫描头部
    if (marker === 0xda) {
      entropyStart = offset + 2;
      break;
    }

    // 4. 其余标记均包含 2 字节大端序长度字段（包含长度字段自身的 2 字节）
    if (offset + 4 > buffer.length) {
      return { valid: false, reason: 'JPEG 段结构被截断', info };
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      return { valid: false, reason: 'JPEG 段长度非法或文件不完整', info };
    }

    // 5. 解析 SOF0-SOF15 (Start of Frame)
    // 排除非帧头标记: DHT (0xC4, 哈夫曼表)、JPG (0xC8, 保留)、DAC (0xCC, 算术编码表)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (segmentLength < 8 || offset + 10 > buffer.length) {
        return { valid: false, reason: 'JPEG SOF 帧头不完整', info };
      }

      hasSOF = true;
      height = buffer.readUInt16BE(offset + 5);
      width = buffer.readUInt16BE(offset + 7);
      numComponents = buffer[offset + 9];

      info.width = width;
      info.height = height;
      info.components = numComponents;

      // 算术编码 (0xC9-0xCF) 与 无损 JPEG (SOF3: 0xC3, SOF7: 0xC7) 检测
      if (marker >= 0xc9 || marker === 0xc3 || marker === 0xc7) {
        return { valid: false, reason: '不支持算术编码或无损 JPEG', info };
      }

      // CMYK / YCCK 检测：4 个颜色分量
      if (numComponents === 4) {
        return {
          valid: false,
          reason: '检测到 CMYK 色彩空间 JPEG，不支持压缩',
          info,
        };
      }
    }

    // 6. 检查 APP2 (0xE2) 段中的 ICC Profile 色彩空间
    // 布局: FF E2 (2B) + Len (2B) + "ICC_PROFILE\0" (12B) + ChunkNum (1B) + TotalChunks (1B) + ICC Header
    if (marker === 0xe2 && segmentLength >= 36) {
      const id = buffer.toString('ascii', offset + 4, offset + 16);
      const chunkNum = buffer[offset + 16];
      // 仅第 1 个分片包含 ICC Header，ColorSpace 签名位于 ICC Header 偏移 16..20 处（即 offset + 34..38）
      if (
        id === 'ICC_PROFILE\0' &&
        chunkNum === 1 &&
        offset + 38 <= buffer.length
      ) {
        const colorSpaceSig = buffer.toString(
          'ascii',
          offset + 34,
          offset + 38,
        );
        info.iccColorSpace = colorSpaceSig.trim();
        if (colorSpaceSig === 'CMYK') {
          return {
            valid: false,
            reason: 'ICC Profile 标识为 CMYK 色彩空间',
            info,
          };
        }
      }
    }

    offset += 2 + segmentLength;
  }

  // 7. 熵数据完整性：合法 JPEG 必须以 EOI 收尾，否则文件被截断，解码只会产出残缺图
  if (!sawEoi && entropyStart >= 0) {
    sawEoi = buffer.indexOf(EOI_MARKER, entropyStart) !== -1;
  }
  if (!sawEoi) {
    return {
      valid: false,
      reason: 'JPEG 数据流被截断（缺少 EOI 结束标记）',
      info,
    };
  }

  if (!hasSOF) {
    return { valid: false, reason: '无效的 JPEG 结构，缺少帧信息', info };
  }

  if (width <= 0 || height <= 0) {
    return { valid: false, reason: 'JPEG 尺寸无效', info };
  }

  const megapixels = (width * height) / 1000000;
  info.megapixels = megapixels;
  if (megapixels > MAX_MEGAPIXELS) {
    return {
      valid: false,
      reason: `图片尺寸过大 (${megapixels.toFixed(1)}MP)，可能导致内存溢出`,
      info,
    };
  }

  return { valid: true, info };
}

/**
 * 校验 PNG 文件
 * @param {Buffer} buffer
 * @returns {ValidationResult}
 */
function validatePng(buffer) {
  const info = { format: 'png' };

  // PNG Signature (8B) + IHDR Length (4B) + "IHDR" (4B) + IHDR Data (13B) + CRC (4B) = 33B
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) {
    return { valid: false, reason: '文件过小，不是有效的 PNG', info };
  }

  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) {
      return { valid: false, reason: '无效的 PNG 文件头', info };
    }
  }

  const ihdrLength = buffer.readUInt32BE(8);
  const ihdrType = buffer.toString('ascii', 12, 16);

  if (ihdrType !== 'IHDR' || ihdrLength !== 13) {
    return { valid: false, reason: 'PNG 缺少有效的 IHDR 段', info };
  }

  // 使用无符号 32 位大端读取，避免位运算 << 24 产生负数溢出
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];

  info.width = width;
  info.height = height;
  info.bitDepth = bitDepth;
  info.colorType = colorType;

  // PNG 规范规定宽高范围为 1 ~ 2^31-1
  if (
    width === 0 ||
    height === 0 ||
    width > 0x7fffffff ||
    height > 0x7fffffff
  ) {
    return { valid: false, reason: 'PNG 尺寸无效', info };
  }

  const megapixels = (width * height) / 1000000;
  info.megapixels = megapixels;

  if (bitDepth === 16 && megapixels > MAX_16BIT_PNG_MEGAPIXELS) {
    return {
      valid: false,
      reason: `16-bit PNG 尺寸过大 (${megapixels.toFixed(1)}MP)`,
      info,
    };
  }

  if (megapixels > MAX_MEGAPIXELS) {
    return {
      valid: false,
      reason: `PNG 尺寸过大 (${megapixels.toFixed(1)}MP)`,
      info,
    };
  }

  return { valid: true, info };
}

/**
 * 校验 WebP 文件
 * @param {Buffer} buffer
 * @returns {ValidationResult}
 */
function validateWebp(buffer) {
  const info = { format: 'webp' };

  // RIFF Header (12B) + Chunk Header (8B) + 最小帧头 (10B) = 30B
  if (!Buffer.isBuffer(buffer) || buffer.length < 30) {
    return { valid: false, reason: '文件过小，不是有效的 WebP', info };
  }

  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return { valid: false, reason: '无效的 WebP 文件头', info };
  }

  const chunkType = buffer.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;

  if (chunkType === 'VP8 ') {
    info.webpType = 'lossy';
    // VP8 关键帧签名 0x9d 0x01 0x2a 位于偏移 23..26
    if (buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    }
  } else if (chunkType === 'VP8L') {
    info.webpType = 'lossless';
    // VP8L 签名字节 0x2f 位于偏移 20
    if (buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
  } else if (chunkType === 'VP8X') {
    info.webpType = 'extended';
    const flags = buffer[20];
    if (flags & 0x02) {
      info.isAnimated = true;
      return { valid: false, reason: '不支持动态 WebP', info };
    }
    // VP8X 宽高为 24-bit 小端整数 + 1（偏移 24..27 与 27..30）
    width = buffer.readUIntLE(24, 3) + 1;
    height = buffer.readUIntLE(27, 3) + 1;
  } else {
    return { valid: false, reason: '未知的 WebP 数据块类型', info };
  }

  // 强制校验帧头解析出的宽高，拦截帧签名损坏或尺寸为 0 的异常 WebP
  if (width <= 0 || height <= 0) {
    return { valid: false, reason: 'WebP 帧头损坏或尺寸无效', info };
  }

  info.width = width;
  info.height = height;
  const megapixels = (width * height) / 1000000;
  info.megapixels = megapixels;

  if (megapixels > MAX_MEGAPIXELS) {
    return {
      valid: false,
      reason: `WebP 尺寸过大 (${megapixels.toFixed(1)}MP)`,
      info,
    };
  }

  return { valid: true, info };
}

/**
 * 综合校验图片
 * @param {Buffer} buffer
 * @returns {ValidationResult}
 */
function validateImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return { valid: false, reason: '空文件或文件过小', info: {} };
  }

  // JPEG (0xFF 0xD8)
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return validateJpeg(buffer);
  }

  // PNG (0x89 0x50)
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return validatePng(buffer);
  }

  // WebP (RIFF....WEBP)
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return validateWebp(buffer);
  }

  return {
    valid: false,
    reason: '不支持的图片格式',
    info: { format: 'unknown' },
  };
}

module.exports = {
  validateJpeg,
  validatePng,
  validateWebp,
  validateImage,
};
