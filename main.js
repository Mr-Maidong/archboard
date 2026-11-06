'use strict';

/**
 * 无边画板 · Boundless —— Electron 桌面外壳
 *
 * 这个文件的职责只有三件事，前端代码一行都没有改：
 *
 *   1. 用自定义协议 app://archboard 把静态前端当“站点”提供出去。
 *      不能直接 loadFile()：file:// 是 opaque origin，IndexedDB 与 localStorage
 *      会不可用或不可靠，而这个工具的工程与图片全存在 IndexedDB 里。
 *   2. 收紧窗口权限：无 Node、无 webview、无新窗口、无导航逃逸、无设备权限。
 *   3. 自定义菜单，把 ⌘Z / ⇧⌘Z / ⌘A / ⌘1-7 等让给页面自己处理。
 *      Electron 的菜单快捷键优先级高于页面 keydown，用默认菜单会把画布的
 *      撤销、全选、切工具全部抢走。
 */

const { app, BrowserWindow, Menu, protocol, session, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { statSync } = require('node:fs');

const SCHEME = 'app';
const HOST = 'archboard';
const ROOT = app.getAppPath();            // 开发时是项目目录，打包后是 app.asar
const INDEX = `${SCHEME}://${HOST}/index.html`;

// 双击 .archboard 时，LaunchServices / argv 给的是路径；
// 页面那边只认 File 对象，所以这里先暂存路径，再由 /__open 路由把它喂回页面。
let mainWindow = null;
let pendingOpen = null;      // 待打开的绝对路径
let openPayload = null;      // /__open 当前对外提供的那一个文件

// 必须在 app ready 之前注册，privileges 里的 standard + secure 决定
// 这个 origin 能否拿到 IndexedDB、crypto.subtle、localStorage。
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true,
  },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 从 app.asar（或项目目录）里读文件并返回响应。
 * 用 Node 的 fs 而不是 net.fetch(file://)：Node 的 fs 对 asar 是透明的，
 * Chromium 的网络栈不是。
 */
async function handleAppRequest(req) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // 文件关联用的虚拟路径：只吐当前待打开的那一个文件，不做任何路径拼接
  if (pathname === '/__open') {
    if (!openPayload) return new Response('Not Found', { status: 404 });
    try {
      const body = await fs.readFile(openPayload);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  }

  const file = path.normalize(path.join(ROOT, pathname));
  // 目录穿越防护：只允许 app.asar 内部的文件
  if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });

  try {
    const body = await fs.readFile(file);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // 本地文件没有内容哈希，开发时改完刷新即生效
        'cache-control': 'no-cache',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 无边画板' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 无边画板' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出 无边画板' },
      ],
    });
  }

  template.push({
    label: '编辑',
    submenu: [
      // 注意：这里刻意不放 undo / redo / selectAll。
      // 它们的默认快捷键是 ⌘Z / ⇧⌘Z / ⌘A，一旦注册成菜单项，
      // 就会先于页面抢走按键，而这三个键在画布上各有含义。
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
    ],
  });

  const viewItems = [];
  if (!app.isPackaged) {
    viewItems.push({ role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' });
    viewItems.push({ type: 'separator' });
  }
  viewItems.push({ role: 'togglefullscreen', label: '全屏' });
  template.push({ label: '视图', submenu: viewItems });

  template.push({
    label: '窗口',
    submenu: isMac
      ? [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { type: 'separator' }, { role: 'front', label: '前置全部窗口' }]
      : [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenSession() {
  const ses = session.defaultSession;

  // 这个应用不需要任何设备权限（相机 / 麦克风 / 定位 / 通知）
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1120,          // 三栏布局（图层 / 画布 / 检查器）的下限
    minHeight: 720,
    show: false,
    backgroundColor: '#0a0a0a',
    title: '无边画板',
    autoHideMenuBar: process.platform !== 'darwin',
    // 保持默认标题栏：工具栏贴着左上角，红绿灯压过去会盖住「选择」按钮
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,          // 中文标题上出现红波浪线很难看
      backgroundThrottling: false, // 最小化再恢复时画布不至于重排跳一下
    },
  });

  mainWindow = win;
  win.once('ready-to-show', () => win.show());

  // 站外链接交给系统浏览器，窗口本身不允许弹出新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 把页面锁死在 app:// 里，拖进来的文件或误写的 location 都跳不出去
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${SCHEME}://${HOST}/`)) event.preventDefault();
  });

  win.loadURL(INDEX);

  // 页面就绪后，如果启动时带了文件（双击 .archboard），立刻送进去
  win.webContents.once('did-finish-load', () => deliverOpen(win));
  return win;
}

/* ── 文件关联 ────────────────────────────────────────────────────────────
   页面没有暴露“从路径导入”的接口，但它认窗口上的 drop 事件。
   于是这里把文件路径暂存、由 /__open 路由交出字节，再在页面里造一个
   File + DataTransfer 触发 drop —— 走的完全是拖拽文件那条既有链路，
   前端一行都不用改。                                                  */

