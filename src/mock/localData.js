import { backendApi } from '../api/backend'

export const LOGIN_PATH = '/login'
export const LIST_PATH = '/projects'
export const LABEL_PATH = '/label'

export const ROLE_LABELS = {
  admin: '管理员',
  annotator: '标注员',
  reviewer: '验收员',
}

export const LOCAL_ACCOUNTS = [
  {
    email: 'admin',
    password: 'AdminPassword123!',
    name: 'admin',
    role: 'admin',
  },
  {
    email: 'labeler',
    password: 'LabelerPassword123!',
    name: 'labeler',
    role: 'annotator',
  },
  {
    email: 'inspector',
    password: 'InspectorPassword123!',
    name: 'inspector',
    role: 'reviewer',
  },
]

export const projectApi = {
  async submitAnnotation(taskId, payload) {
    if (!taskId) {
      console.info('[mock api] submit annotation', payload)
      return { ok: true }
    }
    return backendApi.submitAnnotation(taskId, payload)
  },
  async submitReview(taskId, payload) {
    if (!taskId) {
      console.info('[mock api] submit review', payload)
      return { ok: true }
    }
    return backendApi.submitReview(taskId, payload)
  },
}
