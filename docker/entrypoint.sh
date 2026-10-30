#!/bin/sh

set -e

# 若传入自定义命令（如 squoosh-cli、squoosh-auto、sh），直接执行
if [ "$#" -gt 0 ] && [ "$1" != "default" ]; then
  exec "$@"
fi

echo "========================================================"
echo " 正在启动 Squoosh 服务:"
echo "   - Web 界面: http://0.0.0.0:8080"
echo "   - HTTP 压缩 API: http://0.0.0.0:8081"
echo "========================================================"

# 启动 8080 静态 Web 服务
serve --listen=8080 --config=/app/serve.json /app/build &
SERVE_PID=$!

# 启动 8081 HTTP API 压缩服务
NODE_ENV=production NODE_NO_WARNINGS=1 node --expose-gc --max-old-space-size=4096 /app/server/api-server.js &
API_PID=$!

# 优雅终止处理
shutdown() {
  echo ""
  echo "接收到停止信号，正在停止服务..."
  kill -TERM "$API_PID" 2>/dev/null || true
  kill -TERM "$SERVE_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  wait "$SERVE_PID" 2>/dev/null || true
  echo "服务已全部优雅退出。"
  exit 0
}

trap shutdown INT TERM

# 等待任意子进程退出
wait
