#!/bin/bash
# 生成测试图片（依赖 ImageMagick）
# test-images/ 在 .gitignore 内，因此本脚本必须能从零生成全部基准素材

set -uo pipefail

TEST_DIR="${TEST_DIR:-test/test-images}"
TOTAL=0
FAILED=0

if ! command -v convert >/dev/null 2>&1; then
    echo "✗ 缺少 ImageMagick (convert)，无法生成测试图片" >&2
    exit 1
fi

mkdir -p "$TEST_DIR"

echo "=== 生成测试图片 ==="

# 单条生成失败不再被静默忽略
gen() {
    local desc="$1"
    shift
    TOTAL=$((TOTAL + 1))
    if "$@" >/dev/null 2>&1; then
        echo "✓ $desc"
    else
        echo "✗ $desc (生成失败)" >&2
        FAILED=$((FAILED + 1))
    fi
}

# 同上，但把命令 stdout 重定向到目标文件（重定向限定在组合命令内，不影响计数输出）
gen_to() {
    local desc="$1"
    local out="$2"
    shift 2
    TOTAL=$((TOTAL + 1))
    if { "$@" > "$out"; } >/dev/null 2>&1; then
        echo "✓ $desc"
    else
        echo "✗ $desc (生成失败)" >&2
        FAILED=$((FAILED + 1))
    fi
}

# 基准素材：全新 clone 后目录是空的，必须先自举
gen "standard.png (基准 PNG)" convert -size 200x200 gradient:red-blue "$TEST_DIR/standard.png"
gen "standard.jpg (基准 JPEG)" convert -quality 85 "$TEST_DIR/standard.png" "$TEST_DIR/standard.jpg"
gen "standard.webp (基准 WebP)" convert "$TEST_DIR/standard.png" -quality 80 "$TEST_DIR/standard.webp"

if [ ! -s "$TEST_DIR/standard.png" ] || [ ! -s "$TEST_DIR/standard.jpg" ]; then
    echo "✗ 基准图缺失，依赖基准图的用例无法生成" >&2
    exit 1
fi

# 不同质量 / 渐进式 / 灰度 / 透明 / 16-bit
for q in 10 30 50 75 95; do
    gen "jpeg_q$q.jpg" convert "$TEST_DIR/standard.png" -quality "$q" "$TEST_DIR/jpeg_q$q.jpg"
done
gen "progressive.jpg (渐进式 JPEG)" convert -interlace Line "$TEST_DIR/standard.jpg" "$TEST_DIR/progressive.jpg"
gen "grayscale.jpg (灰度 JPEG)" convert -size 200x200 gradient:red-blue -colorspace Gray "$TEST_DIR/grayscale.jpg"
gen "grayscale.png (灰度 PNG)" convert -size 200x200 gradient:red-blue -colorspace Gray "$TEST_DIR/grayscale.png"
gen "transparent.png (透明 PNG)" convert -size 200x200 gradient:red-blue -channel A -evaluate set 50% +channel "$TEST_DIR/transparent.png"
gen "16bit.png (16-bit PNG)" convert -size 100x100 gradient:red-blue -depth 16 "$TEST_DIR/16bit.png"

# 不同尺寸 PNG
for size in 100x100 500x500 1000x1000 2000x2000; do
    gen "png_${size}.png" convert -size "$size" gradient:red-blue "$TEST_DIR/png_${size}.png"
done

# CMYK JPEG
gen "cmyk.jpg (CMYK JPEG)" convert -size 200x200 gradient:red-blue -colorspace CMYK "$TEST_DIR/cmyk.jpg"

# 损坏的图片文件
# 截断的 JPEG：必须真的比原文件短，否则得到的是一张完整图（原实现固定 5000B 截不出任何东西）
std_size=$(stat -c%s "$TEST_DIR/standard.jpg" 2>/dev/null || stat -f%z "$TEST_DIR/standard.jpg")
trunc_size=$((std_size / 2))
if [ "$trunc_size" -ge 100 ]; then
    gen_to "corrupted_truncated.jpg (截断到 ${trunc_size}B 的 JPEG)" \
        "$TEST_DIR/corrupted_truncated.jpg" head -c "$trunc_size" "$TEST_DIR/standard.jpg"
else
    echo "✗ 基准 JPEG 太小（${std_size}B），无法生成截断样本" >&2
    FAILED=$((FAILED + 1))
fi

# 无效 JPEG 头
gen_to "corrupted_header.jpg (无效 JPEG 头)" "$TEST_DIR/corrupted_header.jpg" \
    printf '\xff\xd8\xff\xe0\x00\x00\x00\x00\x00\x00'

# 非图片文件伪装成 JPEG
gen_to "fake_image.jpg (非图片文件)" "$TEST_DIR/fake_image.jpg" \
    printf 'This is not a real image file'

# WebP 变体
for q in 20 50 80; do
    gen "webp_q$q.webp" convert "$TEST_DIR/standard.png" -quality "$q" "$TEST_DIR/webp_q$q.webp"
done

# 动画 GIF
gen "animated.gif (动画 GIF)" convert -delay 50 -loop 0 "$TEST_DIR/standard.png" "$TEST_DIR/progressive.jpg" "$TEST_DIR/cmyk.jpg" "$TEST_DIR/animated.gif"

# BMP / TIFF / ICO
gen "test.bmp (BMP)" convert "$TEST_DIR/standard.png" "$TEST_DIR/test.bmp"
gen "test.tiff (TIFF)" convert "$TEST_DIR/standard.png" "$TEST_DIR/test.tiff"
gen "test.ico (ICO)" convert "$TEST_DIR/standard.png" -resize 64x64 "$TEST_DIR/test.ico"

# 带 ICC Profile 的 JPEG
ICC_PROFILE="/usr/share/color/icc/sRGB.icc"
if [ -f "$ICC_PROFILE" ]; then
    gen "with_icc.jpg (带 ICC Profile)" convert "$TEST_DIR/standard.png" -profile "$ICC_PROFILE" "$TEST_DIR/with_icc.jpg"
else
    gen "with_icc.jpg (系统无 sRGB.icc，退化为无 Profile)" convert "$TEST_DIR/standard.png" "$TEST_DIR/with_icc.jpg"
fi

# 算术编码 JPEG (SOF9)：ImageMagick 通常无法直接生成，这里只造文件头
gen_to "arithmetic.jpg (算术编码 JPEG 头)" "$TEST_DIR/arithmetic.jpg" \
    printf '\xff\xd8\xff\xc9\x00\x11\x08\x00\x64\x00\xc8\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01'

# 尺寸边界：25MP 应正常压缩，110MP 应被默认 100MP 上限拦下直通
gen "large_25mp.jpg (25MP，应正常压缩)" convert -size 5000x5000 gradient:red-blue "$TEST_DIR/large_25mp.jpg"
gen "over_limit_110mp.jpg (110MP，应直通)" convert -size 11000x10000 gradient:red-blue "$TEST_DIR/over_limit_110mp.jpg"

echo ""
echo "=== 完成：尝试生成 $TOTAL 个，失败 $FAILED 个 ==="
echo "目录内文件总数: $(ls -1 "$TEST_DIR" | wc -l)"

[ "$FAILED" -eq 0 ]
