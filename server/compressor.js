'use strict';

/**
 * 二进制 Magic Bytes 探测图片格式
 * @param {Buffer} buffer
 * @returns {{ ext: string, mime: string, supported: boolean }}
 */
function detectImageFormat(buffer) {
  if (!buffer || buffer.length < 2) {
    return { ext: 'bin', mime: 'application/octet-stream', supported: false };
  }

  // JPEG: FF D8 FF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { ext: 'jpg', mime: 'image/jpeg', supported: true };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png', supported: true };
  }

  // WebP: RIFF .... WEBP
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp', supported: true };
  }

  // GIF: GIF87a / GIF89a (不支持有损压缩编码器)
  if (buffer.length >= 6 && buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return { ext: 'gif', mime: 'image/gif', supported: false };
  }

  // BMP: BM (不支持)
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { ext: 'bmp', mime: 'image/bmp', supported: false };
  }

  // AVIF: .... ftypavif
  if (
    buffer.length >= 12 &&
    buffer.slice(4, 12).toString('ascii') === 'ftypavif'
  ) {
    return { ext: 'avif', mime: 'image/avif', supported: true };
  }

  return { ext: 'bin', mime: 'application/octet-stream', supported: false };
}

/**
 * 核心压缩与直通路由函数
 * @param {import('@squoosh/lib').ImagePool} imagePool
 * @param {Buffer} buffer
 * @param {object} options
 * @param {string} [options.mode='auto'] auto | jpeg | mozjpeg
 * @param {string} [options.type] 显式指定类型
 * @param {number} [options.quality=75]
 * @returns {Promise<{ data: Buffer, ext: string, mime: string, bypassed: boolean }>}
 */
async function compressImage(imagePool, buffer, options = {}) {
  const mode = (options.mode || 'auto').toLowerCase();
  const quality = typeof options.quality === 'number' ? options.quality : 75;
  const detected = detectImageFormat(buffer);

  let targetExt = options.type
    ? options.type.toLowerCase().replace(/^\./, '')
    : detected.ext;
  if (targetExt === 'jpeg') targetExt = 'jpg';

  // 1. 若为强制 jpeg 模式
  if (mode === 'jpeg' || mode === 'mozjpeg') {
    try {
      const image = imagePool.ingestImage(buffer);
      await image.decoded;
      await image.encode({ mozjpeg: { quality } });
      const encoded = await image.encodedWith.mozjpeg;
      return {
        data: Buffer.from(encoded.binary),
        ext: 'jpg',
        mime: 'image/jpeg',
        bypassed: false,
      };
    } catch (err) {
      console.warn('强制转码 JPEG 异常，降级直通原文件:', err.message || err);
      return {
        data: buffer,
        ext: detected.ext,
        mime: detected.mime,
        bypassed: true,
      };
    }
  }

  // 2. auto 模式：若探测为不支持格式，直接直通
  if (
    !detected.supported &&
    (!options.type ||
      !['jpg', 'jpeg', 'png', 'webp', 'avif', 'jxl', 'wp2'].includes(targetExt))
  ) {
    return {
      data: buffer,
      ext: detected.ext,
      mime: detected.mime,
      bypassed: true,
    };
  }

  // 3. auto 模式：按格式分流压缩
  try {
    const image = imagePool.ingestImage(buffer);
    await image.decoded;

    switch (targetExt) {
      case 'jpg':
      case 'jpeg': {
        await image.encode({ mozjpeg: { quality } });
        const encoded = await image.encodedWith.mozjpeg;
        return {
          data: Buffer.from(encoded.binary),
          ext: 'jpg',
          mime: 'image/jpeg',
          bypassed: false,
        };
      }
      case 'png': {
        await image.encode({ oxipng: { level: 2 } });
        const encoded = await image.encodedWith.oxipng;
        return {
          data: Buffer.from(encoded.binary),
          ext: 'png',
          mime: 'image/png',
          bypassed: false,
        };
      }
      case 'webp': {
        await image.encode({ webp: { quality } });
        const encoded = await image.encodedWith.webp;
        return {
          data: Buffer.from(encoded.binary),
          ext: 'webp',
          mime: 'image/webp',
          bypassed: false,
        };
      }
      case 'avif': {
        await image.encode({ avif: { cqLevel: 33 } });
        const encoded = await image.encodedWith.avif;
        return {
          data: Buffer.from(encoded.binary),
          ext: 'avif',
          mime: 'image/avif',
          bypassed: false,
        };
      }
      case 'jxl': {
        await image.encode({ jxl: { quality } });
        const encoded = await image.encodedWith.jxl;
        return {
          data: Buffer.from(encoded.binary),
          ext: 'jxl',
          mime: 'image/jxl',
          bypassed: false,
        };
      }
      case 'wp2': {
        await image.encode({ wp2: { quality } });
        const encoded = await image.encodedWith.wp2;
        return {
          data: Buffer.from(encoded.binary),
          ext: 'wp2',
          mime: 'image/webp2',
          bypassed: false,
        };
      }
      default:
        return {
          data: buffer,
          ext: detected.ext,
          mime: detected.mime,
          bypassed: true,
        };
    }
  } catch (err) {
    console.warn(
      `格式 [${targetExt}] 压缩异常，降级直通原文件:`,
      err.message || err,
    );
    return {
      data: buffer,
      ext: detected.ext,
      mime: detected.mime,
      bypassed: true,
    };
  }
}

module.exports = {
  detectImageFormat,
  compressImage,
};
