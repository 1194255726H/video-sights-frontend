import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import logoUrl from '../assets/logo.jpg'
import { ROLE_LABELS, projectApi } from '../mock/localData'

const FRAME_SECONDS = 4
const RANGE_CHUNK_SIZE = 16 * 1024 * 1024
const RANGE_RETRY_LIMIT = 3
const FULL_RESPONSE_RETRY_LIMIT = 1
const THUMBNAIL_QUALITY = 0.92
const SEEK_TIMEOUT_MS = 8000

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function formatClock(value) {
  if (!Number.isFinite(value)) return '00:00'
  const seconds = Math.max(0, Math.floor(value))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function parseContentRange(value) {
  if (!value) return null
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim())
  if (!match) return null

  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  if (total !== null && (!Number.isFinite(total) || total <= end)) return null
  return { start, end, total }
}

function getContentLength(response) {
  const raw = response.headers.get('content-length')
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

async function readResponseIntoParts(response, signal, onBytes) {
  const reader = response.body?.getReader()

  if (!reader) {
    const blob = await response.blob()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    onBytes(bytes)
    return bytes.byteLength
  }

  let bytesRead = 0
  try {
    while (!signal.aborted) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (done) break
      if (!value || value.byteLength === 0) continue
      const copy = new Uint8Array(value.byteLength)
      copy.set(value)
      bytesRead += copy.byteLength
      onBytes(copy)
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  } finally {
    reader.releaseLock()
  }

  return bytesRead
}

function isAbortError(error) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function shouldRetryAfterProgress(hasProgress, retryCount, limit) {
  return hasProgress && retryCount < limit
}

async function fetchVideoAsBlob(url, signal, onProgress) {
  const parts = []
  let loadedBytes = 0
  let totalBytes = null
  let contentType = 'video/mp4'
  let rangeRetries = 0

  const emitProgress = () => {
    const percent = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0
    onProgress({
      loadedBytes,
      totalBytes,
      percent: clamp(percent, 0, 100),
      text: 'Downloading video...',
    })
  }

  emitProgress()

  while (!signal.aborted) {
    const rangeEnd =
      totalBytes === null
        ? loadedBytes + RANGE_CHUNK_SIZE - 1
        : Math.min(totalBytes - 1, loadedBytes + RANGE_CHUNK_SIZE - 1)

    let response
    try {
      response = await fetch(url, {
        headers: { Range: `bytes=${loadedBytes}-${rangeEnd}` },
        mode: 'cors',
        signal,
      })
    } catch (error) {
      if (isAbortError(error) || !shouldRetryAfterProgress(loadedBytes > 0, rangeRetries, RANGE_RETRY_LIMIT)) {
        throw error
      }
      rangeRetries += 1
      emitProgress()
      continue
    }

    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'))
      if (range && range.start !== loadedBytes) {
        throw new Error(`Unexpected video range start ${range.start}`)
      }

      totalBytes = range?.total ?? totalBytes
      contentType = response.headers.get('content-type') ?? contentType

      const chunkStart = loadedBytes
      let bytesRead = 0
      try {
        bytesRead = await readResponseIntoParts(response, signal, (bytes) => {
          parts.push(bytes)
          loadedBytes += bytes.byteLength
          emitProgress()
        })
      } catch (error) {
        if (isAbortError(error) || !shouldRetryAfterProgress(loadedBytes > chunkStart, rangeRetries, RANGE_RETRY_LIMIT)) {
          throw error
        }
        rangeRetries += 1
        emitProgress()
        continue
      }

      if (totalBytes !== null && loadedBytes >= totalBytes) break
      if (totalBytes === null && bytesRead > 0 && bytesRead < RANGE_CHUNK_SIZE) break
      if (bytesRead === 0) throw new Error('Video range response contained no bytes')
      rangeRetries = 0
      continue
    }

    if (response.status === 416 && loadedBytes > 0) {
      break
    }

    if (response.ok) {
      parts.length = 0
      loadedBytes = 0
      totalBytes = getContentLength(response)
      contentType = response.headers.get('content-type') ?? contentType

      let fullRetries = 0
      for (;;) {
        try {
          await readResponseIntoParts(response, signal, (bytes) => {
            parts.push(bytes)
            loadedBytes += bytes.byteLength
            emitProgress()
          })
          break
        } catch (error) {
          if (isAbortError(error) || !shouldRetryAfterProgress(loadedBytes > 0, fullRetries, FULL_RESPONSE_RETRY_LIMIT)) {
            throw error
          }
          fullRetries += 1
          parts.length = 0
          loadedBytes = 0
          response = await fetch(url, { mode: 'cors', signal })
          if (!response.ok) throw new Error(`Video request failed with HTTP ${response.status}`)
        }
      }
      break
    }

    throw new Error(`Video request failed with HTTP ${response.status}`)
  }

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  onProgress({
    loadedBytes,
    totalBytes: totalBytes ?? loadedBytes,
    percent: 100,
    text: 'Video ready',
  })

  return new Blob(parts, { type: contentType })
}

