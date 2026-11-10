const path = require('node:path');

const appRoot = __dirname;
const port = Number(process.env.PORT || 5180);
const host = process.env.HOST || '127.0.0.1';

module.exports = {
  apps: [
    {
      name: 'owtomate-applications', cwd: appRoot,
      script: path.join(appRoot, 'dashboard', 'scripts', 'run-service.mts'),
      interpreter: process.execPath,
      node_args: `--import ${path.join(appRoot, 'seek-bot', 'node_modules', 'tsx', 'dist', 'loader.mjs')}`,
      instances: 1, exec_mode: 'fork', autorestart: true, watch: false,
      // Dashboard memory restarts must never signal this sibling process.
      // Full deployments drain applications before refreshing this service.
      kill_timeout: 3 * 60 * 60 * 1000, restart_delay: 2000, time: true,
      env: { NODE_ENV: 'production', DISPLAY: process.env.DISPLAY || ':99',
        OWTOMATE_RUN_SERVICE_CLIENT: '0', MALLOC_ARENA_MAX: '2',
        ...(process.env.MAX_CONCURRENT_RUNS ? { MAX_CONCURRENT_RUNS: process.env.MAX_CONCURRENT_RUNS } : {}) },
    },
    {
      name: 'owtomate-job-index', cwd: appRoot,
      script: path.join(appRoot, 'seek-bot', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      args: 'dashboard/scripts/job-index-worker.mts', interpreter: process.execPath,
      instances: 1, exec_mode: 'fork', autorestart: true, watch: false,
      max_memory_restart: '250M', kill_timeout: 20_000, restart_delay: 10_000, time: true,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'owtomate-public-site',
      cwd: path.join(appRoot, 'public-site'),
      script: path.join(appRoot, 'public-site', 'scripts', 'start.mjs'),
      interpreter: process.execPath,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      kill_timeout: 10_000,
      restart_delay: 2_000,
      time: true,
      env: { NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: '5191', DASHBOARD_ORIGIN: 'http://127.0.0.1:5180' },
    },
    {
      name: 'market-scout',
      cwd: path.join(appRoot, 'market-scout'),
      script: path.join(appRoot, 'market-scout', 'dist', 'cli.js'),
      args: 'ui',
      interpreter: process.execPath,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      kill_timeout: 35_000,
      restart_delay: 2_000,
      time: true,
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: path.join(appRoot, 'seek-bot', '.env'),
        DISPLAY: ':99',
        HEADLESS: 'false',
        SCOUT_NO_OPEN: '1',
        SCOUT_UI_BASE_PATH: '/market-research',
        SCOUT_PROFILE_DIR: path.join(appRoot, 'market-scout', '.scout', 'profile'),
        CELERIS_MAX_OUTPUT_TOKENS: '8192',
      },
    },
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
      node_args: '--max-old-space-size=256',
      kill_timeout: 30_000,
      restart_delay: 2_000,
      time: true,
      env: {
        NODE_ENV: 'production',
        OWTOMATE_RUN_SERVICE_CLIENT: '1',
        MALLOC_ARENA_MAX: '2',
        /**
         * The virtual screen every run's Chrome draws on (myasis-xvfb.service).
         * Headed Chrome needs a display; headless is what bot detection looks
         * for. Sign-in sessions open their own displays from :100 upward.
         */
        DISPLAY: process.env.DISPLAY || ':99',
        PUBLIC_SITE_URL: 'http://127.0.0.1:5191',
        /**
         * Accounts that may run at once. Left unset, the dashboard works it out
         * from the machine's cores and memory (dashboard/server/runner.ts).
         */
        ...(process.env.MAX_CONCURRENT_RUNS ? { MAX_CONCURRENT_RUNS: process.env.MAX_CONCURRENT_RUNS } : {}),
      },
    },
  ],
};
