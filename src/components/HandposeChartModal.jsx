import { useEffect, useMemo, useState } from 'react'
import { backendApi } from '../api/backend'

const AXES = ['x', 'y', 'z']
const AXIS_LABELS = { x: 'X', y: 'Y', z: 'Z' }
const HAND_LABELS = {
  left_hand: '左手',
  right_hand: '右手',
}
const LINE_STYLES = {
  original: { label: '原始', dash: '6 5' },
  filtered: { label: '修正后', dash: '' },
}
const COLORS = {
  x: '#4da3ff',
  y: '#28c58f',
  z: '#f28a3e',
}
const CHART_WIDTH = 920
const CHART_HEIGHT = 390
const PADDING = { top: 24, right: 28, bottom: 42, left: 58 }

function normalizeHandposeMeta(metaData) {
  const handpose = metaData?.handpose
  if (!handpose || typeof handpose !== 'object') return {}

  return Object.fromEntries(
    Object.entries(handpose).filter(([, joints]) => Array.isArray(joints) && joints.length > 0)
  )
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '-'
  if (Math.abs(value) >= 1000) return value.toFixed(0)
  if (Math.abs(value) >= 1) return value.toFixed(2)
  return value.toFixed(4)
}

function pickInitialHand(meta) {
  if (meta.right_hand?.length) return 'right_hand'
  return Object.keys(meta)[0] ?? ''
}

function getChartBounds(series) {
  const values = series.flatMap((line) => line.points.map((point) => point.value)).filter(Number.isFinite)
  if (values.length === 0) return null

  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = Math.max((max - min) * 0.08, 0.0001)
  return {
    min: min - pad,
    max: max + pad,
  }
}

function makePath(points, xScale, yScale) {
  const chunks = []
  let active = false

  points.forEach((point) => {
    if (!Number.isFinite(point.value)) {
      active = false
      return
    }

    const command = active ? 'L' : 'M'
    chunks.push(`${command}${xScale(point.frame).toFixed(2)},${yScale(point.value).toFixed(2)}`)
    active = true
  })

  return chunks.join(' ')
}

function buildSeries(data, visibleAxes) {
  if (!data?.frame_indices?.length) return []

  return AXES.filter((axis) => visibleAxes[axis]).flatMap((axis) =>
    ['original', 'filtered'].map((kind) => ({
      key: `${kind}_${axis}`,
      axis,
      kind,
      points: data.frame_indices.map((frame, index) => ({
        frame,
        value: data[kind]?.[axis]?.[index] ?? null,
      })),
    }))
  )
}