function waitForVideoSeek(video, time) {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.02 && video.readyState >= 2) {
      resolve()
      return
    }

    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while seeking thumbnail video'))
    }, SEEK_TIMEOUT_MS)

    const cleanup = () => {
      window.clearTimeout(timeoutId)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
    }

    const handleSeeked = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(new Error('Thumbnail video seek failed'))
    }

    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('error', handleError)
    video.currentTime = time
  })
}

function canvasToJpegUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to capture thumbnail'))
          return
        }
        resolve(URL.createObjectURL(blob))
      },
      'image/jpeg',
      THUMBNAIL_QUALITY
    )
  })
}

function LabelPage({ mode, onBack, onSignOut, project, user }) {
  const videoRef = useRef(null)
  const thumbnailVideoRef = useRef(null)
  const thumbnailCanvasRef = useRef(null)
  const thumbnailUrlsRef = useRef(new Map())
  const pendingThumbnailsRef = useRef(new Set())
  const thumbnailQueueRef = useRef([])
  const thumbnailProcessingRef = useRef(false)

  const [videoUrl, setVideoUrl] = useState('')
  const [downloadState, setDownloadState] = useState({
    status: 'loading',
    loadedBytes: 0,
    totalBytes: null,
    percent: 0,
    text: 'Downloading video...',
  })
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [windowStart, setWindowStart] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const [unqualifiedSeconds, setUnqualifiedSeconds] = useState(() => new Set())
  const [visitedSeconds, setVisitedSeconds] = useState(() => new Set())
  const [thumbnails, setThumbnails] = useState({})
  const [thumbnailReady, setThumbnailReady] = useState(false)
  const [submitState, setSubmitState] = useState({
    status: 'idle',
    message: '',
  })
  const annotationFps = useMemo(() => {
    const value = Number(project.annotationFps ?? project.activeTask?.annotation_fps ?? 1)
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1
  }, [project.activeTask?.annotation_fps, project.annotationFps])
  const totalSeconds = useMemo(() => {
    if (!Number.isFinite(duration) || duration <= 0) return 0
    return Math.max(1, Math.ceil(duration * annotationFps))
  }, [annotationFps, duration])

  const maxWindowStart = Math.max(0, totalSeconds - 1)
  const windowStartFrame = totalSeconds > 0 ? clamp(windowStart, 0, maxWindowStart) : 0
  const windowStartSecond = windowStartFrame / annotationFps
  const playbackLoopStartFrame = totalSeconds > 0 ? Math.max(0, windowStartFrame - 1) : 0
  const playbackLoopStart = playbackLoopStartFrame / annotationFps
  const playbackLoopEnd =
    totalSeconds > 0
      ? Math.min(
          Math.max(playbackLoopStart + 0.25, (windowStartFrame + FRAME_SECONDS) / annotationFps),
          duration || (windowStartFrame + FRAME_SECONDS) / annotationFps
        )
      : FRAME_SECONDS

  const visibleSeconds = useMemo(() => {
    if (totalSeconds === 0) return []
    return Array.from({ length: FRAME_SECONDS }, (_, index) => windowStart + index).filter(
      (second) => second >= 0 && second < totalSeconds
    )
  }, [totalSeconds, windowStart])

  const activeSecond =
    totalSeconds > 0 ? clamp(Math.floor(currentTime * annotationFps), 0, Math.max(0, totalSeconds - 1)) : 0

  const frameIndex = totalSeconds > 0 ? Math.floor(windowStart / FRAME_SECONDS) + 1 : 0
  const frameCount = totalSeconds > 0 ? Math.ceil(totalSeconds / FRAME_SECONDS) : 0
  const qualifiedCount = Math.max(0, totalSeconds - unqualifiedSeconds.size)
  const visitedPercent = totalSeconds
    ? Math.round((visitedSeconds.size / Math.max(totalSeconds, 1)) * 100)
    : 0

  const clearThumbnails = useCallback(() => {
    thumbnailUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    thumbnailUrlsRef.current.clear()
    pendingThumbnailsRef.current.clear()
    thumbnailQueueRef.current = []
    setThumbnails({})
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''

    clearThumbnails()
    setVideoUrl('')
    setDuration(0)
    setCurrentTime(0)
    setWindowStart(0)
    setDownloadState({
      status: 'loading',
      loadedBytes: 0,
      totalBytes: null,
      percent: 0,
      text: 'Downloading video...',
    })

    if (!project.videoSource) {
      setDownloadState({
        status: 'error',
        loadedBytes: 0,
        totalBytes: null,
        percent: 0,
        text: 'Video source is missing',
      })
      return () => {
        controller.abort()
      }
    }

    fetchVideoAsBlob(project.videoSource, controller.signal, (progress) => {
      setDownloadState((previous) => ({
        ...previous,
        ...progress,
        status: progress.percent >= 100 ? 'ready' : 'loading',
      }))
    })
      .then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setVideoUrl(objectUrl)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setDownloadState((previous) => ({
          ...previous,
          status: 'error',
          text: error instanceof Error ? error.message : 'Video download failed',
        }))
      })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [clearThumbnails, project.videoSource])

  useEffect(() => {
    if (!videoUrl) return undefined

    clearThumbnails()
    setThumbnailReady(false)

    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.src = videoUrl
    thumbnailVideoRef.current = video

    const handleLoaded = () => setThumbnailReady(true)
    video.addEventListener('loadedmetadata', handleLoaded)
    video.load()

    return () => {
      video.removeEventListener('loadedmetadata', handleLoaded)
      if (thumbnailVideoRef.current === video) thumbnailVideoRef.current = null
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
      } catch {
        // The browser can throw while tearing down a media element.
      }
      setThumbnailReady(false)
    }
  }, [clearThumbnails, videoUrl])

  useEffect(() => {
    if (totalSeconds === 0) return
    setWindowStart((current) => clamp(current, 0, Math.max(0, totalSeconds - 1)))
    setUnqualifiedSeconds((current) => {
      const next = new Set([...current].filter((second) => second < totalSeconds))
      return next.size === current.size ? current : next
    })
    setVisitedSeconds((current) => {
      const next = new Set([...current].filter((second) => second < totalSeconds))
      return next.size === current.size ? current : next
    })
  }, [totalSeconds])

  useEffect(() => {
    if (visibleSeconds.length === 0) return
    setVisitedSeconds((current) => {
      const next = new Set(current)
      visibleSeconds.forEach((second) => next.add(second))
      return next.size === current.size ? current : next
    })
  }, [visibleSeconds])

  const captureThumbnail = useCallback(async (second) => {
    const video = thumbnailVideoRef.current
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return

    const canvas = thumbnailCanvasRef.current ?? document.createElement('canvas')
    thumbnailCanvasRef.current = canvas
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 360

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const targetTime = clamp(second / annotationFps, 0, Math.max(0, video.duration - 0.001))
    await waitForVideoSeek(video, targetTime)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const url = await canvasToJpegUrl(canvas)
    const existingUrl = thumbnailUrlsRef.current.get(second)
    if (existingUrl) URL.revokeObjectURL(existingUrl)
    thumbnailUrlsRef.current.set(second, url)
    setThumbnails(Object.fromEntries(thumbnailUrlsRef.current))
  }, [annotationFps])

  const processThumbnailQueue = useCallback(async () => {
    if (thumbnailProcessingRef.current) return
    thumbnailProcessingRef.current = true

    try {
      while (thumbnailQueueRef.current.length > 0) {
        const second = thumbnailQueueRef.current.shift()
        pendingThumbnailsRef.current.delete(second)
        if (thumbnailUrlsRef.current.has(second)) continue
        try {
          await captureThumbnail(second)
        } catch {
          // A failed seek should not block nearby frames from being prepared.
        }
      }
    } finally {
      thumbnailProcessingRef.current = false
      if (thumbnailQueueRef.current.length > 0) {
        void processThumbnailQueue()
      }
    }
  }, [captureThumbnail])

  const enqueueThumbnails = useCallback(
    (seconds, priority = false) => {
      if (!thumbnailReady || totalSeconds === 0) return

      const freshSeconds = []
      seconds.forEach((rawSecond) => {
        const second = Math.floor(rawSecond)
        if (second < 0 || second >= totalSeconds) return
        if (thumbnailUrlsRef.current.has(second)) return
        if (pendingThumbnailsRef.current.has(second)) return
        pendingThumbnailsRef.current.add(second)
        freshSeconds.push(second)
      })

      if (freshSeconds.length === 0) return
      if (priority) {
        thumbnailQueueRef.current.unshift(...freshSeconds.reverse())
      } else {
        thumbnailQueueRef.current.push(...freshSeconds)
      }
      void processThumbnailQueue()
    },
    [processThumbnailQueue, thumbnailReady, totalSeconds]
  )

  useEffect(() => {
    if (!thumbnailReady || totalSeconds === 0) return

    const windowSeconds = [
      windowStart - 1,
      ...visibleSeconds,
      windowStart + FRAME_SECONDS,
      windowStart + FRAME_SECONDS + 1,
      windowStart + FRAME_SECONDS + 2,
      windowStart + FRAME_SECONDS + 3,
    ]

    enqueueThumbnails(windowSeconds, true)
  }, [enqueueThumbnails, thumbnailReady, totalSeconds, visibleSeconds, windowStart])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoUrl || totalSeconds === 0) return

    const stayPaused = video.paused
    video.currentTime = playbackLoopStart
    setCurrentTime(playbackLoopStart)
    if (!stayPaused) {
      setIsPlaying(true)
      void video.play().catch(() => setIsPlaying(false))
    }
  }, [playbackLoopStart, totalSeconds, videoUrl])

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    const nextDuration = video.duration
    if (Number.isFinite(nextDuration)) {
      setDuration(nextDuration)
    }
    video.currentTime = playbackLoopStart
    void video.play().catch(() => setIsPlaying(false))
  }, [playbackLoopStart])

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    setCurrentTime(video.currentTime)
    setIsPlaying(!video.paused)

    if (video.currentTime >= playbackLoopEnd - 0.03 || video.currentTime < playbackLoopStart) {
      video.currentTime = playbackLoopStart
      setCurrentTime(playbackLoopStart)
      if (!video.paused) {
        void video.play().catch(() => setIsPlaying(false))
      }
    }
  }, [playbackLoopEnd, playbackLoopStart])

  const seekWindowBy = useCallback(
    (delta) => {
      if (totalSeconds === 0) return
      setWindowStart((current) => clamp(current + delta, 0, Math.max(0, totalSeconds - 1)))
    },
    [totalSeconds]
  )

  const seekToSecond = useCallback(
    (second) => {
      if (totalSeconds === 0) return
      const target = clamp(second, 0, Math.max(0, totalSeconds - 1))
      const video = videoRef.current
      const targetTime = target / annotationFps
      setWindowStart(target)
      setCurrentTime(targetTime)
      if (video) {
        video.currentTime = targetTime
        if (video.paused) {
          setIsPlaying(true)
          void video.play().catch(() => setIsPlaying(false))
        }
      }
    },
    [annotationFps, totalSeconds]
  )

  const toggleQuality = useCallback((second) => {
    setUnqualifiedSeconds((current) => {
      const next = new Set(current)
      if (next.has(second)) {
        next.delete(second)
      } else {
        next.add(second)
      }
      return next
    })
    setVisitedSeconds((current) => {
      const next = new Set(current)
      next.add(second)
      return next
    })
  }, [])

  const togglePlayback = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    if (video.paused) {
      setIsPlaying(true)
      void video.play().catch(() => setIsPlaying(false))
    } else {
      video.pause()
      setIsPlaying(false)
    }
  }, [])

  const handleSubmit = useCallback(async () => {
    const payload = {
      projectId: project.id,
      taskId: project.activeTask?.id ?? project.id,
      ossKey: project.activeTask?.oss_key,
      operator: user.email,
      role: user.role,
      unqualifiedSeconds: [...unqualifiedSeconds].sort((a, b) => a - b),
      visitedSeconds: [...visitedSeconds].sort((a, b) => a - b),
      duration,
      annotationFps,
      submittedAt: new Date().toISOString(),
    }

    setSubmitState({
      status: 'submitting',
      message: mode === 'review' ? '正在提交审核结果...' : '正在提交标注结果...',
    })

    try {
      if (project.activeTask?.id && mode === 'review') {
        await projectApi.submitReview(project.activeTask.id, {
          audit_passed: unqualifiedSeconds.size === 0,
          audit_data: {
            score: unqualifiedSeconds.size === 0 ? 95 : 60,
            note: unqualifiedSeconds.size === 0 ? '审核通过' : '存在不合格帧',
            audited_by: user.email,
            details: payload,
          },
        })
      } else if (project.activeTask?.id) {
        await projectApi.submitAnnotation(project.activeTask.id, payload)
      } else if (mode === 'review') {
        await projectApi.submitReview(null, payload)
      } else {
        await projectApi.submitAnnotation(null, payload)
      }
      setSubmitState({
        status: 'success',
        message: mode === 'review' ? '审核结果已提交' : '标注结果已提交',
      })
    } catch (error) {
      setSubmitState({
        status: 'error',
        message: error instanceof Error ? error.message : '提交失败',
      })
    }
  }, [annotationFps, duration, mode, project.activeTask, project.id, unqualifiedSeconds, user.email, user.role, visitedSeconds])

  const handleTimelineClick = useCallback(
    (event) => {
      if (totalSeconds === 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1)
      const target = Math.floor(ratio * Math.max(1, totalSeconds - 1))
      seekToSecond(target)
    },
    [seekToSecond, totalSeconds]
  )

  useEffect(() => {
    const handleKeyDown = (event) => {
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(active.tagName)
      ) {
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        seekWindowBy(-1)
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        seekWindowBy(1)
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        seekWindowBy(-FRAME_SECONDS)
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        seekWindowBy(FRAME_SECONDS)
      }
      if (event.key === ' ') {
        event.preventDefault()
        togglePlayback()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [seekWindowBy, togglePlayback])

  useEffect(() => {
    return () => {
      clearThumbnails()
    }
  }, [clearThumbnails])

  const renderThumbnail = (second, variant = 'main') => {
    const imageUrl = thumbnails[second]
    const isUnqualified = unqualifiedSeconds.has(second)
    const isActive = second === activeSecond

    return (
      <article
        className={`thumb-card ${variant} ${isActive ? 'active' : ''} ${
          isUnqualified ? 'bad' : 'good'
        }`}
        key={`${variant}-${second}`}
      >
        <button
          aria-label={`Jump to ${second}s`}
          className="thumb-media"
          onClick={() => seekToSecond(second)}
          type="button"
        >
          {imageUrl ? (
            <img alt={`${second}`} src={imageUrl} />
          ) : (
            <span className="thumb-placeholder" />
          )}
          <span className="thumb-check">{isUnqualified ? 'x' : 'v'}</span>
        </button>
        <span className="thumb-footer">
          <span>{second}s</span>
          {variant === 'main' ? (
            <button
              className="quality-pill"
              onClick={() => toggleQuality(second)}
              type="button"
            >
              {isUnqualified ? 'Unqualified' : 'Qualified'}
            </button>
          ) : null}
        </span>
      </article>
    )
  }

  const previousPreviewSecond = windowStart > 0 ? windowStart - 1 : null
  const nextPreviewSecond = windowStart + FRAME_SECONDS < totalSeconds ? windowStart + FRAME_SECONDS : null
  const timelineFrames = useMemo(
    () => Array.from({ length: totalSeconds }, (_, second) => second),
    [totalSeconds]
  )

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" alt="videoSight" src={logoUrl} />
          <span className="brand-name">videoSight</span>
          <span className="brand-tag">local</span>
        </div>
        <div className="top-actions">
          <button className="ghost-button" onClick={onBack} type="button">
            返回列表
          </button>
          <span>{user.name}</span>
          <span>{ROLE_LABELS[user.role]}</span>
          <span>{mode === 'review' ? '审核' : '标注'}</span>
          <span>{project.name}</span>
          <span>
            {formatClock(currentTime)} / {formatClock(duration)}
          </span>
          <button className="sign-out-button" onClick={onSignOut} type="button">
            Sign out
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="video-stage">
          <div className="video-frame">
            {videoUrl ? (
              <video
                autoPlay
                className="main-video"
                muted
                onClick={togglePlayback}
                onLoadedMetadata={handleLoadedMetadata}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                onTimeUpdate={handleTimeUpdate}
                playsInline
                ref={videoRef}
                src={videoUrl}
              />
            ) : (
              <div className="loading-panel">
                <span>{downloadState.text}</span>
                <strong>{downloadState.percent}%</strong>
              </div>
            )}
            <div className="video-watermark">
              <span>
                Loop: {Math.floor(playbackLoopStart)}s - {Math.ceil(playbackLoopEnd)}s
              </span>
              <strong>{currentTime.toFixed(2)}s</strong>
            </div>
          </div>
        </section>

        <section className="status-strip">
          <span>Window {Math.floor(windowStartSecond)}-{Math.ceil((windowStartFrame + FRAME_SECONDS) / annotationFps)}s</span>
          <span>
            Frame {frameIndex}/{frameCount}
          </span>
          <span>
            Visited {visitedSeconds.size}/{totalSeconds || 0} ({visitedPercent}%)
          </span>
          <span>Qualified {qualifiedCount}</span>
          <span>Unqualified {unqualifiedSeconds.size}</span>
        </section>

        <section className="thumbnail-row">
          <div className="side-preview">
            {previousPreviewSecond === null ? <div className="side-empty" /> : renderThumbnail(previousPreviewSecond, 'side')}
          </div>
          <div className="main-thumbs">{visibleSeconds.map((second) => renderThumbnail(second))}</div>
          <div className="side-preview">
            {nextPreviewSecond === null ? <div className="side-empty" /> : renderThumbnail(nextPreviewSecond, 'side')}
          </div>
        </section>
      </main>

      <footer className="control-dock">
        <div className="control-groups">
          <button aria-label="Play or pause" className="icon-button primary" onClick={togglePlayback} title="Play or pause" type="button">
            {isPlaying ? '||' : '>'}
          </button>
          <span className="control-divider" />
          <button aria-label="Previous second" className="icon-button" onClick={() => seekWindowBy(-1)} title="Previous second" type="button">
            {'<'}
          </button>
          <button aria-label="Next second" className="icon-button" onClick={() => seekWindowBy(1)} title="Next second" type="button">
            {'>'}
          </button>
          <span className="control-divider" />
          <button aria-label="Previous 4-second frame" className="icon-button" onClick={() => seekWindowBy(-FRAME_SECONDS)} title="Previous 4-second frame" type="button">
            {'|<'}
          </button>
          <button aria-label="Next 4-second frame" className="icon-button" onClick={() => seekWindowBy(FRAME_SECONDS)} title="Next 4-second frame" type="button">
            {'>|'}
          </button>
        </div>

        <button
          className="timeline"
          onClick={handleTimelineClick}
          style={{ '--frame-count': Math.max(timelineFrames.length, 1) }}
          type="button"
        >
          <span className="timeline-annotation-layer" aria-hidden="true">
            {timelineFrames.map((second) => (
              <span
                className={`timeline-annotation ${visitedSeconds.has(second) ? 'visited' : ''}`}
                key={`annotation-${second}`}
              />
            ))}
          </span>
          <span className="timeline-frame-layer" aria-hidden="true">
            {timelineFrames.map((second) => (
              <span
                className={`timeline-frame ${unqualifiedSeconds.has(second) ? 'unqualified' : 'qualified'} ${
                  visibleSeconds.includes(second) ? 'selected' : ''
                }`}
                key={`frame-${second}`}
              />
            ))}
          </span>
          <span className="timeline-active-window-layer" aria-hidden="true">
            {timelineFrames.map((second) => (
              <span
                className={`timeline-active-window ${visibleSeconds.includes(second) ? 'current' : ''}`}
                key={`active-window-${second}`}
              />
            ))}
          </span>
          <span className="timeline-buffer" style={{ width: `${downloadState.percent}%` }} />
        </button>

        <div className="dock-status">
          <span>{submitState.message || downloadState.text}</span>
          <strong>{downloadState.percent}%</strong>
        </div>
        <button
          className="submit-button"
          disabled={submitState.status === 'submitting'}
          onClick={handleSubmit}
          type="button"
        >
          {submitState.status === 'submitting'
            ? '提交中'
            : mode === 'review'
              ? '提交审核'
              : '提交标注'}
        </button>
      </footer>
    </div>
  )
}

export default LabelPage
