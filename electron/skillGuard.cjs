const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fg = require('fast-glob');

const MANIFEST_VERSION = 1;
const GUARD_DIR = '.skill_guard';
const DISABLED_SUB = 'disabled';

/** 用户主目录下：Cursor / Codex / Claude Code 全局 skills */
const GLOBAL_SKILL_PATTERNS = [
  '.codex/skills/**/SKILL.md',
  '.cursor/skills/**/SKILL.md',
  '.cursor/skills-cursor/**/SKILL.md',
  '.claude/skills/**/SKILL.md',
];

/** 仓库内任意深度的 skills */
const REPO_SKILL_PATTERNS = [
  '**/.cursor/skills/**/SKILL.md',
  '**/.cursor/skills-cursor/**/SKILL.md',
  '**/.codex/skills/**/SKILL.md',
  '**/.claude/skills/**/SKILL.md',
];

/**
 * Git Marketplace 克隆根目录下检索 SKILL.md：
 * - 优先约定：顶层 skills/
 * - 兼容：根下 .cursor/skills、.cursor/skills-cursor、.codex/skills、.claude/skills（与本地扫描一致）
 */
const MARKETPLACE_SKILL_PATTERNS = [
  'skills/**/SKILL.md',
  '.cursor/skills/**/SKILL.md',
  '.cursor/skills-cursor/**/SKILL.md',
  '.codex/skills/**/SKILL.md',
  '.claude/skills/**/SKILL.md',
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function guardRoot(repoRoot) {
  return path.join(repoRoot, GUARD_DIR);
}

function manifestPath(repoRoot) {
  return path.join(guardRoot(repoRoot), 'manifest.json');
}

function readManifest(repoRoot) {
  const mp = manifestPath(repoRoot);
  if (!fs.existsSync(mp)) {
    return { version: MANIFEST_VERSION, entries: [] };
  }
  try {
    const raw = fs.readFileSync(mp, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries)) data.entries = [];
    return data;
  } catch {
    return { version: MANIFEST_VERSION, entries: [] };
  }
}

function writeManifest(repoRoot, manifest) {
  const dir = guardRoot(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(repoRoot), JSON.stringify(manifest, null, 2), 'utf8');
}

/** @param {string} repoRoot @param {string} absPath */
function assertUnderRepoRoot(repoRoot, absPath) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(absPath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes repository root');
  }
}

/** @param {string} src @param {string} dest */
function movePath(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e && (e.code === 'EXDEV' || e.code === 'EPERM')) {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
}

function stableId(relPosix) {
  return crypto.createHash('sha256').update(relPosix).digest('hex').slice(0, 16);
}

/** 按技能名称字母序（不区分大小写、数字按数值），同名再按相对路径稳定排序 */
function sortSkillsByNameAndPath(skills) {
  return [...skills].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    if (byName !== 0) return byName;
    return a.relPath.localeCompare(b.relPath, undefined, { sensitivity: 'base', numeric: true });
  });
}

/** @param {string} posixRel path segments joined by / */
function joinFromRepoRoot(repoRoot, posixRel) {
  if (!posixRel) return repoRoot;
  const parts = posixRel.split('/').filter(Boolean);
  return path.join(repoRoot, ...parts);
}

/**
 * @param {string} rootPath 扫描根目录（仓库根或用户主目录）
 * @param {string[]} patterns fast-glob 模式，相对 rootPath
 * @param {object} [fgExtra] 传给 fast-glob 的额外选项（如 caseSensitiveMatch）
 * @returns {Promise<{ root: string, skills: Array<{ id: string, relPath: string, name: string, state: 'enabled'|'disabled', disabledAt?: string }> }>}
 */
async function scanSkills(rootPath, patterns, fgExtra = {}) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('Root path is not a directory');
  }

  const ignore = ['**/node_modules/**', '**/.git/**', '**/.skill_guard/**'];

  const files = await fg(patterns, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore,
    dot: true,
    ...fgExtra,
    /** 路径上若有同名文件（如 .claude/skills 为文件而非目录），避免 scandir ENOTDIR 导致整次扫描失败 */
    suppressErrors: true,
  });

  const enabled = [];
  const seenRel = new Set();

  for (const file of files) {
    const skillDir = path.dirname(file);
    const rel = toPosix(path.relative(root, skillDir));
    if (seenRel.has(rel)) continue;
    seenRel.add(rel);
    enabled.push({
      id: stableId(rel),
      relPath: rel,
      name: path.basename(skillDir),
      state: 'enabled',
    });
  }

  const manifest = readManifest(root);
  const disabled = [];
  for (const e of manifest.entries) {
    const storedAbs = joinFromRepoRoot(root, e.storedRelPath);
    if (fs.existsSync(storedAbs)) {
      disabled.push({
        id: e.id,
        relPath: toPosix(e.originalRelPath),
        name: path.basename(e.originalRelPath),
        state: 'disabled',
        disabledAt: e.disabledAt,
      });
    }
  }

  const skills = sortSkillsByNameAndPath([...enabled, ...disabled]);
  return { root, skills };
}

