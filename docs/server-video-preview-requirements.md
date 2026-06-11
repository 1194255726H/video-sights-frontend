# 视频预览加载对接要求

前端现在采用和 SecShot 类似的视频预览流程：

1. 任务接口返回一个预览 MP4 地址。
2. 前端用 HTTP 字节范围请求分块下载该 MP4，每块 16 MiB。
3. 下载完成后在浏览器内组成本地 `Blob`，再生成 `blob:` 地址给可见的 `<video>` 播放。
4. 每秒预览图由浏览器自己生成：隐藏 `<video>` seek 到指定时间点，再用 `<canvas>` 抽帧生成 JPEG。
5. 标注界面一次展示 4 帧窗口。

## 任务接口字段

每个任务建议返回这些字段：

```json
{
  "id": 123,
  "oss_key": "example/task.mp4",
  "preview_url": "https://cdn.example.com/tasks/123/123.preview.mp4",
  "duration": 2114,
  "annotation_fps": 1
}
```

当前前端兼容的字段别名：

- 预览 MP4 地址：`preview_url`、`preview_mp4_url`、`previewUrl`、`preview`、`presigned_url`、`video_url`、`videoSource`
- 视频时长：`duration`、`duration_s`、`durationSeconds`
- 标注帧率：`annotation_fps`、`annotationFps`

建议后端优先使用 `preview_url` 和 `annotation_fps`。

## 预览 MP4 地址要求

预览 MP4 地址必须支持 HTTP Range 请求，例如：

```http
GET /tasks/123/123.preview.mp4
Range: bytes=0-16777215
```

期望响应：

```http
HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Accept-Ranges: bytes
Content-Range: bytes 0-16777215/78869411
Content-Length: 16777216
```

前端会连续请求这些分块：

```text
bytes=0-16777215
bytes=16777216-33554431
bytes=33554432-50331647
...
```

如果服务端暂时不支持 Range，返回普通 `200 OK` 的完整 MP4 也能作为兜底方案工作，但强烈建议支持 `206 Partial Content`，否则大视频加载体验会明显变差。

## CORS 跨域要求

如果 MP4 在另一个域名、CDN 或 OSS bucket 上，需要给前端域名开启 CORS。

必需响应头：

```http
Access-Control-Allow-Origin: https://your-frontend-domain.example
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: Range
Access-Control-Expose-Headers: Content-Range, Content-Length, Content-Type, Accept-Ranges
```

测试环境如果安全策略允许，也可以暂时使用：

```http
Access-Control-Allow-Origin: *
```

## OSS / CDN 注意事项

- 预览 MP4 必须是浏览器可解码、可 seek 的标准 MP4。
- 返回 `Content-Type: video/mp4`。
- CDN、网关、反向代理都要保留并正确处理 `Range` 请求。
- 不要对 MP4 响应做 gzip、压缩转换或内容改写。
- 可以开启缓存，例如 `Cache-Control: public, max-age=14400`。
- 如果使用签名 URL，过期时间要覆盖完整下载和抽帧流程。

## 服务端不需要做的事

服务端不需要额外提供每秒 JPEG/WebP 缩略图。

前端会用下面的方式从预览 MP4 里抽帧：

- 创建隐藏 `<video>`
- 设置 `video.currentTime = second / annotation_fps`
- 调用 `canvas.drawImage(video, ...)`
- 调用 `canvas.toBlob('image/jpeg', 0.92)`

