# 测试说明

本目录包含图片压缩服务的各类测试脚本和测试数据。

## 目录结构

```
test/
├── README.md                      # 本文件
├── api-server.test.js             # API 服务单元测试
├── compressor.test.js             # 压缩器单元测试
├── image-validator.test.js        # 图片校验器单元测试
├── e2e-api.sh                     # 端到端集成测试
├── generate-extra-test-images.sh  # 生成额外测试图片
├── test-batch-compress.sh         # 批量压缩测试
└── test-images/                   # 测试图片目录（31个文件）
```

## 单元测试

### 运行所有单元测试

```bash
# 在容器内运行
docker run --rm -v "$(pwd)":/app -w /app \
  -e NODE_PATH=/usr/local/lib/node_modules/@squoosh/cli/node_modules:/usr/local/lib/node_modules:/app/server/node_modules \
  squoosh-new:cli node test/api-server.test.js

docker run --rm -v "$(pwd)":/app -w /app \
  -e NODE_PATH=/usr/local/lib/node_modules/@squoosh/cli/node_modules:/usr/local/lib/node_modules:/app/server/node_modules \
  squoosh-new:cli node test/compressor.test.js

docker run --rm -v "$(pwd)":/app -w /app \
  -e NODE_PATH=/usr/local/lib/node_modules/@squoosh/cli/node_modules:/usr/local/lib/node_modules:/app/server/node_modules \
  squoosh-new:cli node test/image-validator.test.js
```

### 测试内容

- **api-server.test.js**: 测试 HTTP API 接口，包括健康检查、文件上传、错误处理、中文文件名等
- **compressor.test.js**: 测试压缩逻辑，包括格式检测、压缩分流、直通处理
- **image-validator.test.js**: 测试图片校验逻辑，包括 JPEG/PNG/WebP 格式校验、CMYK 检测、尺寸限制等

## 端到端测试

### e2e-api.sh

启动容器并运行端到端测试：

```bash
# 启动测试容器
docker run -d --name squoosh-test -p 18080:8080 -p 18081:8081 squoosh-new:cli

# 等待服务启动
sleep 3

# 运行测试
API_PORT=18081 WEB_PORT=18080 ./test/e2e-api.sh

# 清理
docker rm -f squoosh-test
```

测试内容包括：

- 健康检查接口
- PNG 自动压缩
- WebP 转 JPEG
- GIF 直通处理
- 缺少文件字段的错误处理
- Web 界面访问

## 测试图片生成

### generate-extra-test-images.sh

生成各种格式的测试图片，用于测试压缩服务的边界情况：

```bash
./test/generate-extra-test-images.sh
```

生成的测试图片包括：

- **标准格式**: JPEG、PNG、WebP
- **不同质量**: JPEG q10/q30/q50/q75/q95
- **特殊格式**: 渐进式 JPEG、灰度图、透明 PNG、16-bit PNG
- **边缘情况**: CMYK JPEG、动画 GIF、BMP、TIFF、ICO
- **损坏文件**: 截断 JPEG、无效 JPEG 头、假图片文件
- **大文件**: 25MP 大图（接近 100MP 限制）
- **特殊属性**: 带 ICC Profile、带 EXIF、索引色

## 批量压缩测试

### test-batch-compress.sh

对 test-images 目录下的所有测试图片进行批量压缩测试：

```bash
# 测试 auto 模式（默认）
./test/test-batch-compress.sh http://localhost:8081/api/compress auto

# 测试 jpeg 模式
./test/test-batch-compress.sh http://localhost:8081/api/compress jpeg
```

输出示例：

```
=== 批量测试图片压缩服务 ===
API URL: http://localhost:8081/api/compress
压缩模式: auto
测试目录: test/test-images
输出目录: test/test-output/auto

[1] 测试: 16bit.png (643B)
   → 成功 (643B → 5733B, 891.6%)
[2] 测试: animated.gif (23K)
   → 直通 (bypassed)
[3] 测试: cmyk.jpg (3.9K)
   → 直通 (bypassed)
...

=== 测试完成 ===
总计: 31 个文件
成功: 23
直通: 8
失败: 0

✅ 所有文件处理成功
```

## 测试图片说明

test-images 目录包含 31 个测试文件，覆盖以下场景：

| 文件                  | 格式           | 预期行为 |
| --------------------- | -------------- | -------- |
| standard.jpg/png/webp | 标准格式       | 成功压缩 |
| jpeg_q\*.jpg          | 不同质量 JPEG  | 成功压缩 |
| progressive.jpg       | 渐进式 JPEG    | 成功压缩 |
| png\__x_.png          | 不同尺寸 PNG   | 成功压缩 |
| transparent.png       | 透明 PNG       | 成功压缩 |
| 16bit.png             | 16-bit PNG     | 成功压缩 |
| grayscale.\*          | 灰度图         | 成功压缩 |
| large_25mp.jpg        | 25MP 大图      | 成功压缩 |
| animated.gif          | 动画 GIF       | 直通     |
| cmyk.jpg              | CMYK JPEG      | 直通     |
| arithmetic.jpg        | 算术编码 JPEG  | 直通     |
| test.bmp/tiff/ico     | 不支持格式     | 直通     |
| corrupted\_\*.jpg     | 损坏文件       | 直通     |
| fake_image.jpg        | 假图片         | 直通     |
| with_icc.jpg          | 带 ICC Profile | 成功压缩 |

## 测试流程

完整的测试流程：

```bash
# 1. 生成测试图片（如果还没有）
./test/generate-extra-test-images.sh

# 2. 启动服务
docker-compose up -d squoosh-cli

# 3. 运行单元测试
docker run --rm -v "$(pwd)":/app -w /app \
  -e NODE_PATH=/usr/local/lib/node_modules/@squoosh/cli/node_modules:/usr/local/lib/node_modules:/app/server/node_modules \
  squoosh-new:cli node test/api-server.test.js

# 4. 运行端到端测试
./test/e2e-api.sh

# 5. 运行批量压缩测试
./test/test-batch-compress.sh http://localhost:8081/api/compress auto
./test/test-batch-compress.sh http://localhost:8081/api/compress jpeg

# 6. 清理
docker-compose down
```
