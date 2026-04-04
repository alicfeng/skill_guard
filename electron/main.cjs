const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const skillGuard = require('./skillGuard.cjs');
const marketplace = require('./marketplace.cjs');
const { getCurrentBranch } = require('./gitBranch.cjs');

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

/** 与 wait-on 一致用 127.0.0.1，避免 localhost→IPv6 与 Vite 监听不一致导致永远等不到端口 */
const DEV_SERVER_URL = 'http://127.0.0.1:5173';

/** childAbs 在 parentAbs 目录下或与其相同（均 path.resolve） */
function isResolvedUnderOrEqual(parentAbs, childAbs) {
  const p = path.resolve(parentAbs);
  const c = path.resolve(childAbs);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/** 自动维护定时器间隔：含可选 git pull + 可选覆盖已安装技能（毫秒） */
const AUTO_PULL_INTERVAL_MS = 30 * 60 * 1000;
/** 启动后延迟再执行首次自动拉取/更新，避免与窗口初始化抢资源 */
const AUTO_MAINTENANCE_STARTUP_DELAY_MS = 10000;

function defaultConfig() {
  return {
    repos: [],
    marketplaceSources: [],
    marketplaceRecommendIndexUrl: '',
    autoUpdateInstalledSkills: false,
    autoPullMarketplaceSources: false,
  };
}

function loadConfig() {
  const defaults = defaultConfig();
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return { ...defaults };
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      repos: Array.isArray(data.repos) ? data.repos : defaults.repos,
      marketplaceSources: Array.isArray(data.marketplaceSources)
        ? data.marketplaceSources
        : defaults.marketplaceSources,
      marketplaceRecommendIndexUrl:
        typeof data.marketplaceRecommendIndexUrl === 'string'
          ? data.marketplaceRecommendIndexUrl
          : defaults.marketplaceRecommendIndexUrl,
      theme: data.theme === 'light' || data.theme === 'dark' ? data.theme : undefined,
      autoUpdateInstalledSkills:
        typeof data.autoUpdateInstalledSkills === 'boolean'
          ? data.autoUpdateInstalledSkills
          : defaults.autoUpdateInstalledSkills,
      autoPullMarketplaceSources:
        typeof data.autoPullMarketplaceSources === 'boolean'
          ? data.autoPullMarketplaceSources
          : defaults.autoPullMarketplaceSources,
    };
  } catch {
    return { ...defaults };
  }
}

/** @type {ReturnType<typeof setInterval> | null} */
let autoMaintenanceIntervalId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let autoMaintenanceStartupTimerId = null;

async function pullAllMarketplaceSourcesQuiet() {
  const cfg = loadConfig();
  if (!cfg.autoPullMarketplaceSources || cfg.marketplaceSources.length === 0) return;
  const userData = app.getPath('userData');
  let changed = false;
  const next = {
    ...cfg,
    marketplaceSources: cfg.marketplaceSources.map((s) => ({ ...s })),
  };
  for (const s of next.marketplaceSources) {
    const dest = marketplace.sourcePath(userData, s.id);
    try {
      await marketplace.cloneOrPull(s.url, dest);
      s.lastPulledAt = new Date().toISOString();
      changed = true;
    } catch (e) {
      console.warn(
        '[Skill Guard] 定时拉取订阅失败:',
        s.url,
        e instanceof Error ? e.message : e,
      );
    }
  }
  if (changed) writeConfigToDisk(next);
}

