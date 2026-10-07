#!/usr/bin/env node
// Keep the read-only local monitor running after the launching terminal closes.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const root = path.resolve(__dirname, '..')
const local = path.join(root, '.local')
fs.mkdirSync(local, { recursive: true, mode: 0o700 })
const log = fs.openSync(path.join(local, 'monitor.log'), 'a', 0o600)
const inventory = path.join(local, 'desktop-sessions.json')
const child = spawn(process.execPath, [path.join(root, 'app/dist/app.js'), '--no-open', ...process.argv.slice(2)], {
  cwd: root, detached: true, stdio: ['ignore', log, log],
  env: {
    ...process.env,
    AGENT_FLOW_RUNTIME: process.env.AGENT_FLOW_RUNTIME ?? 'codex',
    DO_NOT_TRACK: process.env.DO_NOT_TRACK ?? '1',
    ...(fs.existsSync(inventory) ? { AGENT_FLOW_DESKTOP_SESSIONS: inventory } : {}),
  },
})
child.unref()
fs.closeSync(log)
fs.writeFileSync(path.join(local, 'monitor.pid'), String(child.pid), { mode: 0o600 })
console.log(`Agent Flow monitor started (PID ${child.pid}). Logs: .local/monitor.log`)
