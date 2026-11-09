# 图片预处理校验模块代码审查与安全加固报告

> **审查对象：** 图片预处理校验模块 (`validateImage` / `validateJpeg` / `validatePng` / `validateWebp`)  
> **模块职责：** 在进入 WASM 编解码器前快速校验图片二进制头，拦截异常色彩空间（CMYK）、不支持的编码格式（算术编码/动图）及超大分辨率（>100MP）图片，防止 WASM 内存溢出（OOM）或主线程卡死。  
> **审查结论：** 原始代码的设计意图清晰，但在**二进制协议解析细节**和**边界安全控制**上存在 **8 处高危缺陷**（包含死循环 DoS 风险、协议偏移量计算错误导致校验 100% 失效、以及 32 位有符号位运算溢出绕过校验等）。

> **报告之后的变更：** 像素上限仍为 100MP，但改为可用 `SQUOOSH_MAX_MEGAPIXELS` 覆盖；
> JPEG 校验新增 EOI 收尾检查，用于拦截头部完整但熵数据被截断的文件；`compressor.js` 只对校验器
> 认识的 JPEG/PNG/WebP 做前置校验，AVIF 等格式仍交给编解码器判定。

---

## 一、 问题汇总矩阵

| 编号   | 严重程度           | 所属函数               | 问题简述                                                                   | 潜在后果                                                               |
| :----- | :----------------- | :--------------------- | :------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| **#1** | 🔴 致命 (Critical) | `validateJpeg`         | 段长度未校验最小值（$<2$）且连续 `0xFF` 填充字节步进错误                   | 畸形文件触发**死循环 (DoS)**；含合法填充字节的正常图片被误判为损坏     |
| **#2** | 🔴 致命 (Critical) | `validateJpeg`         | ICC Profile 误查了 `0xEC` 段且切片仅 10 字节（`'ICC_PROFILE'` 为 11 字节） | ICC CMYK 检测逻辑 **100% 永远无法命中**（死代码）                      |
| **#3** | 🟠 高危 (High)     | `validatePng`          | 使用 `<< 24` 位运算解析宽高，触发 JS 32 位有符号整数负数溢出               | 恶意构造高位为 1 的宽高可算出负数像素，**绕过 100MP 限制打爆 WASM**    |
| **#4** | 🟠 高危 (High)     | `validateWebp`         | 仅校验了动图标志，完全缺失宽高解析与 `>100MP` 尺寸拦截                     | 超大尺寸 WebP 图片（最高达 268MP）可无阻碍进入 WASM 引发 OOM           |
| **#5** | 🟡 中危 (Medium)   | `validatePng`          | 最小长度仅检查 `< 24`，随后立即越界读取 `buffer[24]` 和 `buffer[25]`       | 24~25 字节的截断文件会使 `bitDepth` 变为 `undefined`，跳过 16-bit 检查 |
| **#6** | 🟡 中危 (Medium)   | `validateJpeg`         | 漏判无长度字段的独立标记（`RST0-RST7`、`TEM`）                             | 遇到含重启标记的头部时，错将后续数据当成长度跳过，导致解析错位         |
| **#7** | 🟡 中危 (Medium)   | `validateJpeg`         | 算术编码仅拦截了 `0xC9-0xCB`，漏掉渐进式/差分算术编码 `0xCD-0xCF`          | `SOF13` ~ `SOF15` 的算术编码 JPEG 仍会流入 WASM 引发解码异常           |
| **#8** | 🟢 低危 (Low)      | 全局 / `validateImage` | 频繁使用 `buffer.slice().toString()` 分配内存；`RIFF` 未校验 `WEBP` 签名   | 不必要的 GC 开销；传入 `.wav` / `.avi` 文件时报错信息不准确            |

---

## 二、 核心缺陷深度剖析与修复方案

### 1. [致命] JPEG 段长度未校验与 `0xFF` 填充字节步进错误（死循环与误杀风险）

- **原代码片段：**
  ```javascript
  // APP 段处理
  if (marker >= 0xe0 && marker <= 0xef) {
    const segmentLength = (buffer[offset + 2] << 8) | buffer[offset + 3];
    // ...
    offset += 2 + segmentLength;
  } else if (marker === 0x00 || marker === 0xff) {
    offset += 2;
  } else {
    if (offset + 4 > buffer.length) break;
    const len = (buffer[offset + 2] << 8) | buffer[offset + 3];
    offset += 2 + len;
  }
  ```
- **缺陷分析：**
  1. **连续 `0xFF` 填充字节误跳：** 根据 JPEG 标准（ITU-T T.81 Section B.1.1.2），任何标记前允许出现任意数量的 `0xFF` 填充字节（Fill bytes）。例如字节序列 `0xFF 0xFF 0xC0`：当 `offset` 指向第一个 `0xFF` 时，`marker`（即 `buffer[offset + 1]`）为第二个 `0xFF`。原代码执行 `offset += 2`，**直接跳过了第二个 `0xFF` 落在了 `0xC0` 上**。下一轮循环检查 `buffer[offset] !== 0xff` 为真，直接 `break` 退出循环，导致合法的 JPEG 图片被误判为 `缺少帧信息`！
  2. **越界与异常段长度：** 在 JPEG 规范中，段长度 `segmentLength` 包含长度字段自身的 2 个字节，合法值必须满足 `segmentLength >= 2` 且 `offset + 2 + segmentLength <= buffer.length`。原代码在 `APP` 段读取 `buffer[offset + 2]` 前未检查 `offset + 4 <= buffer.length`，可能读出 `undefined`（位运算后 `segmentLength` 变为 `0`）。