async function applyAutoUpdatesToInstalledSkills() {
  const cfg = loadConfig();
  if (!cfg.autoUpdateInstalledSkills) return;
  if (!cfg.marketplaceSources.length) return;

  const userData = app.getPath('userData');
  const { skills: mpSkills } = await buildMarketplaceSkillsList(userData, cfg.marketplaceSources);
  const homedirAbs = os.homedir();

  function installOne(u) {
    skillGuard.installMarketplaceSkill({
      marketplaceRootAbs: path.resolve(u.marketplaceRootPath),
      skillRelPosix: u.skillRelPath,
      installCursor: u.installCursor,
      installCodex: u.installCodex,
      installClaude: u.installClaude,
      scope: u.scope,
      repoRootAbs: u.scope === 'repo' && u.repoPath ? path.resolve(u.repoPath) : undefined,
      homedirAbs,
    });
  }

  try {
    const scan = await skillGuard.scanGlobal();
    const globalWith = skillGuard.attachMarketplaceUpdateToInstalledSkills(
      scan.root,
      scan.skills,
      mpSkills,
    );
    for (const sk of globalWith) {
      if (!sk.updateFromMarketplace) continue;
      try {
        installOne(sk.updateFromMarketplace);
      } catch (e) {
        console.warn(
          '[Skill Guard] 自动更新全局技能失败:',
          sk.name,
          e instanceof Error ? e.message : e,
        );
      }
    }
  } catch (e) {
    console.warn('[Skill Guard] 自动更新：全局扫描失败', e instanceof Error ? e.message : e);
  }

  for (const r of cfg.repos) {
    const q = getRepoQueue(r.path);
    await q(async () => {
      try {
        const scan = await skillGuard.scanRepo(r.path);
        const repoWith = skillGuard.attachMarketplaceUpdateToInstalledSkills(
          scan.root,
          scan.skills,
          mpSkills,
        );
        for (const sk of repoWith) {
          if (!sk.updateFromMarketplace) continue;
          try {
            installOne(sk.updateFromMarketplace);
          } catch (e) {
            console.warn(
              '[Skill Guard] 自动更新仓库技能失败:',
              r.path,
              sk.name,
              e instanceof Error ? e.message : e,
            );
          }
        }
      } catch (e) {
        console.warn(
          '[Skill Guard] 自动更新：仓库扫描失败',
          r.path,
          e instanceof Error ? e.message : e,
        );
      }
    });
  }
}

async function runAutoMaintenanceOnce() {
  try {
    let cfg = loadConfig();
    if (cfg.autoPullMarketplaceSources && cfg.marketplaceSources.length > 0) {
      await pullAllMarketplaceSourcesQuiet();
    }
    cfg = loadConfig();
    if (cfg.autoUpdateInstalledSkills) {
      await applyAutoUpdatesToInstalledSkills();
    }
  } catch (e) {
    console.warn('[Skill Guard] 自动维护执行异常', e instanceof Error ? e.message : e);
  }
}

function scheduleAutoMaintenance() {
  if (autoMaintenanceIntervalId != null) {
    clearInterval(autoMaintenanceIntervalId);
    autoMaintenanceIntervalId = null;
  }
  if (autoMaintenanceStartupTimerId != null) {
    clearTimeout(autoMaintenanceStartupTimerId);
    autoMaintenanceStartupTimerId = null;
  }

  const cfg = loadConfig();
  const pullOn = cfg.autoPullMarketplaceSources && cfg.marketplaceSources.length > 0;
  const updateOn = cfg.autoUpdateInstalledSkills;
  if (!pullOn && !updateOn) return;

  autoMaintenanceStartupTimerId = setTimeout(() => {
    autoMaintenanceStartupTimerId = null;
    void runAutoMaintenanceOnce();
  }, AUTO_MAINTENANCE_STARTUP_DELAY_MS);

  /** 仅开「自动更新」时也必须定时跑，否则只在启动后约 10 秒执行一次，之后永不再同步 */
  if (pullOn || updateOn) {
    autoMaintenanceIntervalId = setInterval(() => void runAutoMaintenanceOnce(), AUTO_PULL_INTERVAL_MS);
  }
}

/**
 * @param {string} userData
 * @param {{ id: string; url: string; skillsPath?: string }[]} sources
 * @returns {Promise<{ skills: unknown[], issues: string[] }>}
 */