/**
 * @param {string} repoRoot
 */
async function scanRepo(repoRoot) {
  return scanSkills(repoRoot, REPO_SKILL_PATTERNS);
}

/**
 * 当前用户主目录下的全局 skills（~/.cursor/skills、~/.cursor/skills-cursor、~/.codex/skills、~/.claude/skills）
 */
async function scanGlobal() {
  return scanSkills(os.homedir(), GLOBAL_SKILL_PATTERNS);
}

/**
 * @param {string} repoRoot
 * @param {string} skillRelPathPosix e.g. .cursor/skills/foo 或 .cursor/skills-cursor/foo
 */
function disableSkill(repoRoot, skillRelPathPosix) {
  const root = path.resolve(repoRoot);
  const normalized = toPosix(skillRelPathPosix).replace(/^\/+/, '');
  const src = joinFromRepoRoot(root, normalized);

  assertUnderRepoRoot(root, src);

  if (!fs.existsSync(src)) {
    throw new Error('Skill path does not exist');
  }

  const relPosix = toPosix(path.relative(root, path.resolve(src)));
  if (relPosix.includes('..') || relPosix.startsWith('.skill_guard')) {
    throw new Error('Invalid skill path');
  }

  const storedRelPosix = `${GUARD_DIR}/${DISABLED_SUB}/${relPosix}`;
  const dest = joinFromRepoRoot(root, storedRelPosix);

  assertUnderRepoRoot(root, dest);

  if (fs.existsSync(dest)) {
    throw new Error('Backup destination already exists');
  }

  movePath(src, dest);

  const manifest = readManifest(root);
  const id = crypto.randomUUID();
  manifest.entries.push({
    id,
    originalRelPath: relPosix,
    storedRelPath: storedRelPosix,
    disabledAt: new Date().toISOString(),
  });
  writeManifest(root, manifest);

  return { id, originalRelPath: relPosix, storedRelPath: storedRelPosix };
}

/**
 * @param {string} repoRoot
 * @param {string} entryId manifest entry uuid
 */
function enableSkill(repoRoot, entryId) {
  const root = path.resolve(repoRoot);
  const manifest = readManifest(root);
  const idx = manifest.entries.findIndex((e) => e.id === entryId);
  if (idx === -1) throw new Error('Manifest entry not found');

  const entry = manifest.entries[idx];
  const src = joinFromRepoRoot(root, entry.storedRelPath);
  const dest = joinFromRepoRoot(root, entry.originalRelPath);

  if (!fs.existsSync(src)) {
    throw new Error('Stored skill is missing on disk');
  }
  if (fs.existsSync(dest)) {
    throw new Error('Original path already exists; resolve conflict manually');
  }

  assertUnderRepoRoot(root, src);
  assertUnderRepoRoot(root, dest);

  movePath(src, dest);
  manifest.entries.splice(idx, 1);
  writeManifest(root, manifest);

  return { ok: true };
}

const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

/**
 * 技能目录绝对路径（启用 / 禁用镜像）
 */
function getSkillDirAbs(rootPath, skillRelPathPosix, state) {
  const root = path.resolve(rootPath);
  const rel = toPosix(skillRelPathPosix).replace(/^\/+/, '');
  const parts = rel.split('/').filter(Boolean);
  if (state === 'disabled') {
    return path.join(root, GUARD_DIR, DISABLED_SUB, ...parts);
  }
  return path.join(root, ...parts);
}

function assertUnderSkillDir(skillDirAbs, targetAbs) {
  const base = path.resolve(skillDirAbs);
  const target = path.resolve(targetAbs);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes skill directory');
  }
}

/**
 * @returns {Array<{ type: 'file'|'dir', name: string, relPath: string, children?: unknown }>}
 */