function HandposeLineChart({ data, visibleAxes }) {
  const [hoverIndex, setHoverIndex] = useState(null)
  const series = useMemo(() => buildSeries(data, visibleAxes), [data, visibleAxes])
  const bounds = useMemo(() => getChartBounds(series), [series])
  const frames = data?.frame_indices ?? []

  if (!bounds || frames.length === 0) {
    return <div className="handpose-empty">暂无可绘制的轨迹数据</div>
  }

  const minFrame = frames[0]
  const maxFrame = frames[frames.length - 1]
  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom
  const xScale = (frame) =>
    PADDING.left + ((frame - minFrame) / Math.max(maxFrame - minFrame, 1)) * plotWidth
  const yScale = (value) =>
    PADDING.top + (1 - (value - bounds.min) / Math.max(bounds.max - bounds.min, 0.0001)) * plotHeight
  const yTicks = Array.from({ length: 5 }, (_, index) => bounds.min + ((bounds.max - bounds.min) * index) / 4)
  const xTicks = Array.from({ length: 5 }, (_, index) => Math.round(minFrame + ((maxFrame - minFrame) * index) / 4))
  const hoverPoint = hoverIndex === null ? null : {
    frame: frames[hoverIndex],
    timestamp: data?.timestamps?.[hoverIndex] ?? null,
    x: xScale(frames[hoverIndex]),
  }
  const tooltipRows = hoverPoint
    ? AXES.filter((axis) => visibleAxes[axis]).map((axis) => ({
        axis,
        original: data?.original?.[axis]?.[hoverIndex],
        filtered: data?.filtered?.[axis]?.[hoverIndex],
      }))
    : []
  const tooltipWidth = 230
  const tooltipHeight = 54 + tooltipRows.length * 24
  const tooltipX = hoverPoint && hoverPoint.x > CHART_WIDTH - PADDING.right - tooltipWidth - 12
    ? hoverPoint.x - tooltipWidth - 12
    : (hoverPoint?.x ?? PADDING.left) + 12
  const tooltipY = PADDING.top + 10

  const handlePointerMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const viewBoxX = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * CHART_WIDTH
    const clampedX = Math.max(PADDING.left, Math.min(CHART_WIDTH - PADDING.right, viewBoxX))
    const ratio = (clampedX - PADDING.left) / Math.max(plotWidth, 1)
    const nextIndex = Math.max(0, Math.min(frames.length - 1, Math.round(ratio * (frames.length - 1))))
    setHoverIndex((current) => (current === nextIndex ? current : nextIndex))
  }

  return (
    <div className="handpose-chart-wrap">
      <svg
        aria-label="手势轨迹原始与修正后对比折线图"
        className="handpose-chart"
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      >
        <rect
          className="handpose-plot-bg"
          height={plotHeight}
          width={plotWidth}
          x={PADDING.left}
          y={PADDING.top}
        />

        {yTicks.map((tick) => {
          const y = yScale(tick)
          return (
            <g key={`y-${tick}`}>
              <line className="handpose-grid-line" x1={PADDING.left} x2={CHART_WIDTH - PADDING.right} y1={y} y2={y} />
              <text className="handpose-axis-text" textAnchor="end" x={PADDING.left - 10} y={y + 4}>
                {formatNumber(tick)}
              </text>
            </g>
          )
        })}

        {xTicks.map((tick) => {
          const x = xScale(tick)
          return (
            <g key={`x-${tick}`}>
              <line className="handpose-grid-line soft" x1={x} x2={x} y1={PADDING.top} y2={CHART_HEIGHT - PADDING.bottom} />
              <text className="handpose-axis-text" textAnchor="middle" x={x} y={CHART_HEIGHT - 16}>
                {tick}
              </text>
            </g>
          )
        })}

        {series.map((line) => (
          <path
            className="handpose-data-line"
            d={makePath(line.points, xScale, yScale)}
            fill="none"
            key={line.key}
            stroke={COLORS[line.axis]}
            strokeDasharray={LINE_STYLES[line.kind].dash}
          />
        ))}

        {hoverPoint && (
          <g className="handpose-hover-layer">
            <line
              className="handpose-hover-line"
              x1={hoverPoint.x}
              x2={hoverPoint.x}
              y1={PADDING.top}
              y2={CHART_HEIGHT - PADDING.bottom}
            />
            {series.map((line) => {
              const point = line.points[hoverIndex]
              if (!Number.isFinite(point?.value)) return null
              return (
                <circle
                  className="handpose-hover-dot"
                  cx={hoverPoint.x}
                  cy={yScale(point.value)}
                  fill={COLORS[line.axis]}
                  key={`${line.key}-hover`}
                  r={line.kind === 'filtered' ? 4 : 3}
                />
              )
            })}
            <foreignObject height={tooltipHeight} width={tooltipWidth} x={tooltipX} y={tooltipY}>
              <div className="handpose-tooltip">
                <strong>帧 {hoverPoint.frame}</strong>
                <span>时间戳：{hoverPoint.timestamp ?? '-'}</span>
                {tooltipRows.map((row) => (
                  <span className="handpose-tooltip-row" key={row.axis}>
                    <b style={{ color: COLORS[row.axis] }}>{AXIS_LABELS[row.axis]}</b>
                    <span>原始 {formatNumber(row.original)}</span>
                    <span>修正 {formatNumber(row.filtered)}</span>
                  </span>
                ))}
              </div>
            </foreignObject>
          </g>
        )}

        <text className="handpose-axis-title" textAnchor="middle" x={CHART_WIDTH / 2} y={CHART_HEIGHT - 4}>
          帧序号
        </text>
        <rect
          className="handpose-hover-capture"
          height={plotHeight}
          onPointerLeave={() => setHoverIndex(null)}
          onPointerMove={handlePointerMove}
          width={plotWidth}
          x={PADDING.left}
          y={PADDING.top}
        />
      </svg>
    </div>
  )
}

