# [Squoosh]!

[Squoosh] is an image compression web app that reduces image sizes through numerous formats.

# Privacy

Squoosh does not send your image to a server. All image compression processes locally.

However, Squoosh utilizes Google Analytics to collect the following:

- [Basic visitor data](https://support.google.com/analytics/answer/6004245?ref_topic=2919631).
- The before and after image size value.
- If Squoosh PWA, the type of Squoosh installation.
- If Squoosh PWA, the installation time and date.

# Developing

To develop for Squoosh:

1. Clone the repository
1. To install node packages, run:
   ```sh
   npm install
   ```
1. Then build the app by running:
   ```sh
   npm run build
   ```
1. After building, start the development server by running:
   ```sh
   npm run dev
   ```

# Contributing

Squoosh is an open-source project that appreciates all community involvement. To contribute to the project, follow the [contribute guide](/CONTRIBUTING.md).

# Docker 部署

构建并启动服务：

```sh
docker compose up -d --build
```

默认通过 `http://localhost:8080` 访问。如需修改宿主机端口，可设置 `SQUOOSH_PORT`：

```sh
SQUOOSH_PORT=3000 docker compose up -d --build
```

也可以仅构建镜像并直接运行：

```sh
docker build -t squoosh-new:latest .
docker run -d --name squoosh-new -p 8080:8080 --restart unless-stopped squoosh-new:latest
```

停止 Compose 服务：

```sh
docker compose down
```

## Squoosh CLI 镜像

当前源码不包含 CLI 构建入口。上游已停止维护并删除 CLI，因此 CLI 版镜像固定安装最后发布的 `@squoosh/cli@0.7.3`，并使用其支持的 Node.js 16 运行。该镜像默认仍会启动 Web 服务，同时可以在容器中执行 CLI。

构建 CLI 镜像：

```sh
docker compose build squoosh-cli
```

启动 CLI 版服务（同时暴露 8082 Web 服务与 8081 HTTP 压缩 API）：

```sh
docker compose --profile cli up -d squoosh-cli
```

### HTTP 图片压缩服务 (端口 8081)

该镜像内置了纯内存、零落盘、支持并发调度的 HTTP 压缩服务（监听 `8081` 端口）。

- **接口地址**：`POST http://localhost:8081/api/compress`（或 `/compress`）
- **请求类型**：`multipart/form-data`
- **支持参数**：
  - `file`（必填）：待压缩图片文件流
  - `mode`（可选）：`auto`（默认，按原格式压缩）或 `jpeg`（强制转为 MozJPEG 压缩）
  - `type`（可选）：显式指定输入格式（如 `png`, `jpg`, `webp`）
  - `quality`（可选）：画质（1~100），默认 75
- **特性**：
  - **纯内存零落盘**：文件流直接在内存中编解码，不产生任何磁盘文件，处理完由 GC 自动释放；
  - **智能识别与直通**：对 GIF、BMP、SVG 等不支持的格式或解析异常自动原样直出（带有 `X-Compression-Status: bypassed` 响应头）；
  - **默认限制**：单图上限 50MB（可通过环境变量 `MAX_FILE_SIZE_MB` 配置）。

#### 调用示例

1. 智能分流压缩 PNG（输出仍为 PNG）：

```sh
curl -F "file=@input.png" -F "mode=auto" http://localhost:8081/api/compress -o output.png
```

2. 将任意图片转为 JPEG 格式并压缩：

```sh
curl -F "file=@input.png" -F "mode=jpeg" -F "quality=80" http://localhost:8081/api/compress -o output.jpg
```

3. 查看健康检查与状态：

```sh
curl http://localhost:8081/health
```

### 命令行工具使用

查看容器内 CLI 帮助：

```sh
docker compose exec squoosh-cli squoosh-cli --help
```

将当前目录的 `input.png` 压缩为 MozJPEG，输出文件会写入当前目录：

```sh
docker compose exec squoosh-cli squoosh-cli --mozjpeg '{"quality":75}' input.png
```

镜像还内置了快捷压缩命令：

- `squoosh-auto`：按原格式智能分流压缩（JPG 走 MozJPEG、PNG 走 OxiPNG、WebP 走 WebP 等），遇到不支持或异常格式直接将原文件复制输出，输出到 `output` 目录并添加 `-compressed` 后缀。
- `squoosh-mozjpeg`：将输入的所有图片统一转为 MozJPEG（`.jpg`）格式输出。

使用 `squoosh-auto` 智能分流压缩：

```sh
docker compose exec squoosh-cli squoosh-auto input.png photo.jpg banner.webp icon.gif
```

使用 `squoosh-mozjpeg` 批量转换为 MozJPEG：

```sh
docker compose exec squoosh-cli squoosh-mozjpeg input.png photo.jpg
```

批量转换当前目录中的 PNG 文件：

```sh
docker compose exec squoosh-cli sh -c 'squoosh-mozjpeg *.png'
```

转换结果示例：`input.png` 会生成 `output/input-compressed.jpg`；若使用 `squoosh-auto` 则生成 `output/input-compressed.png`。

也可以不使用 Compose：

```sh
docker build -f Dockerfile.cli -t squoosh-new:cli .
docker run -d --name squoosh-new-cli -p 8081:8080 -v "$PWD:/work" squoosh-new:cli
docker exec -w /work squoosh-new-cli squoosh-auto input.png photo.jpg
```

[squoosh]: https://squoosh.app
