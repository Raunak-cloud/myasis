const path = require('node:path');

const appRoot = __dirname;
const port = Number(process.env.PORT || 5180);
const host = process.env.HOST || '127.0.0.1';

module.exports = {
  apps: [
    {
      name: 'myasis-dashboard',
      cwd: path.join(appRoot, 'dashboard'),
      script: path.join(appRoot, 'dashboard', 'node_modules', 'vite', 'bin', 'vite.js'),
      args: `preview --host ${host} --port ${port} --strictPort`,
      interpreter: process.execPath,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '750M',
      kill_timeout: 15_000,
      restart_delay: 2_000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
