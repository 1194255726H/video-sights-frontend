import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const VIDEO_SOURCE = '/eb000ef6c85d95aae6a9bd4eaddc6905.mp4'
const EPISODE_ID = 'eb000ef6c85d95aae6a9bd4eaddc6905'
const FRAME_SECONDS = 4
const RANGE_CHUNK_SIZE = 16 * 1024 * 1024
const THUMBNAIL_QUALITY = 0.86
const LOGIN_PATH = '/login'
const LABEL_PATH = '/label'

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

async function fetchVideoAsBlob(url, signal, onProgress) {
  const parts = []
  let loadedBytes = 0
  let totalBytes = null
  let contentType = 'video/mp4'

  const emitProgress = () => {
    const percent = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0
    onProgress({
      loadedBytes,
      totalBytes,
      percent: clamp(percent, 0, 100),
      text: totalBytes ? 'Downloading video' : 'Preparing video download',
    })
  }

  emitProgress()

  while (!signal.aborted) {
    const rangeEnd =
      totalBytes === null
        ? loadedBytes + RANGE_CHUNK_SIZE - 1
        : Math.min(totalBytes - 1, loadedBytes + RANGE_CHUNK_SIZE - 1)

    const response = await fetch(url, {
      headers: { Range: `bytes=${loadedBytes}-${rangeEnd}` },
      mode: 'cors',
      signal,
    })

    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'))
      if (range && range.start !== loadedBytes) {
        throw new Error(`Unexpected video range start ${range.start}`)
      }

      totalBytes = range?.total ?? totalBytes
      contentType = response.headers.get('content-type') ?? contentType

      const bytesRead = await readResponseIntoParts(response, signal, (bytes) => {
        parts.push(bytes)
        loadedBytes += bytes.byteLength
        emitProgress()
      })

      if (totalBytes !== null && loadedBytes >= totalBytes) break
      if (totalBytes === null && bytesRead > 0 && bytesRead < RANGE_CHUNK_SIZE) break
      if (bytesRead === 0) throw new Error('Video range response contained no bytes')
      continue
    }

    if (response.ok) {
      parts.length = 0
      loadedBytes = 0
      totalBytes = getContentLength(response)
      contentType = response.headers.get('content-type') ?? contentType

      await readResponseIntoParts(response, signal, (bytes) => {
        parts.push(bytes)
        loadedBytes += bytes.byteLength
        emitProgress()
      })
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
    }, 8000)

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

