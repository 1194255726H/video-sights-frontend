function LoginPage({ form, loginError, onFieldChange, onLogin }) {
  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <h1 id="login-title">登录</h1>
        <form className="login-form" onSubmit={onLogin}>
          <label className="field">
            <span>账号</span>
            <input
              autoComplete="username"
              name="email"
              onChange={onFieldChange}
              placeholder="账号"
              type="text"
              value={form.email}
            />
          </label>

          <label className="field">
            <span>密码</span>
            <input
              autoComplete="current-password"
              name="password"
              onChange={onFieldChange}
              placeholder="密码"
              type="password"
              value={form.password}
            />
          </label>

          {loginError ? <p className="login-error">{loginError}</p> : null}

          <button className="login-button" type="submit">
            登 录
          </button>
          <p className="login-hint">
            admin / labeler / inspector，请使用后端预置密码
          </p>
        </form>
      </section>
    </main>
  )
}

export default LoginPage
