import { useCallback, useEffect, useState } from 'react'
import './App.css'
import {
  backendApi,
  clearAuthToken,
  clearStoredUser,
  getAuthToken,
  getStoredUser,
  setStoredUser,
} from './api/backend'
import {
  LABEL_PATH,
  LIST_PATH,
  LOCAL_ACCOUNTS,
  LOGIN_PATH,
} from './mock/localData'
import LabelPage from './pages/LabelPage'
import LoginPage from './pages/LoginPage'
import ProjectListPage from './pages/ProjectListPage'

function App() {
  const [isAuthReady, setIsAuthReady] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(() => Boolean(getAuthToken()))
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname)
  const [loginError, setLoginError] = useState('')
  const [currentUser, setCurrentUser] = useState(() => getStoredUser())
  const [projects, setProjects] = useState([])
  const [activeProject, setActiveProject] = useState(null)
  const [workspaceMode, setWorkspaceMode] = useState('label')
  const [projectError, setProjectError] = useState('')
  const [projectBusy, setProjectBusy] = useState('')
  const [form, setForm] = useState({
    email: '',
    password: '',
    remember: true,
  })

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
    if (currentPath.startsWith(LABEL_PATH) && !activeProject) {
      const taskId = currentPath.split('/')[2]
      if (taskId && projects.length > 0) {
        const task = projects.find((p) => p.id === parseInt(taskId, 10))
        if (task) {
          const taskProject = backendApi.openHistoryTask(task)
          setActiveProject(taskProject)
        }
      }
    }
  }, [currentPath, activeProject, projects])

  useEffect(() => {
    if (!isAuthReady) return

    if (currentPath === '/') {
      navigate(LOGIN_PATH, true)
      return
    }

    if (!isAuthenticated && currentPath !== LOGIN_PATH) {
      navigate(LOGIN_PATH, true)
      return
    }

    if (isAuthenticated && currentPath === LOGIN_PATH) {
      navigate(LIST_PATH, true)
    }
  }, [currentPath, isAuthReady, isAuthenticated, navigate])

  useEffect(() => {
    let ignore = false

    async function restoreSession() {
      const token = getAuthToken()
      if (!token) {
        setIsAuthReady(true)
        return
      }

      try {
        const nextProjects = await backendApi.listHistoryTasks()
        if (ignore) return
        setProjects(nextProjects)
        setIsAuthenticated(true)
        setCurrentUser((current) => current ?? getStoredUser() ?? LOCAL_ACCOUNTS[0])
      } catch {
        if (ignore) return
        clearAuthToken()
        clearStoredUser()
        setIsAuthenticated(false)
        setCurrentUser(null)
      } finally {
        if (!ignore) setIsAuthReady(true)
      }
    }

    void restoreSession()

    return () => {
      ignore = true
    }
  }, [])

  const handleFieldChange = useCallback((event) => {
    const { checked, name, type, value } = event.target
    setForm((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value,
    }))
    setLoginError('')
  }, [])

  const handleLogin = useCallback(
    async (event) => {
      event.preventDefault()

      const username = form.email.trim()
      const account = LOCAL_ACCOUNTS.find((item) => item.email === username)

      try {
        await backendApi.login({ username, password: form.password })
        const nextProjects = await backendApi.listHistoryTasks()
        setProjects(nextProjects)
        const user = account ?? { email: username, name: username, role: 'annotator' }
        setStoredUser(user)
        setCurrentUser(user)
        setIsAuthenticated(true)
        setProjectError('')
        navigate(LIST_PATH)
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : '登录失败')
      }
    },
    [form.email, form.password, navigate]
  )

  const handleSignOut = useCallback(() => {
    clearAuthToken()
    clearStoredUser()
    setIsAuthenticated(false)
    setCurrentUser(null)
    setActiveProject(null)
    setProjectError('')
    setForm((current) => ({ ...current, password: '' }))
    navigate(LOGIN_PATH, true)
  }, [navigate])

  const refreshProjects = useCallback(async () => {
    const nextProjects = await backendApi.listHistoryTasks()
    setProjects(nextProjects)
  }, [])

  const handleStartAnnotation = useCallback(
    async (task) => {
      setProjectBusy(`label-${task?.id ?? 1}`)
      setProjectError('')
      try {
        const taskProject = task ? backendApi.openHistoryTask(task) : await backendApi.grabTask()
        setActiveProject(taskProject)
        setWorkspaceMode('label')
        navigate(`${LABEL_PATH}/${task.id}`)
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : '开始标注失败')
      } finally {
        setProjectBusy('')
      }
    },
    [navigate]
  )

  const handleStartReview = useCallback(
    async (task) => {
      setProjectBusy(`review-${task?.id ?? 1}`)
      setProjectError('')
      try {
        const taskProject = await backendApi.getReviewTask(task)
        setActiveProject(taskProject)
        setWorkspaceMode('review')
        navigate(LABEL_PATH)
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : '开始审核失败')
      } finally {
        setProjectBusy('')
      }
    },
    [navigate]
  )

  const handleBackToList = useCallback(() => {
    navigate(LIST_PATH)
  }, [navigate])

  if (!isAuthReady) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <p className="login-hint">正在恢复登录状态...</p>
        </section>
      </main>
    )
  }

  if (isAuthenticated && currentUser && currentPath === LIST_PATH) {
    return (
      <ProjectListPage
        onRefreshProjects={refreshProjects}
        onStartAnnotation={handleStartAnnotation}
        onStartReview={handleStartReview}
        onSignOut={handleSignOut}
        projectBusy={projectBusy}
        projectError={projectError}
        projects={projects}
        user={currentUser}
      />
    )
  }

  if (isAuthenticated && currentUser && currentPath.startsWith(LABEL_PATH)) {
    const project = activeProject
    if (!project) {
      return (
        <ProjectListPage
          onRefreshProjects={refreshProjects}
          onStartAnnotation={handleStartAnnotation}
          onStartReview={handleStartReview}
          onSignOut={handleSignOut}
          projectBusy={projectBusy}
          projectError={projectError}
          projects={projects}
          user={currentUser}
        />
      )
    }

    return (
      <LabelPage
        mode={workspaceMode}
        onBack={handleBackToList}
        onSignOut={handleSignOut}
        project={project}
        user={currentUser}
      />
    )
  }

  return (
    <LoginPage
      form={form}
      loginError={loginError}
      onFieldChange={handleFieldChange}
      onLogin={handleLogin}
    />
  )
}

export default App