function VideoWorkspace({ userName, onSignOut }) {
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
    text: 'Preparing video download',
  })
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [windowStart, setWindowStart] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const [unqualifiedSeconds, setUnqualifiedSeconds] = useState(() => new Set())
  const [visitedSeconds, setVisitedSeconds] = useState(() => new Set())
  const [thumbnails, setThumbnails] = useState({})
  const [thumbnailReady, setThumbnailReady] = useState(false)

  const totalSeconds = useMemo(() => {
    if (!Number.isFinite(duration) || duration <= 0) return 0
    return Math.max(1, Math.floor(duration) + 1)
  }, [duration])

  const maxWindowStart = Math.max(0, totalSeconds - 1)
  const loopStart = totalSeconds > 0 ? clamp(windowStart, 0, maxWindowStart) : 0
  const loopEnd =
    totalSeconds > 0
      ? Math.min(Math.max(loopStart + 0.25, loopStart + FRAME_SECONDS), duration || loopStart + FRAME_SECONDS)
      : FRAME_SECONDS

  const visibleSeconds = useMemo(() => {
    if (totalSeconds === 0) return []
    return Array.from({ length: FRAME_SECONDS }, (_, index) => windowStart + index).filter(
      (second) => second >= 0 && second < totalSeconds
    )
  }, [totalSeconds, windowStart])

  const activeSecond =
    totalSeconds > 0 ? clamp(Math.floor(currentTime), 0, Math.max(0, totalSeconds - 1)) : 0

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

    setDownloadState({
      status: 'loading',
      loadedBytes: 0,
      totalBytes: null,
      percent: 0,
      text: 'Preparing video download',
    })

    fetchVideoAsBlob(VIDEO_SOURCE, controller.signal, (progress) => {
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
  }, [])

  useEffect(() => {
    if (!videoUrl) return undefined

    clearThumbnails()
    setThumbnailReady(false)

    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
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

    const targetTime = clamp(second, 0, Math.max(0, video.duration - 0.001))
    await waitForVideoSeek(video, targetTime)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const url = await canvasToJpegUrl(canvas)
    const existingUrl = thumbnailUrlsRef.current.get(second)
    if (existingUrl) URL.revokeObjectURL(existingUrl)
    thumbnailUrlsRef.current.set(second, url)
    setThumbnails(Object.fromEntries(thumbnailUrlsRef.current))
  }, [])

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
    video.currentTime = loopStart
    setCurrentTime(loopStart)
    if (!stayPaused) {
      setIsPlaying(true)
      void video.play().catch(() => setIsPlaying(false))
    }
  }, [loopStart, totalSeconds, videoUrl])

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    const nextDuration = video.duration
    if (Number.isFinite(nextDuration)) {
      setDuration(nextDuration)
    }
    video.currentTime = 0
    void video.play().catch(() => setIsPlaying(false))
  }, [])

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    setCurrentTime(video.currentTime)
    setIsPlaying(!video.paused)

    if (video.currentTime >= loopEnd - 0.03 || video.currentTime < loopStart) {
      video.currentTime = loopStart
      setCurrentTime(loopStart)
      if (!video.paused) {
        void video.play().catch(() => setIsPlaying(false))
      }
    }
  }, [loopEnd, loopStart])

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
      setWindowStart(target)
      setCurrentTime(target)
      if (video) {
        video.currentTime = target
        if (video.paused) {
          setIsPlaying(true)
          void video.play().catch(() => setIsPlaying(false))
        }
      }
    },
    [totalSeconds]
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
            <img alt={`${second}s`} src={imageUrl} />
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
  const playheadPercent = duration > 0 ? clamp((currentTime / duration) * 100, 0, 100) : 0
  const windowLeftPercent = totalSeconds > 1 ? (windowStart / (totalSeconds - 1)) * 100 : 0
  const windowWidthPercent = totalSeconds > 0 ? Math.min(100, (FRAME_SECONDS / totalSeconds) * 100) : 0

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">SecShot</span>
          <span className="brand-tag">local</span>
        </div>
        <div className="top-actions">
          <span>{userName}</span>
          <span>Episode {EPISODE_ID}</span>
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
                Loop: {loopStart}s - {Math.ceil(loopEnd)}s
              </span>
              <strong>{currentTime.toFixed(2)}s</strong>
            </div>
          </div>
        </section>

        <section className="status-strip">
          <span>Window {loopStart}-{Math.ceil(loopEnd)}s</span>
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

        <button className="timeline" onClick={handleTimelineClick} type="button">
          <span className="timeline-loaded" style={{ width: `${downloadState.percent}%` }} />
          <span className="timeline-visited" style={{ width: `${visitedPercent}%` }} />
          <span
            className="timeline-window"
            style={{ left: `${windowLeftPercent}%`, width: `${windowWidthPercent}%` }}
          />
          <span className="timeline-playhead" style={{ left: `${playheadPercent}%` }} />
        </button>

        <div className="dock-status">
          <span>{downloadState.status === 'error' ? downloadState.text : downloadState.text}</span>
          <strong>{downloadState.percent}%</strong>
        </div>
      </footer>
    </div>
  )
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname)
  const [loginError, setLoginError] = useState('')
  const [form, setForm] = useState({
    email: '',
    password: '',
    remember: true,
  })

  const displayName = useMemo(() => {
    const name = form.email.trim().split('@')[0]
    return name ? name : 'Local reviewer'
  }, [form.email])

  const navigate = useCallback((path, replace = false) => {
    if (window.location.pathname === path) {
      setCurrentPath(path)
      return
    }

    const method = replace ? 'replaceState' : 'pushState'
    window.history[method](null, '', path)
    setCurrentPath(path)
  }, [])

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (currentPath === '/') {
      navigate(LOGIN_PATH, true)
      return
    }

    if (!isAuthenticated && currentPath !== LOGIN_PATH) {
      navigate(LOGIN_PATH, true)
      return
    }

    if (isAuthenticated && currentPath === LOGIN_PATH) {
      navigate(LABEL_PATH, true)
    }
  }, [currentPath, isAuthenticated, navigate])

  const handleFieldChange = useCallback((event) => {
    const { checked, name, type, value } = event.target
    setForm((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value,
    }))
    setLoginError('')
  }, [])

  const handleLogin = useCallback(
    (event) => {
      event.preventDefault()

      if (!form.email.trim() || !form.password.trim()) {
        setLoginError('请输入邮箱和密码')
        return
      }

      setIsAuthenticated(true)
      navigate(LABEL_PATH)
    },
    [form.email, form.password, navigate]
  )

  const handleSignOut = useCallback(() => {
    setIsAuthenticated(false)
    setForm((current) => ({ ...current, password: '' }))
    navigate(LOGIN_PATH, true)
  }, [navigate])

  if (isAuthenticated && currentPath === LABEL_PATH) {
    return <VideoWorkspace onSignOut={handleSignOut} userName={displayName} />
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <h1 id="login-title">登录</h1>
        <form className="login-form" onSubmit={handleLogin}>
          <label className="field">
            <span>邮箱</span>
            <input
              autoComplete="email"
              name="email"
              onChange={handleFieldChange}
              placeholder="邮箱"
              type="email"
              value={form.email}
            />
          </label>

          <label className="field">
            <span>密码</span>
            <input
              autoComplete="current-password"
              name="password"
              onChange={handleFieldChange}
              placeholder="密码"
              type="password"
              value={form.password}
            />
          </label>

          {loginError ? <p className="login-error">{loginError}</p> : null}

          <button className="login-button" type="submit">
            登 录
          </button>
        </form>
      </section>
    </main>
  )
}

export default App