const OPEN_SCRIPT = (name) => `(async () => {
  const res = await fetch('${SCHEME}://${HOST}/__open', { cache: 'no-store' });
  if (!res.ok) return 'http ' + res.status;
  const blob = await res.blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], ${JSON.stringify(name)}, { type: 'application/octet-stream' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return 'ok';
})()`;

function queueOpen(filePath) {
  if (!filePath) return;
  pendingOpen = filePath;
  if (mainWindow && !mainWindow.webContents.isLoading()) deliverOpen(mainWindow);
}

async function deliverOpen(win) {
  if (!pendingOpen || !win) return;
  const file = pendingOpen;
  pendingOpen = null;

  try {
    if (!(await fs.stat(file)).isFile()) return;
  } catch {
    return;
  }

  openPayload = file;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();

  try {
    const result = await win.webContents.executeJavaScript(OPEN_SCRIPT(path.basename(file)), true);
    if (result !== 'ok') console.warn('[archboard] 打开文件失败：', result);
  } catch (e) {
    console.warn('[archboard] 打开文件失败：', e && e.message);
  }
}

/** 从命令行参数里挑出要打开的工程文件（Windows / Linux 走这条路） */
function fileFromArgv(argv) {
  const wanted = /\.(archboard|json)$/i;
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (!arg || arg.startsWith('-') || !wanted.test(arg)) continue;
    const full = path.resolve(arg);
    try {
      if (statSync(full).isFile()) return full;
    } catch { /* 路径不存在就继续找 */ }
  }
  return null;
}

// macOS：双击文档、或把文档拖到 Dock 图标上，都走这个事件，
// 而且可能在 ready 之前就触发，所以必须早点注册。
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueOpen(filePath);
});

// 单实例：重复启动只聚焦已有窗口，不新开一个各存各的库
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    // 已经在运行时又双击了一个工程文件：Windows 会把路径塞进 argv
    const file = fileFromArgv(argv);
    if (file) queueOpen(file);
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';       // 原生对话框、滚动条跟深色界面对齐
    app.setAboutPanelOptions({
      applicationName: '无边画板',
      applicationVersion: app.getVersion(),
      credits: 'Boundless · maidong',
      copyright: '© maidong · github.com/Mr-Maidong',
    });

    protocol.handle(SCHEME, handleAppRequest);
    hardenSession();
    buildMenu();

    const win = createWindow();

    // 命令行里带了工程文件（Windows / Linux 的“打开方式”，或手动 electron . foo.archboard）
    const fromArgv = fileFromArgv(process.argv);
    if (fromArgv) queueOpen(fromArgv);

    // 自检钩子：BOUNDLESS_SMOKE=<输出目录> electron . 会截图并打印诊断后退出。
    // 只在打包之外的环境用，用来验证协议、IndexedDB、CompressionStream 是否正常。
    if (process.env.BOUNDLESS_SMOKE) runSmoke(win, process.env.BOUNDLESS_SMOKE);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/* ── 自检 ──────────────────────────────────────────────────────────────── */

async function runSmoke(win, outDir) {
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    // Electron 新旧签名兼容：(event, level, message, ...) 或 ({level, message})
    const first = args[0];
    const level = first && typeof first === 'object' && 'level' in first ? first.level : args[1];
    const message = first && typeof first === 'object' && 'message' in first ? first.message : args[2];
    if (level === 3 || level === 'error') errors.push(String(message));
  });

  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500));

    const probe = await win.webContents.executeJavaScript(`(async () => {
      const out = {
        origin: location.origin,
        title: document.title,
        viewport: innerWidth + 'x' + innerHeight + ' @' + devicePixelRatio + 'x',
        compression: typeof CompressionStream,
        api: typeof window.archboard,
        elements: window.archboard ? (archboard.state().elements || []).length : -1,
      };
      try {
        const req = indexedDB.open('smoke-probe', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('s');
        const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        const blob = new Blob([new Uint8Array(2 * 1024 * 1024)]);
        const tx = db.transaction('s', 'readwrite');
        tx.objectStore('s').put(blob, 'k');
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        const back = await new Promise((res, rej) => {
          const r = db.transaction('s').objectStore('s').get('k');
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        out.idbBlob = back && back.size === 2 * 1024 * 1024 ? 'ok 2MB' : 'size mismatch';
        db.close();
        indexedDB.deleteDatabase('smoke-probe');
      } catch (e) { out.idbBlob = 'fail: ' + e.message; }
      try {
        localStorage.setItem('__smoke', '1');
        out.localStorage = localStorage.getItem('__smoke') === '1' ? 'ok' : 'fail';
        localStorage.removeItem('__smoke');
      } catch (e) { out.localStorage = 'fail: ' + e.message; }
      return out;
    })()`, true);

    const img = await win.webContents.capturePage();
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'smoke.png'), img.toPNG());

    console.log('SMOKE ' + JSON.stringify({ probe, errors }, null, 1));
    app.quit();
  });
}
