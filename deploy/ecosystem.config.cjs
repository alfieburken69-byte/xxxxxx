module.exports = {
  apps: [
    {
      name: 'rolimons-tracker',
      script: 'src/index.js',
      cwd: '/opt/rolimons-tracker',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      out_file: '/var/log/rolimons-tracker.out.log',
      error_file: '/var/log/rolimons-tracker.err.log',
      time: true,
    },
  ],
};
