module.exports = {
  apps: [
    {
      name: "bargazbot",
      script: "./bot.js",
      cwd: __dirname,
      autorestart: true,
      kill_timeout: 65000
    }
  ]
};