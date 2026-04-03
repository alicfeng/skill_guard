const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const util = require('util');
const { resolveGitExecutable } = require('./gitResolve.cjs');

const execFileAsync = util.promisify(execFile);

const gitOpts = (root) => ({
  cwd: root,
  maxBuffer: 1024 * 1024,
  windowsHide: true,
});

/**
 * @param {string} repoRoot
 * @returns {Promise<string | null>} 当前分支名；非 Git 或失败时 null
 */
async function getCurrentBranch(repoRoot) {
  const root = path.resolve(repoRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return null;
  }

  try {
    const gitExe = resolveGitExecutable();
    const opts = gitOpts(root);

    // 1) 有提交/无提交的分支名：symbolic-ref 在「尚未首次提交」时仍常能给出 main/master
    try {
      const { stdout } = await execFileAsync(gitExe, ['symbolic-ref', '-q', '--short', 'HEAD'], opts);
      const name = String(stdout).trim();
      if (name) return name;
    } catch {
      /* detached、损坏 HEAD 等，继续尝试 */
    }

    // 2) rev-parse：在子目录下也能找到仓库（不要求根目录存在 .git 目录）
    let abbrev;
    try {
      const { stdout } = await execFileAsync(gitExe, ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
      abbrev = String(stdout).trim();
    } catch {
      return null;
    }

    if (abbrev && abbrev !== 'HEAD') return abbrev;

    // 3) detached HEAD：显示短提交
    try {
      const { stdout } = await execFileAsync(gitExe, ['rev-parse', '--short', 'HEAD'], opts);
      const sha = String(stdout).trim();
      return sha ? `⎇ ${sha}` : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

module.exports = { getCurrentBranch };
