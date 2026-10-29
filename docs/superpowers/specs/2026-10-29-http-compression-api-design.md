# HTTP 图片压缩服务设计规范 (Squoosh HTTP Compression API)

## 1. 概述与背景

当前 Squoosh CLI 镜像提供了命令行方式的单图/批量压缩能力以及 8080 端口的 Web 界面服务。为满足系统间通过 HTTP 请求直接调用图片压缩能力的需求，本项目将在该镜像内增加一套独立的 HTTP API 压缩微服务，监听 **8081** 端口，支持高并发、纯内存零落盘处理、智能分流及优雅降级。

---

## 2. 总体架构与服务编排

### 2.1 架构示意

```
+-------------------------------------------------------------------------+
| Squoosh CLI Docker 容器 (node:16.20.2-alpine)                           |
|                                                                         |
|   [ /usr/local/bin/docker-entrypoint.sh ] (PID 1)                       |
|       |                                                                 |
|       +--> [ serve ] (后台进程) -------------------------> 监听 8080    |
|       |    (托管 /app/build 静态 Web 应用)                              |
|       |                                                                 |
|       +--> [ node /app/server/api-server.js ] -----------> 监听 8081    |
|            (基于 @squoosh/lib 常驻 ImagePool 线程池)                    |
|                                                                         |
+-------------------------------------------------------------------------+
```

### 2.2 进程管理与生命周期 (`docker/entrypoint.sh`)

- 作为容器 `PID 1` 启动脚本。
- 后台启动静态 Web 服务：`serve --listen=8080 --config=/app/serve.json /app/build &`
- 捕获 `SIGTERM` 与 `SIGINT` 信号，收到停止信号时：
  1. 向 `serve` 进程与 Node.js API 进程发送终止信号；
  2. 等待 `ImagePool` 完成当前任务并关闭，释放端口与线程池；
  3. 安全退出。

### 2.3 端口暴露与环境映射

- 容器内暴露端口：`8080`（Web 界面）与 `8081`（HTTP API 压缩服务）。
- `docker-compose.yml` 环境变量映射：
  - Web 端口：`${SQUOOSH_CLI_WEB_PORT:-8080}:8080`
  - API 端口：`${SQUOOSH_CLI_API_PORT:-8081}:8081`

---

## 3. HTTP API 接口规范

### 3.1 图片压缩接口

- **路径**：`POST /api/compress` 或 `POST /compress`
- **请求内容类型**：`multipart/form-data`
- **单图最大体积**：默认 50MB（可通过环境变量 `MAX_FILE_SIZE_MB=50` 配置）。超过限制直接返回 `413 Payload Too Large`。

#### 请求字段 (Form Data)