function listSkillTree(rootPath, skillRelPathPosix, state) {
  const root = path.resolve(rootPath);
  const skillDir = getSkillDirAbs(rootPath, skillRelPathPosix, state);
  assertUnderRepoRoot(root, skillDir);
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    throw new Error('技能目录不存在');
  }

  function walk(dirAbs) {
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    const nodes = [];
    for (const ent of entries) {
      if (ent.name === '.DS_Store') continue;
      if (ent.isDirectory() && SKIP_DIR_NAMES.has(ent.name)) continue;
      const abs = path.join(dirAbs, ent.name);
      const relPath = toPosix(path.relative(skillDir, abs));
      if (ent.isDirectory()) {
        nodes.push({
          type: 'dir',
          name: ent.name,
          relPath,
          children: walk(abs),
        });
      } else {
        nodes.push({
          type: 'file',
          name: ent.name,
          relPath,
        });
      }
    }
    return nodes;
  }

  return walk(skillDir);
}

const MAX_SKILL_FILE_BYTES = 3 * 1024 * 1024;

const IMAGE_EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

/**
 * @returns {{ kind: 'image', mime: string, base64: string } | { kind: 'text', content: string, ext: string }}
 */
function hasSkillMdInDir(dirAbs) {
  try {
    const names = fs.readdirSync(dirAbs);
    return names.some((n) => n.toLowerCase() === 'skill.md');
  } catch {
    return false;
  }
}

const SIG_IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
const SIG_MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * 递归收集技能目录下文件（用于与已安装副本比对是否可更新）
 * @param {string} dirAbs
 * @returns {Array<{ rel: string, abs: string }>}
 */
function collectFilesForSignature(dirAbs) {
  const root = path.resolve(dirAbs);
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SIG_IGNORE_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        const rel = toPosix(path.relative(root, full));
        if (rel.startsWith('..')) continue;
        out.push({ rel, abs: full });
      }
    }
  }
  walk(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * 技能目录内容签名（与已安装目录对比；大文件只纳入 size+mtime 避免内存爆）
 * @param {string} dirAbs
 */
function directoryContentSignature(dirAbs) {
  const items = collectFilesForSignature(dirAbs);
  const h = crypto.createHash('sha256');
  for (const { rel, abs } of items) {
    h.update(rel);
    h.update('\0');
    try {
      const st = fs.statSync(abs);
      if (st.size > SIG_MAX_FILE_BYTES) {
        h.update(`large:${st.size}:${st.mtimeMs}`);
      } else {
        h.update(fs.readFileSync(abs));
      }
    } catch {
      h.update('read-error');
    }
    h.update('\0');
  }
  return h.digest('hex');
}

/** 从已安装技能的 relPath 推断安装时写入了哪些平台目录（与 installMarketplaceSkill 目标一致） */
function detectInstallFlagsFromSkillRel(relPosix) {
  const n = toPosix(relPosix).replace(/^\/+/, '');
  return {
    installCursor:
      /(^|\/)\.cursor\/skills\//.test(n) || /(^|\/)\.cursor\/skills-cursor\//.test(n),
    installCodex: /(^|\/)\.codex\/skills\//.test(n),
    installClaude: /(^|\/)\.claude\/skills\//.test(n),
  };
}

/**
 * 为全局/仓库扫描结果中的已启用技能附加：订阅缓存与本机该目录内容是否不一致，及一键覆盖安装所需参数。
 * @param {string} installRootAbs 扫描根（用户主目录或仓库根）
 * @param {Array<{ id: string, relPath: string, name: string, state: string }>} skills
 * @param {Array<{ name: string, relPath: string, marketplaceRootPath: string }>} mpSkills 订阅源扫描列表（无 update 标记）
 */
function attachMarketplaceUpdateToInstalledSkills(installRootAbs, skills, mpSkills) {
  const root = path.resolve(installRootAbs);
  const homeResolved = path.resolve(os.homedir());
  const scope = root === homeResolved ? 'global' : 'repo';

  return skills.map((skill) => {
    if (skill.state !== 'enabled') {
      return { ...skill };
    }
    if (!isRemovableEnabledSkillRel(skill.relPath)) {
      return { ...skill };
    }

    const flags = detectInstallFlagsFromSkillRel(skill.relPath);
    if (!flags.installCursor && !flags.installCodex && !flags.installClaude) {
      return { ...skill };
    }

    const installedAbs = getSkillDirAbs(root, skill.relPath, 'enabled');
    if (!fs.existsSync(installedAbs) || !fs.statSync(installedAbs).isDirectory() || !hasSkillMdInDir(installedAbs)) {
      return { ...skill };
    }

    let installedSig;
    try {
      installedSig = directoryContentSignature(installedAbs);
    } catch {
      return { ...skill };
    }

    const candidates = mpSkills.filter((m) => m.name === skill.name);
    for (const m of candidates) {
      const rootM = path.resolve(m.marketplaceRootPath);
      const relParts = toPosix(m.relPath).replace(/^\/+/, '').split('/').filter(Boolean);
      if (relParts.length === 0 || relParts.some((p) => p === '..' || p === '.')) continue;

      const srcAbs = path.resolve(path.join(rootM, ...relParts));
      const relFromM = path.relative(rootM, srcAbs);
      if (relFromM.startsWith('..') || path.isAbsolute(relFromM)) continue;
      if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isDirectory() || !hasSkillMdInDir(srcAbs)) {
        continue;
      }

      let srcSig;
      try {
        srcSig = directoryContentSignature(srcAbs);
      } catch {
        continue;
      }
      if (srcSig === installedSig) continue;

      return {
        ...skill,
        updateAvailable: true,
        updateFromMarketplace: {
          marketplaceRootPath: m.marketplaceRootPath,
          skillRelPath: m.relPath,
          installCursor: flags.installCursor,
          installCodex: flags.installCodex,
          installClaude: flags.installClaude,
          scope,
          repoPath: scope === 'repo' ? root : undefined,
        },
      };
    }

    return { ...skill };
  });
}