export default function HandposeChartModal({ taskId, onClose }) {
  const [meta, setMeta] = useState({})
  const [hand, setHand] = useState('')
  const [joint, setJoint] = useState('')
  const [chartData, setChartData] = useState(null)
  const [metaLoading, setMetaLoading] = useState(true)
  const [dataLoading, setDataLoading] = useState(false)
  const [error, setError] = useState('')
  const [visibleAxes, setVisibleAxes] = useState({ x: true, y: true, z: true })

  useEffect(() => {
    let ignore = false

    async function fetchMeta() {
      if (!taskId) {
        setMetaLoading(false)
        setError('当前任务 ID 不存在')
        return
      }

      setMetaLoading(true)
      setError('')
      setChartData(null)

      try {
        const metaData = await backendApi.getHandposeMeta(taskId)
        if (ignore) return

        const nextMeta = normalizeHandposeMeta(metaData)
        const initialHand = pickInitialHand(nextMeta)
        setMeta(nextMeta)
        setHand(initialHand)
        setJoint(nextMeta[initialHand]?.[0] ?? '')
        if (!initialHand) setError('该任务暂无手势关节元数据')
      } catch (caughtError) {
        if (!ignore) setError(caughtError instanceof Error ? caughtError.message : '手势元数据加载失败')
      } finally {
        if (!ignore) setMetaLoading(false)
      }
    }

    void fetchMeta()
    return () => {
      ignore = true
    }
  }, [taskId])

  useEffect(() => {
    let ignore = false

    async function fetchChartData() {
      if (!taskId || !hand || !joint) return

      setDataLoading(true)
      setError('')

      try {
        const data = await backendApi.getHandposeData(taskId, hand, joint)
        if (!ignore) setChartData(data)
      } catch (caughtError) {
        if (!ignore) {
          setChartData(null)
          setError(caughtError instanceof Error ? caughtError.message : '手势轨迹数据加载失败')
        }
      } finally {
        if (!ignore) setDataLoading(false)
      }
    }

    void fetchChartData()
    return () => {
      ignore = true
    }
  }, [hand, joint, taskId])

  const jointOptions = meta[hand] ?? []
  const isLoading = metaLoading || dataLoading

  return (
    <div className="handpose-modal-overlay" onClick={onClose}>
      <section
        aria-labelledby="handpose-modal-title"
        aria-modal="true"
        className="handpose-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="handpose-modal-header">
          <div>
            <h2 id="handpose-modal-title">手势轨迹统计</h2>
            <p>任务 {taskId || '-'} 的原始轨迹与修正后轨迹对比</p>
          </div>
          <button aria-label="关闭手势轨迹统计弹窗" className="handpose-close-button" onClick={onClose} type="button">
            x
          </button>
        </header>

        <div className="handpose-toolbar">
          <label className="handpose-field">
            <span>手</span>
            <select
              disabled={metaLoading || Object.keys(meta).length === 0}
              onChange={(event) => {
                const nextHand = event.target.value
                setHand(nextHand)
                setJoint(meta[nextHand]?.[0] ?? '')
              }}
              value={hand}
            >
              {Object.keys(meta).map((handKey) => (
                <option key={handKey} value={handKey}>
                  {HAND_LABELS[handKey] ?? handKey}
                </option>
              ))}
            </select>
          </label>

          <label className="handpose-field">
            <span>关节</span>
            <select
              disabled={metaLoading || jointOptions.length === 0}
              onChange={(event) => setJoint(event.target.value)}
              value={joint}
            >
              {jointOptions.map((jointName) => (
                <option key={jointName} value={jointName}>
                  {jointName}
                </option>
              ))}
            </select>
          </label>

          <div className="handpose-axis-toggle" aria-label="坐标轴显示">
            {AXES.map((axis) => (
              <label key={axis}>
                <input
                  checked={visibleAxes[axis]}
                  onChange={(event) =>
                    setVisibleAxes((current) => ({
                      ...current,
                      [axis]: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                <span style={{ '--axis-color': COLORS[axis] }}>{AXIS_LABELS[axis]}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="handpose-summary">
          <span>帧数：{chartData?.frame_count ?? '-'}</span>
          <span>当前：{HAND_LABELS[hand] || hand || '-'} / {joint || '-'}</span>
          <span>空帧：原始线条会在缺失处断开</span>
        </div>

        <div className="handpose-chart-panel">
          {isLoading && <div className="handpose-state">正在加载手势轨迹...</div>}
          {!isLoading && error && <div className="handpose-state error">{error}</div>}
          {!isLoading && !error && <HandposeLineChart data={chartData} visibleAxes={visibleAxes} />}
        </div>

        <div className="handpose-legend">
          {AXES.map((axis) => (
            <span key={axis}>
              <i style={{ background: COLORS[axis] }} />
              {AXIS_LABELS[axis]}
            </span>
          ))}
          <span className="line-sample dashed" /> 原始
          <span className="line-sample" /> 修正后
        </div>
      </section>
    </div>
  )
}
