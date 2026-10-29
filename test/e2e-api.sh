#!/bin/sh

set -eu

echo "=== 开始端到端 (E2E) API 验证 ==="

API_PORT="${API_PORT:-18081}"
WEB_PORT="${WEB_PORT:-18080}"

# 1. 验证健康检查
echo "1. 测试 GET /health"
HEALTH_OUT=$(curl -s "http://127.0.0.1:${API_PORT}/health")
echo "  响应: $HEALTH_OUT"
echo "$HEALTH_OUT" | grep -q '"status":"ok"'

# 2. 验证 PNG auto 压缩
echo "2. 测试 POST /api/compress (PNG auto 压缩)"
ORIG_PNG_SIZE=$(stat -c%s codecs/example_palette.png)
COMP_PNG_SIZE=$(curl -s -F "file=@codecs/example_palette.png" -F "mode=auto" "http://127.0.0.1:${API_PORT}/api/compress" -o /tmp/e2e_out.png -w '%{size_download}')
echo "  原文件: ${ORIG_PNG_SIZE} 字节，压缩后: ${COMP_PNG_SIZE} 字节"
[ "$COMP_PNG_SIZE" -lt "$ORIG_PNG_SIZE" ]
[ -s /tmp/e2e_out.png ]

# 3. 验证 WebP 转码 JPEG
echo "3. 测试 POST /api/compress (WebP -> JPEG 转码)"
curl -s -D /tmp/jpeg_headers.txt -F "file=@codecs/example.webp" -F "mode=jpeg" "http://127.0.0.1:${API_PORT}/api/compress" -o /tmp/e2e_out.jpg
grep -iq "content-type: image/jpeg" /tmp/jpeg_headers.txt
echo "  Content-Type 验证为 image/jpeg 成功"
[ -s /tmp/e2e_out.jpg ]

# 4. 验证不支持格式直通 (GIF)
echo "4. 测试 POST /api/compress (GIF 格式直通)"
echo "GIF89a--mock-gif-bytes--" > /tmp/test.gif
curl -s -D /tmp/gif_headers.txt -F "file=@/tmp/test.gif" -F "mode=auto" "http://127.0.0.1:${API_PORT}/api/compress" -o /tmp/e2e_out.gif
grep -iq "x-compression-status: bypassed" /tmp/gif_headers.txt
cmp -s /tmp/test.gif /tmp/e2e_out.gif
echo "  GIF 直通成功，返回内容与原文件完全一致"

# 5. 验证缺少 file 触发 400
echo "5. 测试缺少 file 触发 400"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -F "mode=auto" "http://127.0.0.1:${API_PORT}/api/compress")
[ "$HTTP_CODE" = "400" ]
echo "  HTTP 状态码: $HTTP_CODE 校验成功"

# 6. 验证 Web 静态端点 8080 可访问
echo "6. 测试 GET http://127.0.0.1:${WEB_PORT}/"
WEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_PORT}/")
[ "$WEB_CODE" = "200" ]
echo "  Web 服务 8080 返回 HTTP $WEB_CODE 校验成功"

echo "=== 全部端到端 (E2E) 测试通过 ==="