/**
 * 从 Marketplace 克隆目录拷贝技能文件夹到全局或仓库下的 .cursor（skills-cursor）/ .codex / .claude skills。
 * @param {{
 *   marketplaceRootAbs: string;
 *   skillRelPosix: string;
 *   installCursor: boolean;
 *   installCodex: boolean;
 *   installClaude: boolean;
 *   scope: 'global' | 'repo';
 *   repoRootAbs?: string;
 *   homedirAbs: string;
 * }} opts
 */
function installMarketplaceSkill(opts) {
  const {
    marketplaceRootAbs,
    skillRelPosix,
    installCursor,
    installCodex,
    installClaude,
    scope,
    repoRootAbs,
    homedirAbs,
  } = opts;

  if (!installCursor && !installCodex && !installClaude) {
    throw new Error('请至少选择 Cursor、Codex 或 Claude 中的一项');
  }

  const normalizedRel = toPosix(skillRelPosix).replace(/^\/+/, '');
  const parts = normalizedRel.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '.')) {
    throw new Error('Invalid skill path');
  }
  const skillFolderName = parts[parts.length - 1];

  const rootM = path.resolve(marketplaceRootAbs);
  const srcAbs = path.resolve(path.join(rootM, ...parts));
  const relFromRoot = path.relative(rootM, srcAbs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error('Skill path escapes marketplace root');
  }

  if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isDirectory()) {
    throw new Error('Skill folder not found in marketplace cache');
  }
  if (!hasSkillMdInDir(srcAbs)) {
    throw new Error('SKILL.md not found in skill folder');
  }

  const targets = [];
  if (scope === 'global') {
    const h = path.resolve(homedirAbs);
    if (installCursor) targets.push(path.join(h, '.cursor', 'skills-cursor', skillFolderName));
    if (installCodex) targets.push(path.join(h, '.codex', 'skills', skillFolderName));
    if (installClaude) targets.push(path.join(h, '.claude', 'skills', skillFolderName));
  } else {
    if (!repoRootAbs) throw new Error('Repository path is required');
    const r = path.resolve(repoRootAbs);
    if (installCursor) targets.push(path.join(r, '.cursor', 'skills-cursor', skillFolderName));
    if (installCodex) targets.push(path.join(r, '.codex', 'skills', skillFolderName));
    if (installClaude) targets.push(path.join(r, '.claude', 'skills', skillFolderName));
  }

  const installed = [];
  for (const dest of targets) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(srcAbs, dest, { recursive: true });
    installed.push(dest);
  }

  return { ok: true, installed };
}

