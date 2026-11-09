#!/bin/bash
# 批量测试图片压缩服务
# 用法: ./test-batch-compress.sh [API_URL] [MODE]
# MODE: auto (默认) 或 jpeg

set -uo pipefail

API_URL="${1:-http://localhost:8081/api/compress}"
MODE="${2:-auto}"
TEST_DIR="test/test-images"
OUTPUT_DIR="test/test-output/$MODE"

# 必须大于服务端 SQUOOSH_TIMEOUT（默认 30s），否则客户端先超时，拿不到 504 只拿到 000
CURL_MAX_TIME="${CURL_MAX_TIME:-45}"

mkdir -p "$OUTPUT_DIR"

echo "=== 批量测试图片压缩服务 ==="
echo "API URL: $API_URL"
echo "压缩模式: $MODE"
echo "测试目录: $TEST_DIR"
echo "输出目录: $OUTPUT_DIR"
echo ""

# 统计计数器
TOTAL=0
SUCCESS=0
BYPASSED=0
TOO_LARGE=0
FAILED=0

# 遍历所有测试文件
for file in "$TEST_DIR"/*; do
    [ -f "$file" ] || continue

    TOTAL=$((TOTAL + 1))
    filename=$(basename "$file")
    filesize=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null)

    echo "[$TOTAL] 测试: $filename ($(numfmt --to=iec $filesize 2>/dev/null || echo "${filesize}B"))"

    # 调用压缩 API，同时获取响应头和文件内容
    header_file=$(mktemp)
    body_file=$(mktemp)
    http_code=$(curl -s -w "%{http_code}" -X POST \
        -F "file=@$file" \
        -F "mode=$MODE" \
        "$API_URL" \
        -D "$header_file" \
        -o "$body_file" \
        --max-time "$CURL_MAX_TIME" 2>&1)

    # 从响应头中提取压缩状态
    status_header=$(grep -i "X-Compression-Status" "$header_file" | cut -d: -f2 | tr -d ' \r\n')
    rm -f "$header_file"

    if [ "$http_code" = "200" ]; then
        mv "$body_file" "$OUTPUT_DIR/$filename"
        output_size=$(stat -c%s "$OUTPUT_DIR/$filename" 2>/dev/null || stat -f%z "$OUTPUT_DIR/$filename" 2>/dev/null)

        if [ "$status_header" = "bypassed" ]; then
            echo "   → 直通 (bypassed)"
            BYPASSED=$((BYPASSED + 1))
        else
            # 使用 awk 计算压缩率，避免依赖 bc
            if [ -n "$filesize" ] && [ "$filesize" -gt 0 ] && [ -n "$output_size" ]; then
                ratio=$(awk "BEGIN {printf \"%.1f\", ($output_size / $filesize) * 100}")
                echo "   → 成功 (${filesize}B → ${output_size}B, ${ratio}%)"
            else
                echo "   → 成功 (${filesize}B → ${output_size}B)"
            fi
            SUCCESS=$((SUCCESS + 1))
        fi
    elif [ "$http_code" = "413" ]; then
        echo "   → 文件过大 (413)"
        TOO_LARGE=$((TOO_LARGE + 1))
    elif [ "$http_code" = "429" ]; then
        echo "   → 并发超限 (429)"
        FAILED=$((FAILED + 1))
    elif [ "$http_code" = "400" ]; then
        echo "   → 请求错误 (400)"
        FAILED=$((FAILED + 1))
    elif [ "$http_code" = "504" ]; then
        echo "   → 超时 (504)"
        FAILED=$((FAILED + 1))
    else
        echo "   → 失败 (HTTP $http_code)"
        FAILED=$((FAILED + 1))
    fi
    rm -f "$body_file"

    # 短暂延迟，避免压垮服务
    sleep 0.1
done

echo ""
echo "=== 测试完成 ==="
echo "总计: $TOTAL 个文件"
echo "成功: $SUCCESS"
echo "直通: $BYPASSED"
echo "过大: $TOO_LARGE"
echo "失败: $FAILED"
echo ""

# 生成报告
if [ $FAILED -gt 0 ]; then
    echo "⚠️  有 $FAILED 个文件处理失败，请检查日志"
    exit 1
else
    echo "✅ 所有文件处理成功"
    exit 0
fi
