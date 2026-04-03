import hljs from 'highlight.js';
import './skill-hljs.css';

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.sql': 'sql',
  '.vue': 'xml',
  '.toml': 'ini',
  '.ini': 'ini',
};

const AUTO_LANG_SUBSET = [
  'typescript',
  'javascript',
  'json',
  'css',
  'xml',
  'markdown',
  'bash',
  'python',
  'yaml',
  'rust',
  'go',
  'java',
  'ruby',
  'php',
  'sql',
  'kotlin',
  'swift',
  'scss',
  'less',
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 根据扩展名做语法高亮，失败则转义纯文本 */
export function highlightSkillCode(code: string, fileRel: string): string {
  const lower = fileRel.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  const lang = EXT_LANG[ext];
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code, AUTO_LANG_SUBSET).value;
  } catch {
    return escapeHtml(code);
  }
}
