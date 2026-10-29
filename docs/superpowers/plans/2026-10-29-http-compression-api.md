# HTTP 图片压缩服务实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有的 Squoosh CLI 容器环境中新增一套监听 8081 端口的独立 HTTP 图片压缩微服务，支持并发、纯内存零落盘处理、智能格式分流与不支持格式优雅降级。

**Architecture:** 基于 Node.js 原生 `http` 模块搭配 `busboy` 进行 `multipart/form-data` 流式解析，使用常驻单例 `@squoosh/lib` `ImagePool` 多线程线程池并发处理图片编解码；通过容器统一入口脚本 `docker/entrypoint.sh` 同时托管 8080（Web 界面）与 8081（API 服务），实现多进程信号转发与资源优雅释放。

**Tech Stack:** Node.js (v16.20.2), `@squoosh/lib`, `busboy`, Docker, Shell (POSIX sh)

**Spec:** `docs/superpowers/specs/2026-10-29-http-compression-api-design.md`

## Global Constraints

- 运行环境为容器内的 Node.js 16.20.2-alpine。
- HTTP API 服务端口固定为 8081（支持通过环境变量 `PORT` 覆盖）。
- 单图最大上传限制默认 50MB（支持通过环境变量 `MAX_FILE_SIZE_MB` 覆盖）。
- 全程纯内存 Buffer 操作，禁止在磁盘生成任何临时文件。
- 不支持格式（如 GIF、BMP、SVG 等）或编解码失败时必须原样直出（HTTP 200，并带上 `X-Compression-Status: bypassed` 响应头）。
- 严格遵循项目的 Git 规则：禁止自动提交，必须由用户发出明确指令后再提交。

## Review Focus

1. **不支持格式直通（GIF / 纯文本 / 二进制垃圾数据）**：期望返回 `200 OK`，`X-Compression-Status: bypassed`，Body 与上传数据完全一致。
2. **超限文件阻断（> 50MB）**：期望在数据接收过程中截断流，直接返回 `413 Payload Too Large`。
3. **缺少文件字段**：表单中未携带 `file` 字段时，期望返回 `400 Bad Request` 并输出 JSON 格式错误说明。
4. **并发处理与线程安全**：多个并发请求同时调用时，`ImagePool` 正确调度多核 Worker 线程，不出现崩溃或跨请求串扰。
5. **容器优雅停机**：向容器发送 `SIGTERM` / `SIGINT` 时，`entrypoint.sh` 需正确终止 8080 和 8081 进程并释放端口。

---

### Task 1: 核心图片识别与内存压缩模块 (`server/compressor.js`)

**Files:**

- Create: `server/compressor.js`
- Test: `test/compressor.test.js`

**Interfaces:**

- Produces:

  - `detectImageFormat(buffer: Buffer): { ext: string, mime: string, supported: boolean }`
  - `compressImage(imagePool: ImagePool, buffer: Buffer, options: { mode: string, type?: string, quality?: number }): Promise<{ data: Buffer, ext: string, mime: string, bypassed: boolean }>`

- [ ] **Step 1: 编写测试用例 `test/compressor.test.js`**

覆盖以下场景：

- 通过 Magic Bytes 识别 JPEG、PNG、WebP、AVIF 及不支持的 GIF/TXT；
- `mode=auto` 下对 WebP / PNG 图片进行内存压缩，输出 Buffer 大小正常；
- `mode=jpeg` 下将 WebP 强制压缩转码为 JPEG 输出；
- 传入 GIF 时自动触发 `bypassed: true` 并返回原 Buffer；
- 传入损坏图片时优雅捕获并返回原 Buffer (`bypassed: true`)。

- [ ] **Step 2: 运行测试验证失败**

运行: `node test/compressor.test.js`
预期: FAIL (找不到模块 `../server/compressor.js`)

- [ ] **Step 3: 编写 `server/compressor.js` 实现**

实现 Magic Bytes 二进制探测与 `@squoosh/lib` 内存压缩调度逻辑。

- [ ] **Step 4: 运行测试验证通过**

运行: `node test/compressor.test.js`
预期: PASS (所有断言均成功通过)

---

### Task 2: HTTP API 服务端实现 (`server/api-server.js`)

**Files:**

- Create: `server/api-server.js`
- Test: `test/api-server.test.js`

**Interfaces:**

- Consumes:
  - `compressImage` 来自 `server/compressor.js`
