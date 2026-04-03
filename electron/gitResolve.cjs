const fs = require('fs');
const path = require('path');

/**
 * 解析本机 git 可执行文件路径。
 * - 优先环境变量 SKILL_GUARD_GIT_PATH（完整路径，适合 GUI 启动未继承 PATH 的 Windows）
 * - Windows 下探测 Git for Windows 常见安装位置
 * - 否则回退为 "git"，依赖 PATH
 */
function resolveGitExecutable() {
  const envPath = process.env.SKILL_GUARD_GIT_PATH;
  if (typeof envPath === 'string' && envPath.trim()) {
    const t = envPath.trim().replace(/^["']|["']$/g, '');
    try {
      if (t && fs.existsSync(t)) return t;
    } catch {
      /* ignore */
    }
  }

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LocalAppData || '';
    const candidates = [
      path.join(pf, 'Git', 'cmd', 'git.exe'),
      path.join(pf, 'Git', 'bin', 'git.exe'),
      path.join(pfx86, 'Git', 'cmd', 'git.exe'),
      path.join(pfx86, 'Git', 'bin', 'git.exe'),
      path.join(local, 'Programs', 'Git', 'cmd', 'git.exe'),
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }

  return 'git';
}

function gitNotFoundMessage() {
  return '此功能依赖本机已安装 Git，请安装后确保可在终端执行 git。';
}

module.exports = { resolveGitExecutable, gitNotFoundMessage };