async function buildMarketplaceSkillsList(userData, sources) {
  const skills = [];
  const issues = [];
  const fgOpts = { caseSensitiveMatch: false };

  for (const s of sources) {
    const dest = marketplace.sourcePath(userData, s.id);
    if (!fs.existsSync(path.join(dest, '.git'))) {
      issues.push(
        `「${s.url}」本地缓存不是有效的 Git 克隆（缺少 .git），请从列表中移除后重新添加。`,
      );
      continue;
    }

    const subRaw = typeof s.skillsPath === 'string' ? s.skillsPath.trim() : '';
    let scanRoot = dest;
    let patterns = skillGuard.MARKETPLACE_SKILL_PATTERNS;
    /** @type {string} 用于提示文案 */
    let skillsSubdirLabel = '';
    if (subRaw) {
      const sub = marketplace.normalizeSkillsSubpath(subRaw);
      if (!sub) {
        issues.push(`「${s.url}」skillsPath 无效，已跳过该订阅源。`);
        continue;
      }
      skillsSubdirLabel = sub;
      scanRoot = path.join(dest, ...sub.split('/'));
      if (!isResolvedUnderOrEqual(dest, scanRoot)) {
        issues.push(`「${s.url}」skillsPath 越界，已跳过该订阅源。`);
        continue;
      }
      if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
        issues.push(
          `「${s.url}」缓存内不存在目录「${sub}」。请核对推荐 JSON 的 path 与仓库结构，或重新拉取。`,
        );
        continue;
      }
      patterns = ['**/SKILL.md'];
    }

    try {
      const scan = await skillGuard.scanSkills(scanRoot, patterns, fgOpts);
      const before = skills.length;
      for (const sk of scan.skills) {
        skills.push({
          ...sk,
          id: `${s.id}_${sk.id}`,
          marketplaceSourceId: s.id,
          marketplaceSourceUrl: s.url,
          marketplaceRootPath: scanRoot,
        });
      }
      if (skills.length === before) {
        const hint = skillsSubdirLabel
          ? `已在子目录「${skillsSubdirLabel}」下递归查找 SKILL.md。`
          : '请确认仓库根目录存在 skills/、.cursor/skills、.cursor/skills-cursor、.codex/skills 或 .claude/skills，且其中包含 SKILL.md（文件名大小写不敏感）。';
        issues.push(`「${s.url}」未匹配到任何 SKILL.md。${hint}`);
      }
    } catch (e) {
      issues.push(
        `「${s.url}」扫描失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { skills, issues };
}

function writeConfigToDisk(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

function saveConfig(cfg) {
  writeConfigToDisk(cfg);
  scheduleAutoMaintenance();
}

/** @type {Map<string, (fn: () => Promise<unknown>) => Promise<unknown>>} */
const repoQueues = new Map();

function getRepoQueue(repoRoot) {
  const key = path.resolve(repoRoot);
  if (!repoQueues.has(key)) {
    let tail = Promise.resolve();
    const run = (fn) => {
      const next = tail.then(() => fn());
      tail = next.catch(() => {});
      return next;
    };
    repoQueues.set(key, run);
  }
  return repoQueues.get(key);
}

function windowIconPath() {
  const p = path.join(__dirname, '..', 'build', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function createWindow() {
  const icon = windowIconPath();
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    title: 'Skill Guard',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(null);
  }
  createWindow();
  scheduleAutoMaintenance();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 关闭最后一个窗口即退出进程（含 macOS 红绿灯关闭），避免用户以为已退出但 Dock 里仍在运行
app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('app:userProfile', () => {
  const info = os.userInfo();
  return {
    username: info.username || path.basename(os.homedir()) || 'user',
    homedir: os.homedir(),
  };
});

ipcMain.handle('app:version', () => app.getVersion());

/** 保存设置等场景下立即执行一轮拉取（若开启）+ 自动覆盖已安装技能（若开启） */
ipcMain.handle('app:runAutoMaintenance', async () => {
  await runAutoMaintenanceOnce();
  return { ok: true };
});

ipcMain.handle('config:load', () => loadConfig());

ipcMain.handle('config:save', (_e, cfg) => {
  saveConfig(cfg);
  return { ok: true };
});

ipcMain.handle('dialog:pickRepo', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('repos:add', (_e, dirPath) => {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Not a directory');
  }
  const cfg = loadConfig();
  if (cfg.repos.some((r) => path.resolve(r.path) === resolved)) {
    return cfg;
  }
  const crypto = require('crypto');
  cfg.repos.push({
    id: crypto.randomUUID(),
    path: resolved,
    name: path.basename(resolved),
  });
  saveConfig(cfg);
  return cfg;
});

ipcMain.handle('repos:remove', (_e, id) => {
  const cfg = loadConfig();
  cfg.repos = cfg.repos.filter((r) => r.id !== id);
  saveConfig(cfg);
  return cfg;
});

ipcMain.handle('git:currentBranch', async (_e, repoPath) => {
  return getCurrentBranch(repoPath);
});

ipcMain.handle('skills:scan', async (_e, repoPath) => {
  const result = await skillGuard.scanRepo(repoPath);
  const cfg = loadConfig();
  const userData = app.getPath('userData');
  const { skills: mpSkills } = await buildMarketplaceSkillsList(userData, cfg.marketplaceSources ?? []);
  result.skills = skillGuard.attachMarketplaceUpdateToInstalledSkills(result.root, result.skills, mpSkills);
  return result;
});

ipcMain.handle('skills:scanGlobal', async () => {
  const result = await skillGuard.scanGlobal();
  const cfg = loadConfig();
  const userData = app.getPath('userData');
  const { skills: mpSkills } = await buildMarketplaceSkillsList(userData, cfg.marketplaceSources ?? []);
  result.skills = skillGuard.attachMarketplaceUpdateToInstalledSkills(result.root, result.skills, mpSkills);
  return result;
});

ipcMain.handle('skills:disable', async (_e, { repoPath, skillRelPath }) => {
  const q = getRepoQueue(repoPath);
  return q(() => Promise.resolve(skillGuard.disableSkill(repoPath, skillRelPath)));
});

ipcMain.handle('skills:enable', async (_e, { repoPath, entryId }) => {
  const q = getRepoQueue(repoPath);
  return q(() => Promise.resolve(skillGuard.enableSkill(repoPath, entryId)));
});

ipcMain.handle('skills:delete', async (_e, { rootPath, skillRelPath, state }) => {
  if (typeof rootPath !== 'string' || typeof skillRelPath !== 'string') {
    throw new Error('Invalid delete request');
  }
  if (state !== 'enabled' && state !== 'disabled') {
    throw new Error('Invalid skill state');
  }
  const resolved = path.resolve(rootPath);
  const homeResolved = path.resolve(os.homedir());
  if (resolved === homeResolved) {
    return skillGuard.deleteSkill(resolved, skillRelPath, state);
  }
  const q = getRepoQueue(resolved);
  return q(() => Promise.resolve(skillGuard.deleteSkill(resolved, skillRelPath, state)));
});

ipcMain.handle('skills:listTree', async (_e, { rootPath, skillRelPath, state }) => {
  return skillGuard.listSkillTree(rootPath, skillRelPath, state);
});

ipcMain.handle('skills:readFile', async (_e, { rootPath, skillRelPath, state, fileRel }) => {
  return skillGuard.readSkillFile(rootPath, skillRelPath, state, fileRel);
});

ipcMain.handle('marketplace:load', async () => {
  const cfg = loadConfig();
  const userData = app.getPath('userData');
  const { skills, issues } = await buildMarketplaceSkillsList(userData, cfg.marketplaceSources);
  return { sources: cfg.marketplaceSources, skills, issues };
});

ipcMain.handle('marketplace:fetchRecommendations', async () => {
  const cfg = loadConfig();
  const indexUrl = cfg.marketplaceRecommendIndexUrl || '';
  const items = await marketplace.fetchRecommendationList(indexUrl);
  return { items };
});

ipcMain.handle('marketplace:addSource', async (_e, payload) => {
  let urlRaw;
  let skillsPathOpt = '';
  /** @type {'manual' | 'recommend'} */
  let sourceOrigin = 'manual';
  if (typeof payload === 'string') {
    urlRaw = payload;
  } else if (payload && typeof payload === 'object' && typeof payload.url === 'string') {
    urlRaw = payload.url;
    if (typeof payload.skillsPath === 'string' && payload.skillsPath.trim()) {
      const sub = marketplace.normalizeSkillsSubpath(payload.skillsPath);
      if (!sub) {
        throw new Error('skills 子路径无效：不能包含 .. 等非法段');
      }
      skillsPathOpt = sub;
    }
    if (payload.sourceOrigin === 'recommend' || payload.sourceOrigin === 'manual') {
      sourceOrigin = payload.sourceOrigin;
    }
  } else {
    throw new Error('无效的添加订阅参数');
  }

  const normalized = marketplace.validateGitUrl(urlRaw);
  const cfg = loadConfig();
  if (
    cfg.marketplaceSources.some(
      (x) => x.url === normalized && (x.skillsPath || '') === skillsPathOpt,
    )
  ) {
    throw new Error('该 Git 地址与扫描路径的组合已在列表中');
  }
  const crypto = require('crypto');
  const id = crypto.randomUUID();
  const userData = app.getPath('userData');
  const dest = marketplace.sourcePath(userData, id);
  await marketplace.cloneOrPull(normalized, dest);
  const now = new Date().toISOString();
  /** @type {{ id: string; url: string; lastPulledAt: string; skillsPath?: string; sourceOrigin?: 'manual' | 'recommend' }} */
  const entry = { id, url: normalized, lastPulledAt: now, sourceOrigin };
  if (skillsPathOpt) entry.skillsPath = skillsPathOpt;
  cfg.marketplaceSources.push(entry);
  saveConfig(cfg);
  const { skills, issues } = await buildMarketplaceSkillsList(userData, cfg.marketplaceSources);
  return { config: cfg, skills, issues };
});

ipcMain.handle('marketplace:removeSource', async (_e, sourceId) => {
  const cfg = loadConfig();
  const idx = cfg.marketplaceSources.findIndex((s) => s.id === sourceId);
  if (idx === -1) throw new Error('未找到该 Skill 源');
  cfg.marketplaceSources.splice(idx, 1);
  saveConfig(cfg);
  const userData = app.getPath('userData');
  const dest = marketplace.sourcePath(userData, sourceId);
  try {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
  const { skills, issues } = await buildMarketplaceSkillsList(userData, cfg.marketplaceSources);
  return { config: cfg, skills, issues };
});

ipcMain.handle('marketplace:refreshRemote', async () => {
  const cfg = loadConfig();
  const userData = app.getPath('userData');
  for (const s of cfg.marketplaceSources) {
    const dest = marketplace.sourcePath(userData, s.id);
    try {
      await marketplace.cloneOrPull(s.url, dest);
      s.lastPulledAt = new Date().toISOString();
    } catch (e) {
      throw new Error(`更新失败（${s.url}）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  saveConfig(cfg);
  const { skills, issues } = await buildMarketplaceSkillsList(userData, cfg.marketplaceSources);
  if (loadConfig().autoUpdateInstalledSkills) {
    await applyAutoUpdatesToInstalledSkills();
  }
  return { config: cfg, skills, issues };
});

ipcMain.handle('marketplace:installSkill', async (_e, body) => {
  const marketplaceRootPath = body?.marketplaceRootPath;
  const skillRelPath = body?.skillRelPath;
  const installCursor = !!body?.installCursor;
  const installCodex = !!body?.installCodex;
  const installClaude = !!body?.installClaude;
  const scope = body?.scope === 'repo' ? 'repo' : 'global';
  const repoPath = body?.repoPath;

  if (typeof marketplaceRootPath !== 'string' || typeof skillRelPath !== 'string') {
    throw new Error('Invalid install request');
  }

  const cfg = loadConfig();
  const userData = app.getPath('userData');
  const rootResolved = path.resolve(marketplaceRootPath);
  const allowed = cfg.marketplaceSources.some((s) => {
    const d = marketplace.sourcePath(userData, s.id);
    return isResolvedUnderOrEqual(d, rootResolved);
  });
  if (!allowed) {
    throw new Error('Unknown marketplace cache directory');
  }

  let repoRootAbs;
  if (scope === 'repo') {
    if (typeof repoPath !== 'string' || !repoPath.trim()) {
      throw new Error('Select a repository');
    }
    const hit = cfg.repos.find((r) => path.resolve(r.path) === path.resolve(repoPath));
    if (!hit) throw new Error('Repository is not in the app list');
    repoRootAbs = path.resolve(hit.path);
  }

  const payload = {
    marketplaceRootAbs: rootResolved,
    skillRelPosix: skillRelPath,
    installCursor,
    installCodex,
    installClaude,
    scope,
    repoRootAbs,
    homedirAbs: os.homedir(),
  };

  if (scope === 'repo') {
    const q = getRepoQueue(repoRootAbs);
    return q(() => Promise.resolve(skillGuard.installMarketplaceSkill(payload)));
  }

  return skillGuard.installMarketplaceSkill(payload);
});
