import { useMemo, useState } from 'react'
import { ROLE_LABELS } from '../mock/localData'

function ProjectListPage({
  onRefreshProjects,
  onSignOut,
  onStartAnnotation,
  onStartReview,
  projectBusy,
  projectError,
  projects,
  user,
}) {
  const [keyword, setKeyword] = useState('')
  const [activeTab, setActiveTab] = useState('all')

  const getStatusLabel = (project) => {
    if (project.raw?.audit_passed === true) return '审核通过'
    if (project.raw?.audit_passed === false) return '审核未通过'
    if (project.raw?.status === 'completed') return '已完成'
    if (project.raw?.status === 'in_progress') return '标注中'
    if (project.raw?.status === 'pending') return '待标注'
    if (project.raw?.status) return project.raw.status
    return '待处理'
  }

  const filteredProjects = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    const searchedProjects = text
      ? projects.filter((project) =>
          [project.name, project.type, project.team, project.description, String(project.id)]
            .filter(Boolean)
            .some((value) => value.toLowerCase().includes(text))
        )
      : projects

    return searchedProjects.filter((project) => {
      if (activeTab === 'completed') return project.raw?.status === 'completed'
      if (activeTab === 'voting') return project.raw?.status !== 'completed'
      if (activeTab === 'audited') return project.raw?.audit_passed !== null
      return true
    })
  }, [activeTab, keyword, projects])

  const canAnnotate = user.role === 'admin' || user.role === 'annotator'
  const canReview = user.role === 'admin' || user.role === 'reviewer'
  const tabs = [
    { key: 'all', label: '全部' },
    { key: 'voting', label: '待标注' },
    { key: 'completed', label: '已完成' },
    { key: 'audited', label: '已审核' },
  ]

  return (
    <main className="project-shell">
      <header className="project-header">
        <div>
          <h1>任务工作台</h1>
        </div>
        <div className="project-header-actions">
          <div>
            {user.name} / {ROLE_LABELS[user.role]}
          </div>
          <button className="list-sign-out" onClick={onRefreshProjects} type="button">
            刷新
          </button>
          <button className="list-sign-out" onClick={onSignOut} type="button">
            退出
          </button>
        </div>
      </header>

      <section className="project-table-wrap">
        <div className="project-toolbar">
          {canAnnotate ? (
            <button
              className="hero-action annotate"
              disabled={projectBusy?.startsWith('label-')}
              onClick={() => onStartAnnotation()}
              type="button"
            >
              <span className="hero-action-icon">▶</span>
              {projectBusy?.startsWith('label-') ? '获取中' : '开始标注'}
            </button>
          ) : null}
          {canReview ? (
            <button
              className="hero-action audit"
              disabled={projectBusy?.startsWith('review-')}
              onClick={() => onStartReview()}
              type="button"
            >
              <span className="hero-action-icon">♡</span>
              {projectBusy?.startsWith('review-') ? '获取中' : '开始审核'}
            </button>
          ) : null}
          {projectError ? <span className="project-error">{projectError}</span> : null}
        </div>
        <section className="history-section">
          <div className="history-heading">
            <div className="history-title">
              <span className="history-icon">↺</span>
              <h2>历史标注</h2>
            </div>
            {/* <div className="history-tabs">
              {tabs.map((tab) => (
                <button
                  className={`history-tab ${activeTab === tab.key ? 'active' : ''}`}
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div> */}
          </div>

          <div className="history-filter">
            <label className="history-search">
              <span>搜索任务</span>
              <input
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索名称"
                type="search"
                value={keyword}
              />
            </label>
            <span className="history-count">
              共 {projects.length} 个任务，当前显示 {filteredProjects.length} 个
            </span>
          </div>

          <div className="history-grid">
            {filteredProjects.map((project) => {
              const total = project.taskCount ?? 1
              const completed = project.completedCount ?? 0
              const progress = total > 0 ? Math.round((completed / total) * 100) : 0
              const isCompleted = project.raw?.status === 'completed'

              return (
                <article className="history-card" key={project.id}>
                  <div className="history-card-top">
                    <strong>{project.name}</strong>
                    {/* <span className="history-check">✓</span> */}
                  </div>
                  <p>
                    {getStatusLabel(project)} <span>{project.createdAt}</span>
                  </p>
                  <div className="history-progress-row">
                    <span>进度</span>
                    <span>
                      {completed}/{total} - {progress}%
                    </span>
                  </div>
                  <span className="history-progress-track">
                    <span style={{ width: `${progress}%` }} />
                  </span>
                  <div className="history-card-actions">
                    {canReview ? (
                      <button
                        className="history-review-button"
                        disabled={projectBusy === `review-${project.id}`}
                        onClick={() => onStartReview(project)}
                        type="button"
                      >
                        审核
                      </button>
                    ) : null}
                    {canAnnotate && project.raw?.status !== 'completed' ? (
                      <button
                        className="history-review-button"
                        disabled={projectBusy === `label-${project.id}`}
                        onClick={() => onStartAnnotation(project)}
                        type="button"
                      >
                        标注
                      </button>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>

          {filteredProjects.length === 0 ? <div className="empty-projects">暂无项目</div> : null}
        </section>
      </section>
    </main>
  )
}

export default ProjectListPage
