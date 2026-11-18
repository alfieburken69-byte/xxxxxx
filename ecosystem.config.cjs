module.exports = {
  apps: [
    {
      name: 'rolimons-tracker',
      script: 'src/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      out_file: './data/out.log',
      error_file: './data/err.log',
      time: true,
    },
  ],
};
