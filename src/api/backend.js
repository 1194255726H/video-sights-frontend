const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''
const TOKEN_STORAGE_KEY = 'auth_token'
const USER_STORAGE_KEY = 'auth_user'
const DEFAULT_PROJECT_ID = 1
const DEFAULT_PROJECT = {
  id: DEFAULT_PROJECT_ID,
  name: '默认视频标注项目',
  type: '抢占式',
  team: '默认标注科技公司',
  description: '默认项目任务',
  creator: '后端',
  createdAt: '-',
  taskCount: 0,
  completedCount: 0,
}

export function getAuthToken() {
  return window.localStorage.getItem(TOKEN_STORAGE_KEY)
}

export function setAuthToken(token) {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
}

export function clearAuthToken() {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY)
}

export function getStoredUser() {
  const raw = window.localStorage.getItem(USER_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function setStoredUser(user) {
  window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
}

export function clearStoredUser() {
  window.localStorage.removeItem(USER_STORAGE_KEY)
}

async function request(path, options = {}) {
  const token = getAuthToken()
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Token ${token}` } : {}),
      ...options.headers,
    },
  })

  const text = await response.text()
  const data = text ? JSON.parse(text) : null

  if (!response.ok) {
    const message = data?.message || data?.detail || `请求失败：${response.status}`
    throw new Error(message)
  }

  return data
}

function normalizeHistoryTask(task) {
  const completed = task.status === 'completed' ? 1 : 0
  return {
    id: task.id,
    projectId: task.project ?? DEFAULT_PROJECT_ID,
    name: task.oss_key || `任务 ${task.id}`,
    type: task.status || 'task',
    team: task.assigned_username || '-',
    description: task.annotation_data ? '已提交标注' : '暂无标注数据',
    creator: task.assigned_username || '未领取',
    createdAt: task.labeled_at ? new Date(task.labeled_at).toLocaleString() : '-',
    taskCount: 1,
    completedCount: completed,
    raw: task,
  }
}

function normalizeTask(task, project = DEFAULT_PROJECT) {
  const videoSource =
    task.preview_url ||
    task.preview_mp4_url ||
    task.previewUrl ||
    task.preview ||
    task.presigned_url ||
    task.video_url ||
    task.videoSource
  const annotationFps = Number(task.annotation_fps ?? task.annotationFps ?? 1)
  const duration = Number(task.duration ?? task.duration_s ?? task.durationSeconds ?? 0)

  return {
    ...project,
    activeTask: task,
    id: project.id,
    name: `${project.name} / 任务 ${task.id}`,
    videoSource,
    annotationFps: Number.isFinite(annotationFps) && annotationFps > 0 ? Math.floor(annotationFps) : 1,
    expectedDuration: Number.isFinite(duration) && duration > 0 ? duration : null,
  }
}

export const backendApi = {
  async login({ username, password }) {
    const data = await request('/api/auth/login/', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    if (data?.token) setAuthToken(data.token)
    return data
  },

  async listHistoryTasks() {
    const tasks = await request(`/api/tasks/?project_id=${DEFAULT_PROJECT_ID}`)
    return tasks.map(normalizeHistoryTask)
  },

  async grabTask() {
    const task = await request(`/api/projects/${DEFAULT_PROJECT_ID}/grab/`, { method: 'POST' })
    return normalizeTask(task)
  },

  openHistoryTask(historyTask) {
    if (!historyTask?.raw) throw new Error('任务数据不存在')
    return normalizeTask(historyTask.raw)
  },

  async getReviewTask(historyTask) {
    const tasks = historyTask?.raw
      ? [historyTask.raw]
      : await request(`/api/tasks/?project_id=${DEFAULT_PROJECT_ID}`)
    const task = tasks.find((item) => item.status === 'completed' && item.audit_passed === null)
    if (!task) throw new Error('当前项目暂无待审核任务')
    return normalizeTask(task)
  },

  async submitAnnotation(taskId, annotationData) {
    return request(`/api/tasks/${taskId}/label/`, {
      method: 'PUT',
      body: JSON.stringify({ annotation_data: annotationData }),
    })
  },

  async submitReview(taskId, auditData) {
    return request(`/api/tasks/${taskId}/audit/`, {
      method: 'POST',
      body: JSON.stringify(auditData),
    })
  },

  async getHandposeMeta(taskId) {
    const data = await request(`/api/tasks/${taskId}/handpose_meta/`)
    return data
  },

  async getHandposeData(taskId, hand, joint) {
    const params = new URLSearchParams()
    if (hand) params.set('hand', hand)
    if (joint) params.set('joint', joint)
    const data = await request(`/api/tasks/${taskId}/handpose/?${params.toString()}`)
    return data
  },
}