- **修复方案：**
  - 当 `marker === 0xff` 时，只前进 1 个字节（`offset += 1; continue;`）。
  - 统一校验 `segmentLength >= 2 && offset + 2 + segmentLength <= buffer.length`。

---

### 2. [致命] JPEG ICC Profile 色彩空间检测存在 3 处协议级错误（100% 失效）

- **原代码片段：**
  ```javascript
  // 检查 ICC Profile 中的 CMYK
  if (marker === 0xec && offset + 14 < buffer.length) {
    const header = buffer.slice(offset + 4, offset + 14).toString('ascii');
    if (
      header.startsWith('ICC_PROFILE') &&
      offset + 18 + segmentLength < buffer.length
    ) {
      const iccOffset = offset + 14;
      if (buffer.length > iccOffset + 20) {
        const colorSpaceSig = buffer
          .slice(iccOffset + 16, iccOffset + 20)
          .toString('ascii');
  ```
- **缺陷分析：**
  1. **Marker 编号错误：** JPEG 的 ICC Profile 标准存放在 **APP2 (`0xE2`)** 段中，而 `0xEC` 是 APP12（Photoshop Ducky 段）。
  2. **切片长度不足：** `'ICC_PROFILE'` 字符串长度为 **11 字节**，但 `buffer.slice(offset + 4, offset + 14)` 仅截取了 **10 字节**。10 字节的字符串调用 `.startsWith('ICC_PROFILE')` 永远返回 `false`！
  3. **ICC Header 偏移量计算错误：** APP2 段的完整头部结构如下：
     - `0xFF 0xE2`（2 字节，`offset + 0..2`）
     - `Length`（2 字节，`offset + 2..4`）
     - `'ICC_PROFILE\0'`（12 字节，含末尾 `\0`，`offset + 4..16`）
     - `Chunk Sequence Number`（1 字节，从 1 开始，`offset + 16`）
     - `Total Chunks`（1 字节，`offset + 17`）
     - **ICC Profile Header 起点：** 位于 `offset + 18`（且仅在第 1 个分片 `Chunk === 1` 时存在）。
     - **Color Space Signature 位置：** 位于 ICC Header 内部偏移 `16..20` 字节处，即绝对偏移量应为 **`offset + 34` 到 `offset + 38`**（原代码写成了 `offset + 30..34`）。

---

### 3. [高危] PNG 宽高位运算存在 32 位有符号整数溢出漏洞

- **原代码片段：**
  ```javascript
  const width =
    (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
  const height =
    (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
  ```
- **缺陷分析：**
  - 在 JavaScript 中，所有的按位操作符（`<<`、`|`）都会将操作数转换为 **32 位有符号整数（Int32，双补码表示）**。
  - 如果攻击者构造一张畸形 PNG，令 `buffer[16] = 0x80`（最高位为 1），则 `width` 计算结果为负数（例如 `-2147483648`）。
  - 随后进行的 `if (width === 0 || height === 0)` 无法拦截负数，且 `megapixels = (width * height) / 1000000` 若一正一负同样为负数，直接绕过 `megapixels > 100` 的阈值检查！
- **修复方案：**
  - 改用 Node.js `Buffer` 原生无符号读取方法：`buffer.readUInt32BE(16)`。
  - 同时按 PNG 规范校验宽高上限：`width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff`。

---

### 4. [高危] WebP 格式未做分辨率尺寸校验

- **缺陷分析：**
  - `validateWebp` 仅识别了 `VP8 `、`VP8L`、`VP8X` 四字符码及动图标志，未解析宽高，也未校验 `MAX_MEGAPIXELS (100MP)`。
  - 根据 WebP 规范，三种格式均可在文件前 30 字节内直接提取出宽高：
    - **`VP8 ` (有损)：** 偏移 `23..26` 为帧签名 `0x9D 0x01 0x2A`，偏移 `26..28` 和 `28..30` 的低 14 位（Little-Endian）即为宽高。
    - **`VP8L` (无损)：** 偏移 `20` 为签名 `0x2F`，偏移 `21..25` 的 32 位小端整数中，低 14 位 $+1$ 为宽，次 14 位 $+1$ 为高。
    - **`VP8X` (扩展)：** 偏移 `24..27` 的 24 位小端整数 $+1$ 为宽，偏移 `27..30` 的 24 位小端整数 $+1$ 为高。

---

## 三、 落地代码位置

加固后的实现不再在本报告内重复粘贴（避免与源码漂移），请直接查看：

- `server/image-validator.js` — 校验实现
- `server/compressor.js` — 前置校验接入点与格式分流
- `test/image-validator.test.js` — 针对性二进制构造用例

## 四、 单元测试用例建议 (Jest / Mocha)

为确保上述边界条件不再退化，建议在测试套件中补充以下针对性二进制构造用例：

```javascript
const assert = require('assert');
const { validateImage } = require('./imageValidator');

// 1. 测试 JPEG 连续 0xFF 填充字节不会误报失败
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
assert.strictEqual(validateImage(jpegWithFillBytes).valid, true);

// 2. 测试 JPEG APP2 ICC_PROFILE CMYK 精准拦截
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

// 3. 测试 PNG 宽高最高位为 1 时不会因负数溢出而绕过校验
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
assert.strictEqual(validateImage(pngNegativeOverflow).valid, false);
```
