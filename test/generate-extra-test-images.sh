#!/bin/bash
# 生成额外的测试图片（使用 ImageMagick）

TEST_DIR="test/test-images"
mkdir -p "$TEST_DIR"

echo "=== 生成额外的测试图片 ==="

# CMYK JPEG
convert -size 200x200 gradient:red-blue -colorspace CMYK "$TEST_DIR/cmyk.jpg"
echo "✓ cmyk.jpg (CMYK JPEG)"

# 损坏的图片文件
# 截断的 JPEG
head -c 5000 "$TEST_DIR/standard.jpg" > "$TEST_DIR/corrupted_truncated.jpg"
echo "✓ corrupted_truncated.jpg (截断的 JPEG)"

# 无效 JPEG 头
printf '\xff\xd8\xff\xe0\x00\x00\x00\x00\x00\x00' > "$TEST_DIR/corrupted_header.jpg"
echo "✓ corrupted_header.jpg (无效 JPEG 头)"

# 非图片文件伪装成 JPEG
echo "This is not a real image file" > "$TEST_DIR/fake_image.jpg"
echo "✓ fake_image.jpg (非图片文件)"

# WebP 变体
convert "$TEST_DIR/standard.png" -quality 20 "$TEST_DIR/webp_q20.webp"
convert "$TEST_DIR/standard.png" -quality 50 "$TEST_DIR/webp_q50.webp"
convert "$TEST_DIR/standard.png" -quality 80 "$TEST_DIR/webp_q80.webp"
echo "✓ webp_q20.webp, webp_q50.webp, webp_q80.webp"

# 动画 GIF
convert -delay 50 -loop 0 "$TEST_DIR/standard.png" "$TEST_DIR/progressive.jpg" "$TEST_DIR/cmyk.jpg" "$TEST_DIR/animated.gif"
echo "✓ animated.gif (动画 GIF)"

# BMP 文件
convert "$TEST_DIR/standard.png" "$TEST_DIR/test.bmp"
echo "✓ test.bmp (BMP)"

# TIFF 文件
convert "$TEST_DIR/standard.png" "$TEST_DIR/test.tiff"
echo "✓ test.tiff (TIFF)"

# ICO 文件
convert "$TEST_DIR/standard.png" -resize 64x64 "$TEST_DIR/test.ico"
echo "✓ test.ico (ICO)"

# 带 ICC Profile 的 JPEG
convert "$TEST_DIR/standard.png" -profile /usr/share/color/icc/sRGB.icc "$TEST_DIR/with_icc.jpg" 2>/dev/null || \
convert "$TEST_DIR/standard.png" "$TEST_DIR/with_icc.jpg"
echo "✓ with_icc.jpg (带 ICC Profile)"

# 算术编码 JPEG (SOF9)
# 注意：ImageMagick 可能不支持直接生成算术编码 JPEG
# 这里创建一个标记为算术编码的文件头
printf '\xff\xd8\xff\xc9\x00\x11\x08\x00\x64\x00\xc8\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01' > "$TEST_DIR/arithmetic.jpg"
echo "✓ arithmetic.jpg (算术编码 JPEG 头)"

# 超大尺寸图片 (使用 ImageMagick，更快)
convert -size 5000x5000 gradient:red-blue "$TEST_DIR/large_25mp.jpg"
echo "✓ large_25mp.jpg (25MP, 接近限制)"

echo ""
echo "=== 完成！==="
ls -lh "$TEST_DIR" | wc -l
echo "个测试文件已生成"
