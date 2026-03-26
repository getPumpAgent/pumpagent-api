module.exports = {
  apps: [
    {
      name: "pumpagent-api",
      script: "node_modules/.bin/tsx",
      args: "src/index.ts",
      env: {
        NODE_ENV: "production",
      },
      exec_mode: "fork",
      instances: 1,
      max_memory_restart: "1500M",
      exp_backoff_restart_delay: 100,
    },
  ],
};
