const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveGitExecutable, gitNotFoundMessage } = require('./gitResolve.cjs');

/** 未在配置中填写推荐 JSON 地址时使用的内置 GET 源 */
const DEFAULT_MARKETPLACE_RECOMMEND_INDEX_URL =
  'https://raw.githubusercontent.com/alicfeng/skill_box/refs/heads/main/sub.json';

/**
 * @param {string} url
 * @returns {string}
 */
function validateGitUrl(url) {
  const u = String(url).trim();
  if (!u) {
    throw new Error('请输入 Git 地址');
  }
  if (/^https?:\/\/.+/i.test(u)) {
    return u;
  }
  if (/^git@[^:]+:.+/i.test(u)) {
    return u;
  }
  if (/^ssh:\/\//i.test(u)) {
    return u;
  }
  if (/^git:\/\//i.test(u)) {
    return u;
  }
  throw new Error('请使用 https://、http://、git@host:… 或 ssh:// 等 Git 远程地址');
}

/**
 * @param {string} userData
 */
function cacheRoot(userData) {
  return path.join(userData, 'marketplace_cache');
}

/**
 * @param {string} userData
 * @param {string} sourceId
 */
function sourcePath(userData, sourceId) {
  return path.join(cacheRoot(userData), sourceId);
}

/**
 * @param {string[]} args
 * @param {import('child_process').ExecFileOptions & { timeout?: number }} [opts]
 */
function runGit(args, opts = {}) {
  const { timeout = 120000, env: envExtra, ...rest } = opts;
  const gitExe = resolveGitExecutable();
  return new Promise((resolve, reject) => {
    execFile(
      gitExe,
      args,
      {
        ...rest,
        maxBuffer: 64 * 1024 * 1024,
        timeout,
        windowsHide: true,
        /** 禁止 Git 在终端索要账号密码，否则会一直卡住 */
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          /** 未设置时禁止 SSH 交互式密码，避免 pull 永远等待终端 */
          ...(process.env.GIT_SSH_COMMAND
            ? {}
            : { GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' }),
          ...envExtra,
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            reject(new Error(gitNotFoundMessage()));
            return;
          }
          /** Node 在 execFile 超时时会终止子进程，此时 err.killed 为 true（与普通 exit code 失败不同） */
          if (err.killed) {
            reject(
              new Error(
                `git 超过 ${Math.round(timeout / 1000)} 秒未完成，已自动终止。请检查网络、代理或仓库权限；私有库请配置 SSH/凭据（本应用不会弹出终端密码框）。`,
              ),
            );
            return;
          }
          const msg = (stderr && String(stderr).trim()) || err.message || 'git 命令失败';
          reject(new Error(msg));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/**
 * 浅克隆或 fast-forward 拉取（需本机已安装 git）
 * @param {string} url
 * @param {string} dest 克隆目标目录（最终为仓库根）
 */
async function cloneOrPull(url, dest) {
  const gitMarker = path.join(dest, '.git');
  if (fs.existsSync(gitMarker)) {
    await runGit(['-C', dest, 'pull', '--ff-only'], { timeout: 180000 });
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  await runGit(['clone', '--depth', '1', '--', url, dest], { timeout: 300000 });
}

/**
 * 推荐/订阅里「在克隆根内的 skills 子路径」，POSIX 风格，禁止 .. 与绝对路径
 * @param {unknown} raw
 * @returns {string} 规范化后相对路径，非法时返回 ''
 */
function normalizeSkillsSubpath(raw) {
  if (raw == null) return '';
  let s = String(raw).trim().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.some((p) => p === '.' || p === '..')) return '';
  return parts.join('/');
}

/**
 * GET JSON，解析为 { name, description, url, path }[]（url 为 Git 远程地址；path 为克隆根下扫描子目录，可空）
 * 支持根为数组，或含 sources / items / data 数组字段
 * @param {string} rawUrl
 * @returns {Promise<{ name: string, description: string, url: string, path: string }[]>}
 */
async function fetchRecommendationList(rawUrl) {
  const url = String(rawUrl || '').trim() || DEFAULT_MARKETPLACE_RECOMMEND_INDEX_URL;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('推荐接口地址不是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http:// 或 https:// 推荐接口');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
  } catch (e) {
    const name = e && typeof e === 'object' && 'name' in e ? e.name : '';
    if (name === 'AbortError') {
      throw new Error('请求推荐接口超时（20 秒）');
    }
    throw new Error(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`推荐接口返回 HTTP ${res.status}`);
  }

  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new Error('推荐接口返回的不是合法 JSON');
  }

  const arr = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? data.sources || data.items || data.data
      : null;
  if (!Array.isArray(arr)) {
    throw new Error('JSON 需为数组，或含有 sources / items / data 数组字段');
  }

  /** @type {{ name: string, description: string, url: string, path: string }[]} */
  const items = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const u = raw.url ?? raw.gitUrl ?? raw.repo;
    if (typeof u !== 'string' || !u.trim()) continue;
    let normalized;
    try {
      normalized = validateGitUrl(u.trim());
    } catch {
      continue;
    }
    const name =
      typeof raw.name === 'string'
        ? raw.name.trim()
        : typeof raw.title === 'string'
          ? raw.title.trim()
          : shortLabelFromUrl(normalized);
    const description =
      typeof raw.description === 'string'
        ? raw.description.trim()
        : typeof raw.desc === 'string'
          ? raw.desc.trim()
          : '';
    const pathField = raw.path ?? raw.skillsPath ?? raw.skills_path;
    const skillsPathRel =
      typeof pathField === 'string' ? normalizeSkillsSubpath(pathField) : '';
    items.push({
      name: name || shortLabelFromUrl(normalized),
      description,
      url: normalized,
      path: skillsPathRel,
    });
  }

  if (items.length === 0) {
    throw new Error('JSON 中未解析到任何有效的 Git 地址（url）');
  }
  return items;
}

/**
 * @param {string} gitUrl
 */
function shortLabelFromUrl(gitUrl) {
  try {
    const u = new URL(gitUrl);
    const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : gitUrl;
  } catch {
    return gitUrl;
  }
}

module.exports = {
  validateGitUrl,
  normalizeSkillsSubpath,
  cacheRoot,
  sourcePath,
  cloneOrPull,
  fetchRecommendationList,
  DEFAULT_MARKETPLACE_RECOMMEND_INDEX_URL,
};