/** 是否允许删除的启用态技能相对路径（相对仓库根或用户主目录） */
function isRemovableEnabledSkillRel(normSkillRelPosix) {
  const n = normSkillRelPosix.replace(/\\/g, '/');
  if (/^\.cursor\/skills\//.test(n)) return true;
  if (/^\.cursor\/skills-cursor\//.test(n)) return true;
  if (/^\.codex\/skills\//.test(n)) return true;
  if (/^\.claude\/skills\//.test(n)) return true;
  if (n.includes('/.cursor/skills/')) return true;
  if (n.includes('/.cursor/skills-cursor/')) return true;
  if (n.includes('/.codex/skills/')) return true;
  if (n.includes('/.claude/skills/')) return true;
  return false;
}

/**
 * 永久删除技能目录：启用态删除磁盘文件夹；禁用态删除 .skill_guard 内备份并移除 manifest。
 * @param {string} rootPathAbs 仓库根或用户主目录
 * @param {string} skillRelPathPosix 扫描结果中的 relPath（禁用项亦为原始路径）
 * @param {'enabled'|'disabled'} state
 */
function deleteSkill(rootPathAbs, skillRelPathPosix, state) {
  const root = path.resolve(rootPathAbs);
  if (state !== 'enabled' && state !== 'disabled') {
    throw new Error('Invalid skill state');
  }
  const normSkillRel = toPosix(skillRelPathPosix).replace(/^\/+/, '');
  if (!normSkillRel || normSkillRel.split('/').some((p) => p === '..' || p === '.')) {
    throw new Error('Invalid skill path');
  }

  if (state === 'enabled' && !isRemovableEnabledSkillRel(normSkillRel)) {
    throw new Error('该路径不允许删除');
  }

  const skillDir = getSkillDirAbs(rootPathAbs, normSkillRel, state);
  assertUnderRepoRoot(root, skillDir);

  const relFromRoot = toPosix(path.relative(root, skillDir));
  if (state === 'disabled') {
    const prefix = `${GUARD_DIR}/${DISABLED_SUB}/`;
    if (!relFromRoot.startsWith(prefix)) {
      throw new Error('该路径不允许删除');
    }
  }

  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    throw new Error('技能目录不存在');
  }

  if (state === 'disabled') {
    const manifest = readManifest(root);
    const idx = manifest.entries.findIndex((e) => toPosix(e.originalRelPath) === normSkillRel);
    if (idx === -1) {
      throw new Error('未找到禁用记录，请重新扫描后再试');
    }
    fs.rmSync(skillDir, { recursive: true, force: true });
    manifest.entries.splice(idx, 1);
    writeManifest(root, manifest);
    return { ok: true };
  }

  fs.rmSync(skillDir, { recursive: true, force: true });
  return { ok: true };
}

function readSkillFile(rootPath, skillRelPathPosix, state, fileRelPosix) {
  const root = path.resolve(rootPath);
  const skillDir = getSkillDirAbs(rootPath, skillRelPathPosix, state);
  assertUnderRepoRoot(root, skillDir);
  const normalized = toPosix(fileRelPosix).replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((p) => p === '..')) {
    throw new Error('非法路径');
  }
  const fileAbs = path.join(skillDir, ...parts);
  assertUnderSkillDir(skillDir, fileAbs);
  if (!fs.existsSync(fileAbs) || !fs.statSync(fileAbs).isFile()) {
    throw new Error('文件不存在');
  }
  const st = fs.statSync(fileAbs);
  if (st.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(`文件超过 ${MAX_SKILL_FILE_BYTES / 1024 / 1024}MB 上限`);
  }
  const baseName = parts[parts.length - 1] || '';
  const ext = path.posix.extname(baseName).toLowerCase();
  const mime = IMAGE_EXT_MIME[ext];
  const buf = fs.readFileSync(fileAbs);
  if (mime) {
    return { kind: 'image', mime, base64: buf.toString('base64') };
  }
  return { kind: 'text', content: buf.toString('utf8'), ext };
}

module.exports = {
  scanRepo,
  scanGlobal,
  scanSkills,
  disableSkill,
  enableSkill,
  deleteSkill,
  listSkillTree,
  readSkillFile,
  installMarketplaceSkill,
  attachMarketplaceUpdateToInstalledSkills,
  readManifest,
  MANIFEST_VERSION,
  GLOBAL_SKILL_PATTERNS,
  REPO_SKILL_PATTERNS,
  MARKETPLACE_SKILL_PATTERNS,
};
