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

启动 CLI 版 Web 服务，默认访问 `http://localhost:8081`：

```sh
docker compose --profile cli up -d squoosh-cli
```

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
