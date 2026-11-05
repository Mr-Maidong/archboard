'use strict';

/**
 * npm 11 起默认不执行部分依赖的 install 脚本（allowScripts 策略），
 * 而 electron 的二进制正是靠它自己的 postinstall 下载的。
 * 缺了会在 `npm start` 时以“Cannot read properties of undefined”报错退出，
 * 非常难猜，所以这里补一次、并在失败时把话说清楚。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = path.join(__dirname, '..', 'node_modules', 'electron');
const installer = path.join(dir, 'install.js');
const pathFile = path.join(dir, 'path.txt');

// 没装 electron（例如只想部署网页版、或用 --omit=dev 安装）：什么都不做
if (!fs.existsSync(installer)) process.exit(0);

// 二进制已就位：path.txt 指向 dist/ 下的可执行文件
if (fs.existsSync(pathFile)) {
  const bin = path.join(dir, 'dist', fs.readFileSync(pathFile, 'utf8').trim());
  if (fs.existsSync(bin)) process.exit(0);
}

console.log('[archboard] electron 二进制缺失，补装一次…');
try {
  execFileSync(process.execPath, [installer], { stdio: 'inherit' });
} catch {
  console.warn(
    '[archboard] electron 自动补装失败。手动执行：\n' +
    '  node node_modules/electron/install.js\n' +
    '国内网络可以加镜像：\n' +
    '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js'
  );
}