- Produces:

  - `createServer(options?: object): http.Server`
  - 导出 `startServer()` 与健康检查、文件接收、HTTP 响应逻辑

- [ ] **Step 1: 编写 API 接口测试用例 `test/api-server.test.js`**

测试项：

- `GET /health` 返回 200 及 `{"status":"ok"}`；
- `POST /api/compress` 缺少 file 时返回 400；
- `POST /api/compress` 超过限制体积时返回 413；
- `POST /api/compress` 上传 PNG 并使用 `mode=auto`，验证 Response Header（`X-Compression-Status: success`、`Content-Type: image/png`）及 Body 二进制；
- `POST /api/compress` 上传 PNG 并使用 `mode=jpeg`，验证 Response Header（`X-Compression-Status: success`、`Content-Type: image/jpeg`）；
- `POST /api/compress` 上传 GIF，验证直出 Response Header（`X-Compression-Status: bypassed`）及原图 Body。

- [ ] **Step 2: 运行测试验证失败**

运行: `node test/api-server.test.js`
预期: FAIL (找不到 `server/api-server.js`)

- [ ] **Step 3: 编写 `server/api-server.js`**

- 使用 Node 原生 `http.createServer`；
- 使用 `busboy` 解析 `multipart/form-data`；
- 限制流大小为 `MAX_FILE_SIZE_MB`（默认 50MB）；
- 集成 `server/compressor.js` 完成内存编解码与头信息输出；
- 监听 `SIGINT` / `SIGTERM`，关闭 `ImagePool` 并退出。

- [ ] **Step 4: 运行测试验证通过**

运行: `node test/api-server.test.js`
预期: PASS

---

### Task 3: 容器统一启动入口脚本 (`docker/entrypoint.sh`)

**Files:**

- Create: `docker/entrypoint.sh`

**Interfaces:**

- 后台启动 `serve` (端口 8080)
- 前台/主守护启动 `node /app/server/api-server.js` (端口 8081)
- 处理系统退出信号 `SIGTERM`/`SIGINT`，向两进程发送终止信号并等待退出

- [ ] **Step 1: 创建可执行脚本 `docker/entrypoint.sh`**

设置 `chmod 755`，支持同时拉起 8080 静态服务与 8081 API 服务，注册 `trap` 捕获信号。

- [ ] **Step 2: 本地模拟信号捕获验证**

在容器内模拟运行 entrypoint 脚本，确认能够同时启动 8080 和 8081，并正确响应 kill 退出信号。

---

### Task 4: Docker 配置与构建集成 (`Dockerfile.cli`, `docker-compose.yml`)

**Files:**

- Modify: `Dockerfile.cli`
- Modify: `docker-compose.yml`
- Modify: `README.md`

- [ ] **Step 1: 更新 `Dockerfile.cli`**

- 安装 `busboy`（与全局模块统一管理或安装在 `/app`）；
- 将 `server` 目录复制到容器 `/app/server`；
- 复制 `docker/entrypoint.sh` 到 `/usr/local/bin/docker-entrypoint.sh` 并设置执行权限；
- 声明 `EXPOSE 8080 8081`；
- 将 `CMD` 更改为 `["docker-entrypoint.sh"]`。

- [ ] **Step 2: 更新 `docker-compose.yml`**

配置 `squoosh-cli` 服务的端口映射：

```yaml
ports:
  - '${SQUOOSH_CLI_WEB_PORT:-8080}:8080'
  - '${SQUOOSH_CLI_API_PORT:-8081}:8081'
```

- [ ] **Step 3: 更新 `README.md` 文档**

在说明文档中详细介绍 8081 HTTP API 的调用方式、支持的参数（`file`, `mode`, `type`, `quality`）及 `curl` 调用示例。

---

### Task 5: 容器端到端集成测试与验证

- [ ] **Step 1: 构建并启动包含新功能的 CLI 镜像容器**
- [ ] **Step 2: 验证 8080 Web 端口正常访问**
- [ ] **Step 3: 使用 `curl` 针对 8081 执行全量场景测试**：
  - 测试 `/health` 健康检查接口
  - 测试 PNG 智能分流压缩
  - 测试 转码 JPEG 压缩
  - 测试 GIF 直通绕过
  - 测试 400 缺少参数拦截
  - 测试 413 大文件拦截
- [ ] **Step 4: 确认所有功能与设计指标一致**