| 字段名    | 类型    | 必填 | 默认值 | 说明                                                                                                                                                                 |
| :-------- | :------ | :--- | :----- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`    | File 流 | 是   | -      | 待压缩图片的原始二进制数据流                                                                                                                                         |
| `mode`    | String  | 否   | `auto` | 压缩模式：<br>• `auto`：按原格式智能压缩（JPG 走 MozJPEG，PNG 走 OxiPNG，WebP 走 WebP，AVIF 走 AVIF 等）<br>• `jpeg` 或 `mozjpeg`：无论原格式，统一转为 MozJPEG 输出 |
| `type`    | String  | 否   | -      | 显式指定图片格式扩展名（如 `png`、`jpg`、`webp` 等），缺省时依据文件名后缀或文件特征字节探测                                                                         |
| `quality` | Number  | 否   | 75     | 目标画质（1~100），仅对支持有损 quality 参数的编码器生效（如 mozjpeg、webp、jxl、wp2）                                                                               |

#### 响应定义

##### 1. 压缩成功 (Success)

- **HTTP 状态码**：`200 OK`
- **Response Headers**：
  - `Content-Type`: 压缩后图片的 MIME 类型（如 `image/jpeg`、`image/png`、`image/webp`、`image/avif`）
  - `Content-Disposition`: `inline; filename="compressed-<original_name>.<ext>"`
  - `X-Compression-Status`: `success`
  - `X-Original-Size`: 原始字节大小
  - `X-Compressed-Size`: 压缩后字节大小
  - `X-Compression-Ratio`: 压缩率百分比（如 `45.2%`）
- **Response Body**：压缩后的图片二进制数据。

##### 2. 不支持格式 / 异常降级 (Bypassed)

- 当图片为不支持编码的格式（如 GIF、BMP、SVG、ICO 或其他数据），或者由于底层编解码异常失败时，保证业务连续性，**原样返回原文件流**。
- **HTTP 状态码**：`200 OK`
- **Response Headers**：
  - `Content-Type`: 原图检测到的 MIME 类型（如 `image/gif`）或 `application/octet-stream`
  - `Content-Disposition`: `inline; filename="<original_name>"`
  - `X-Compression-Status`: `bypassed`
  - `X-Original-Size`: 原始字节大小
  - `X-Compressed-Size`: 原始字节大小
- **Response Body**：原图二进制数据。

##### 3. 错误响应 (Error)

- **HTTP 状态码**：`400 Bad Request`（缺少 file 字段或参数非法）/ `413 Payload Too Large`（超限）/ `500 Internal Server Error`
- **Response Headers**：`Content-Type: application/json; charset=utf-8`
- **Response Body**：
  ```json
  {
    "code": "BAD_REQUEST",
    "message": "Missing file in multipart form-data"
  }
  ```

---

### 3.2 健康检查接口

- **路径**：`GET /health`
- **HTTP 状态码**：`200 OK`
- **Response Body**：`{"status":"ok","uptime":123.4}`

---

## 4. 纯内存零落盘与并发核心设计

### 4.1 零落盘流转机制

1. HTTP 请求接入，通过 `busboy` 纯流式解析 `multipart/form-data`。
2. 将文件数据块分片（chunks）汇聚在内存 `Buffer` 中，一旦累计字节超过 `MAX_FILE_SIZE_MB` 立即抛出超限并截断。
3. 将最终 `Buffer` 传给 `@squoosh/lib` 的 `ImagePool.ingestImage(buffer)`。
4. 压缩生成的二进制结果以 `Buffer` 形式直接写入 HTTP 响应。
5. **全程无任何文件创建、写入或删除操作**，完全由 Node.js V8 垃圾回收器自动回收内存，杜绝磁盘 IO 竞争及临时文件泄露。

### 4.2 智能嗅探（Magic Bytes 探测）

优先通过请求参数 `type` 或文件名字缀判断；若未提供或不准确，通过读取二进制缓冲区前 12 字节自动识别真实格式：

- `FF D8 FF` $\rightarrow$ JPEG
- `89 50 4E 47 0D 0A 1A 0A` $\rightarrow$ PNG
- `52 49 46 46 .... 57 45 42 50` $\rightarrow$ WebP
- `.... 66 74 79 70 61 76 69 66` $\rightarrow$ AVIF
- `47 49 46 38` $\rightarrow$ GIF（不支持有损压缩，进入直通逻辑）
- `42 4D` $\rightarrow$ BMP（进入直通逻辑）

### 4.3 并发与线程池管理

- 服务启动时创建单例 `ImagePool`，常驻内存：
  ```javascript
  const workerCount =
    parseInt(process.env.SQUOOSH_WORKERS, 10) || os.cpus().length;
  const imagePool = new ImagePool(workerCount);
  ```
- 多个客户端 HTTP 请求到达时，任务自动提交至线程池队列并发执行，充分利用宿主机多核 CPU。

---

## 5. 依赖与实现选型

- **运行环境**：Node.js 16.20.2-alpine。
- **核心编解码库**：复用全局安装的 `@squoosh/lib`（无需额外安装）。
- **流解析依赖**：在构建中安装轻量标准包 `busboy`。

---

## 6. 测试与验证方案

1. **功能测试**：
   - 使用 `curl -F "file=@example.png" -F "mode=auto" http://localhost:8081/api/compress` 验证 PNG 压缩。
   - 使用 `curl -F "file=@example.png" -F "mode=jpeg" http://localhost:8081/api/compress` 验证强制转码 JPEG。
   - 上传 `test.gif`，验证返回原文件与 `X-Compression-Status: bypassed`。
2. **容量与边界测试**：
   - 验证超过 50MB 触发 413 拦截。
   - 验证不带 file 字段触发 400。
3. **双端口并行测试**：
   - `curl http://localhost:8080/` 验证 Web 界面正常。
   - `curl http://localhost:8081/health` 验证 API 状态正常。
