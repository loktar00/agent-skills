<!-- Loaded by the test-rigor skill when working in called-deeweb. -->

# called-deeweb: traps that produce false passes

- **Run tests from the repo root.** `npm run test` and `npm run lint` from `D:\devNewman\called-deeweb`,
  never from `apps/called-chat` — only the root vitest config sets the jsdom env, and running from the
  app errors `window is not defined`.
- **Green tests are not a working feature.** Auth bootstrap and cross-entity fetch bugs only
  reproduce end to end. Walk the live flow before calling anything done.
- **The dev server port is derived from the working directory path.** It is not always 5173. Read
  the actual URL out of the Vite output rather than assuming, especially with several worktrees running.
- **Never pipe the dev server through `head`.** The closed pipe SIGPIPEs the server.
- **Freeze time for anything date-relative.** `vi.useFakeTimers` + `vi.setSystemTime` whenever an
  assertion depends on "today", "tomorrow" or "this week" formatting.
- **Create disposable data for destructive flows.** Never test delete against a record that already
  existed. Make a throwaway first.
- **`packages/called-api` is generated and gitignored.** Ripgrep skips it, so a zero-match search
  there means nothing. Use `rg --no-ignore`.
- **Playwright MCP**: screenshots land relative to the process cwd, not where you asked; element
  refs go stale after a re-render, so re-snapshot before interacting; `file://` is blocked, so serve
  local HTML over `http://127.0.0.1:<port>` instead. Check a free port first — 8899 was already taken
  and silently answered 404.
- **A stale branch invents bugs.** `git fetch && git rev-list --count HEAD..origin/develop` before
  concluding a feature is missing or broken.
