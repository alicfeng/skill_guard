import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type {
  AppConfig,
  MarketplaceListedSkill,
  MarketplaceRecommendItem,
  MarketplaceSourceConfig,
  RepoConfig,
  SkillFilePayload,
  SkillRow,
  SkillTreeNode,
  ThemeId,
  UserProfile,
} from './vite-env';
import { highlightSkillCode } from './skillHighlight';

const api = window.skillGuardApi;

/** 与主进程 `marketplace.cjs` 中内置默认一致，用于文案与占位 */
const DEFAULT_MARKETPLACE_RECOMMEND_INDEX_URL =
  'https://raw.githubusercontent.com/alicfeng/skill_box/refs/heads/main/sub.json';

async function ipcListSkillTree(rootPath: string, skillRelPath: string, state: SkillRow['state']) {
  if (typeof api.listSkillTree === 'function') {
    return api.listSkillTree(rootPath, skillRelPath, state);
  }
  if (typeof api._invoke === 'function') {
    return api._invoke('skills:listTree', { rootPath, skillRelPath, state }) as Promise<SkillTreeNode[]>;
  }
  throw new Error(
    'listSkillTree 不可用：请关闭所有 Skill Guard 窗口后重新执行 npm run dev（勿仅用浏览器打开 localhost）',
  );
}

async function ipcReadSkillFile(
  rootPath: string,
  skillRelPath: string,
  state: SkillRow['state'],
  fileRel: string,
) {
  if (typeof api.readSkillFile === 'function') {
    return api.readSkillFile(rootPath, skillRelPath, state, fileRel);
  }
  if (typeof api._invoke === 'function') {
    return api._invoke('skills:readFile', { rootPath, skillRelPath, state, fileRel }) as Promise<SkillFilePayload>;
  }
  throw new Error('readSkillFile 不可用：请重启 Electron 应用');
}

async function ipcDeleteSkill(
  rootPath: string,
  skillRelPath: string,
  state: SkillRow['state'],
) {
  if (typeof api.deleteSkill === 'function') {
    return api.deleteSkill(rootPath, skillRelPath, state);
  }
  if (typeof api._invoke === 'function') {
    return api._invoke('skills:delete', { rootPath, skillRelPath, state }) as Promise<{ ok: true }>;
  }
  throw new Error(
    'deleteSkill 不可用：请关闭所有 Skill Guard 窗口后重新执行 npm run dev（预加载脚本可能为旧版本）',
  );
}

const MARKETPLACE_IPC_MAX_MS = 360000;

/** 主进程 Git 若长时间不返回，避免界面一直停在「更新中 / 处理中」 */
function withMarketplaceIpcTimeout<T>(p: Promise<T>, actionLabel: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `${actionLabel}等待超时（${MARKETPLACE_IPC_MAX_MS / 60000} 分钟），界面已恢复。若 Git 仍在后台执行，可稍后在技能市场点「刷新」或「拉取更新」重试。`,
        ),
      );
    }, MARKETPLACE_IPC_MAX_MS);
  });
  const guarded = p.finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
  return Promise.race([guarded, timeoutP]);
}

type MainTab = 'global' | 'repo' | 'marketplace';

type GlobalSourceFilter = 'all' | 'cursor' | 'codex' | 'claude';

function skillMatchesGlobalSource(relPath: string, filter: GlobalSourceFilter): boolean {
  if (filter === 'all') return true;
  const p = relPath.replace(/\\/g, '/');
  if (filter === 'cursor') {
    return (
      p === '.cursor/skills' ||
      p.startsWith('.cursor/skills/') ||
      p === '.cursor/skills-cursor' ||
      p.startsWith('.cursor/skills-cursor/')
    );
  }
  if (filter === 'codex') {
    return p === '.codex/skills' || p.startsWith('.codex/skills/');
  }
  return p === '.claude/skills' || p.startsWith('.claude/skills/');
}

function resolvedTheme(theme: AppConfig['theme'] | undefined): ThemeId {
  return theme === 'light' ? 'light' : 'dark';
}

function collectDirRelPaths(nodes: SkillTreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === 'dir') {
      out.push(n.relPath);
      out.push(...collectDirRelPaths(n.children));
    }
  }
  return out;
}

function pickDefaultFileRel(nodes: SkillTreeNode[]): string | null {
  for (const n of nodes) {
    if (n.type === 'file' && n.relPath === 'SKILL.md') return 'SKILL.md';
  }
  function findSkillMdDeep(ns: SkillTreeNode[]): string | null {
    for (const n of ns) {
      if (n.type === 'file' && n.name === 'SKILL.md') return n.relPath;
      if (n.type === 'dir') {
        const h = findSkillMdDeep(n.children);
        if (h) return h;
      }
    }
    return null;
  }
  function firstFile(ns: SkillTreeNode[]): string | null {
    for (const n of ns) {
      if (n.type === 'file') return n.relPath;
      if (n.type === 'dir') {
        const h = firstFile(n.children);
        if (h) return h;
      }
    }
    return null;
  }
  return findSkillMdDeep(nodes) ?? firstFile(nodes);
}

export default function App() {
  const [mainTab, setMainTab] = useState<MainTab>('global');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [globalRoot, setGlobalRoot] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [globalSourceFilter, setGlobalSourceFilter] = useState<GlobalSourceFilter>('all');
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [skillDetailOpen, setSkillDetailOpen] = useState<{
    row: SkillRow;
    rootPath: string;
    /** Marketplace 打开时展示克隆来源 Git 地址 */
    marketplaceSourceUrl?: string;
  } | null>(null);
  const [skillTree, setSkillTree] = useState<SkillTreeNode[] | null>(null);
  const [skillTreeLoading, setSkillTreeLoading] = useState(false);
  const [skillTreeErr, setSkillTreeErr] = useState<string | null>(null);
  const [skillExpandedDirs, setSkillExpandedDirs] = useState<Set<string>>(() => new Set());
  const [skillSelectedFile, setSkillSelectedFile] = useState<string | null>(null);
  const [skillFilePayload, setSkillFilePayload] = useState<SkillFilePayload | null>(null);
  const [skillFileLoading, setSkillFileLoading] = useState(false);
  const [skillFileErr, setSkillFileErr] = useState<string | null>(null);
  const skillDetailSessionRef = useRef(0);
  const skillFileLoadIdRef = useRef(0);
  const [marketplaceSkills, setMarketplaceSkills] = useState<MarketplaceListedSkill[]>([]);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [marketplaceBusy, setMarketplaceBusy] = useState(false);
  const [marketplaceUrlInput, setMarketplaceUrlInput] = useState('');
  const [marketplaceIssues, setMarketplaceIssues] = useState<string[]>([]);
  const [marketplaceSearch, setMarketplaceSearch] = useState('');
  const [marketplaceFilterSourceId, setMarketplaceFilterSourceId] = useState<string>('all');
  const [marketplaceSubTab, setMarketplaceSubTab] = useState<'skills' | 'subscriptions'>(
    'skills',
  );
  const [marketplaceInstallOpen, setMarketplaceInstallOpen] = useState<MarketplaceListedSkill | null>(
    null,
  );
  const [installTargetCursor, setInstallTargetCursor] = useState(true);
  const [installTargetCodex, setInstallTargetCodex] = useState(true);
  const [installTargetClaude, setInstallTargetClaude] = useState(true);
  const [installScope, setInstallScope] = useState<'global' | 'repo'>('global');
  const [installRepoId, setInstallRepoId] = useState<string | null>(null);
  const [marketplaceInstallBusy, setMarketplaceInstallBusy] = useState(false);
  const [marketplaceSuccess, setMarketplaceSuccess] = useState<string | null>(null);
  const [sourcesListSubTab, setSourcesListSubTab] = useState<'subscribed' | 'recommend'>(
    'subscribed',
  );
  const [recommendItems, setRecommendItems] = useState<MarketplaceRecommendItem[]>([]);
  const [recommendLoading, setRecommendLoading] = useState(false);
  const [recommendFetchErr, setRecommendFetchErr] = useState<string | null>(null);
  const [recommendUrlModalOpen, setRecommendUrlModalOpen] = useState(false);
  const [recommendUrlDraft, setRecommendUrlDraft] = useState('');
  /** 推荐条目添加中：`url + \\n + path` 区分同 URL 不同 path */
  const [recommendAddingKey, setRecommendAddingKey] = useState<string | null>(null);
  /** 推迟单击动作，避免与双击打开设置冲突 */
  const recommendClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [repoPathCopied, setRepoPathCopied] = useState(false);
  const repoPathCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeRepo = config?.repos.find((r) => r.id === activeRepoId) ?? null;

  const globalFilteredSkills = useMemo(
    () => skills.filter((s) => skillMatchesGlobalSource(s.relPath, globalSourceFilter)),
    [skills, globalSourceFilter],
  );

  const marketplaceFilteredSkills = useMemo(() => {
    let list = marketplaceSkills;
    if (marketplaceFilterSourceId !== 'all') {
      list = list.filter((s) => s.marketplaceSourceId === marketplaceFilterSourceId);
    }
    const q = marketplaceSearch.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.relPath.toLowerCase().includes(q) ||
          s.marketplaceSourceUrl.toLowerCase().includes(q),
      );
    }
    return list;
  }, [marketplaceSkills, marketplaceSearch, marketplaceFilterSourceId]);

  const marketplaceFilterOptions = useMemo((): CustomSelectOpt[] => {
    const rows: CustomSelectOpt[] = [{ value: 'all', label: '全部订阅' }];
    for (const s of config?.marketplaceSources ?? []) {
      const sub = (s.skillsPath || '').trim();
      rows.push({
        value: s.id,
        label: shortGitUrl(s.url, 48),
        title: sub ? `${s.url}\n扫描子目录: ${sub}` : s.url,
      });
    }
    return rows;
  }, [config?.marketplaceSources]);

  const installRepoOptions = useMemo(
    () =>
      (config?.repos ?? []).map((r) => ({
        value: r.id,
        label: r.name,
        title: r.path,
      })),
    [config?.repos],
  );

  const refreshConfig = useCallback(async () => {
    const c = await api.loadConfig();
    setConfig(c);
    setActiveRepoId((prev) => prev ?? c.repos[0]?.id ?? null);
  }, []);

  const copyRepoPath = useCallback(async (fullPath: string) => {
    try {
      await navigator.clipboard.writeText(fullPath);
      if (repoPathCopyTimerRef.current != null) {
        clearTimeout(repoPathCopyTimerRef.current);
      }
      setRepoPathCopied(true);
      repoPathCopyTimerRef.current = setTimeout(() => {
        setRepoPathCopied(false);
        repoPathCopyTimerRef.current = null;
      }, 2000);
    } catch {
      setError('无法复制路径，请检查剪贴板权限或手动复制。');
    }
  }, []);

  useEffect(() => {
    Promise.all([refreshConfig(), api.getUserProfile().then(setUserProfile)]).catch((e) =>
      setError(String(e)),
    );
  }, [refreshConfig]);

  useEffect(() => {
    setRepoPathCopied(false);
  }, [activeRepoId]);

  useEffect(
    () => () => {
      if (recommendClickTimerRef.current != null) {
        clearTimeout(recommendClickTimerRef.current);
        recommendClickTimerRef.current = null;
      }
      if (repoPathCopyTimerRef.current != null) {
        clearTimeout(repoPathCopyTimerRef.current);
        repoPathCopyTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const root = document.documentElement;
    if (resolvedTheme(config?.theme) === 'light') {
      root.dataset.theme = 'light';
      root.style.colorScheme = 'light';
    } else {
      root.removeAttribute('data-theme');
      root.style.colorScheme = 'dark';
    }
  }, [config?.theme]);

  async function commitTheme(theme: ThemeId) {
    setError(null);
    try {
      const base = config ?? (await api.loadConfig());
      const next: AppConfig = {
        ...base,
        repos: base.repos ?? [],
        marketplaceSources: base.marketplaceSources ?? [],
        theme,
      };
      await api.saveConfig(next);
      setConfig(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const refreshGlobalSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.scanGlobal();
      setGlobalRoot(res.root);
      setSkills(res.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshRepoSkills = useCallback(async (repo: RepoConfig | null) => {
    if (!repo) {
      setSkills([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.scan(repo.path);
      setSkills(res.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mainTab !== 'global') return;
    refreshGlobalSkills();
  }, [mainTab, refreshGlobalSkills]);

  useEffect(() => {
    if (mainTab !== 'repo') return;
    refreshRepoSkills(activeRepo);
  }, [mainTab, activeRepo, refreshRepoSkills]);

  const loadMarketplace = useCallback(async () => {
    setMarketplaceLoading(true);
    setError(null);
    setMarketplaceIssues([]);
    try {
      const res = await api.marketplaceLoad();
      setMarketplaceSkills(res.skills);
      setMarketplaceIssues(res.issues ?? []);
      setConfig((prev) =>
        prev ? { ...prev, marketplaceSources: res.sources } : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMarketplaceSkills([]);
      setMarketplaceIssues([]);
    } finally {
      setMarketplaceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mainTab !== 'marketplace') return;
    loadMarketplace();
  }, [mainTab, loadMarketplace]);

  useEffect(() => {
    if (!marketplaceInstallOpen) return;
    if (installScope === 'repo' && (config?.repos ?? []).length === 0) {
      setInstallScope('global');
    }
  }, [marketplaceInstallOpen, installScope, config?.repos]);

  const openMarketplaceInstall = useCallback((s: MarketplaceListedSkill) => {
    setMarketplaceSuccess(null);
    setError(null);
    setMarketplaceInstallOpen(s);
    setInstallTargetCursor(true);
    setInstallTargetCodex(true);
    setInstallTargetClaude(true);
    setInstallScope('global');
    const first = config?.repos[0]?.id ?? null;
    setInstallRepoId(first);
  }, [config?.repos]);

  const confirmMarketplaceInstall = useCallback(async () => {
    if (!marketplaceInstallOpen) return;
    if (!installTargetCursor && !installTargetCodex && !installTargetClaude) {
      setError('请至少勾选 Cursor、Codex 或 Claude 中的一项');
      return;
    }
    const repoPath =
      installScope === 'repo' ? config?.repos.find((r) => r.id === installRepoId)?.path : undefined;
    if (installScope === 'repo' && !repoPath) {
      setError('请先在「工程仓库」页添加本地仓库');
      return;
    }
    setMarketplaceInstallBusy(true);
    setError(null);
    try {
      const res = await api.marketplaceInstallSkill({
        marketplaceRootPath: marketplaceInstallOpen.marketplaceRootPath,
        skillRelPath: marketplaceInstallOpen.relPath,
        installCursor: installTargetCursor,
        installCodex: installTargetCodex,
        installClaude: installTargetClaude,
        scope: installScope,
        repoPath,
      });
      setMarketplaceSuccess(
        `已安装到 ${res.installed.length} 个目录。请到「全局」或「工程仓库」页刷新列表即可看到该技能。`,
      );
      setMarketplaceInstallOpen(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarketplaceInstallBusy(false);
    }
  }, [
    marketplaceInstallOpen,
    installTargetCursor,
    installTargetCodex,
    installTargetClaude,
    installScope,
    installRepoId,
    config?.repos,
  ]);

  const refreshGitBranch = useCallback(async (repoPath: string | null) => {
    if (!repoPath) {
      setGitBranch(null);
      return;
    }
    try {
      const b = await api.getGitBranch(repoPath);
      setGitBranch(b);
    } catch {
      setGitBranch(null);
    }
  }, []);

  useEffect(() => {
    if (mainTab !== 'repo' || !activeRepo) {
      setGitBranch(null);
      return;
    }
    refreshGitBranch(activeRepo.path);
  }, [mainTab, activeRepo?.path, refreshGitBranch]);

  const loadSkillFile = useCallback(async (rootPath: string, row: SkillRow, fileRel: string) => {
    const id = ++skillFileLoadIdRef.current;
    setSkillFileLoading(true);
    setSkillFileErr(null);
    setSkillFilePayload(null);
    try {
      const payload = await ipcReadSkillFile(rootPath, row.relPath, row.state, fileRel);
      if (id !== skillFileLoadIdRef.current) return;
      setSkillFilePayload(payload);
    } catch (e) {
      if (id !== skillFileLoadIdRef.current) return;
      setSkillFileErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === skillFileLoadIdRef.current) {
        setSkillFileLoading(false);
      }
    }
  }, []);

  const openSkillDetail = useCallback(
    async (
      row: SkillRow,
      rootPathOverride?: string,
      detailMeta?: { marketplaceSourceUrl: string },
    ) => {
      const root =
        rootPathOverride ??
        (mainTab === 'global' ? globalRoot : activeRepo?.path);
      if (!root) return;
      skillDetailSessionRef.current += 1;
      const session = skillDetailSessionRef.current;
      setSkillDetailOpen({
        row,
        rootPath: root,
        marketplaceSourceUrl: detailMeta?.marketplaceSourceUrl,
      });
      setSkillTree(null);
      setSkillTreeErr(null);
      setSkillTreeLoading(true);
      setSkillExpandedDirs(new Set());
      setSkillSelectedFile(null);
      setSkillFilePayload(null);
      setSkillFileErr(null);
      setSkillFileLoading(false);
      try {
        const tree = await ipcListSkillTree(root, row.relPath, row.state);
        if (session !== skillDetailSessionRef.current) return;
        setSkillTree(tree);
        setSkillExpandedDirs(new Set(collectDirRelPaths(tree)));
        const defaultRel = pickDefaultFileRel(tree);
        if (defaultRel) {
          setSkillSelectedFile(defaultRel);
          loadSkillFile(root, row, defaultRel);
        }
      } catch (e) {
        if (session !== skillDetailSessionRef.current) return;
        setSkillTreeErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (session === skillDetailSessionRef.current) {
          setSkillTreeLoading(false);
        }
      }
    },
    [mainTab, globalRoot, activeRepo?.path, loadSkillFile],
  );

  async function handleAddMarketplaceSource() {
    const url = marketplaceUrlInput.trim();
    if (!url) return;
    setError(null);
    setMarketplaceBusy(true);
    try {
      const data = await withMarketplaceIpcTimeout(
        api.marketplaceAddSource(url),
        '添加订阅',
      );
      setConfig(data.config);
      setMarketplaceSkills(data.skills);
      setMarketplaceIssues(data.issues ?? []);
      setMarketplaceUrlInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarketplaceBusy(false);
    }
  }

  function clearRecommendClickDebounce() {
    if (recommendClickTimerRef.current != null) {
      clearTimeout(recommendClickTimerRef.current);
      recommendClickTimerRef.current = null;
    }
  }

  function onRecommendTabClick() {
    clearRecommendClickDebounce();
    recommendClickTimerRef.current = setTimeout(() => {
      recommendClickTimerRef.current = null;
      setSourcesListSubTab('recommend');
      void loadRecommendListForTab();
    }, 280);
  }

  function onRecommendTabDoubleClick(e: ReactMouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    clearRecommendClickDebounce();
    setRecommendUrlDraft(config?.marketplaceRecommendIndexUrl ?? '');
    setRecommendUrlModalOpen(true);
  }

  async function loadRecommendListForTab() {
    if (typeof api.marketplaceFetchRecommendations !== 'function') {
      setRecommendFetchErr('当前窗口预加载脚本较旧，请完全退出应用后重新运行 npm run dev。');
      setRecommendItems([]);
      return;
    }
    setRecommendLoading(true);
    setRecommendFetchErr(null);
    setError(null);
    try {
      const { items } = await api.marketplaceFetchRecommendations();
      setRecommendItems(items);
    } catch (e) {
      setRecommendFetchErr(e instanceof Error ? e.message : String(e));
      setRecommendItems([]);
    } finally {
      setRecommendLoading(false);
    }
  }

  async function saveRecommendIndexUrl() {
    setError(null);
    try {
      const base = config ?? (await api.loadConfig());
      const next: AppConfig = {
        ...base,
        repos: base.repos ?? [],
        marketplaceSources: base.marketplaceSources ?? [],
        marketplaceRecommendIndexUrl: recommendUrlDraft.trim(),
      };
      await api.saveConfig(next);
      setConfig(next);
      setRecommendUrlModalOpen(false);
      if (sourcesListSubTab === 'recommend') {
        void loadRecommendListForTab();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function marketplaceRecommendItemKey(item: MarketplaceRecommendItem) {
    return `${item.url}\n${item.path || ''}`;
  }

  async function handleAddRecommendItem(item: MarketplaceRecommendItem) {
    if (
      (config?.marketplaceSources ?? []).some(
        (s) => s.url === item.url && (s.skillsPath || '') === (item.path || ''),
      )
    ) {
      return;
    }
    setRecommendAddingKey(marketplaceRecommendItemKey(item));
    setMarketplaceBusy(true);
    setError(null);
    try {
      const payload =
        item.path && item.path.trim()
          ? { url: item.url, skillsPath: item.path, sourceOrigin: 'recommend' as const }
          : { url: item.url, sourceOrigin: 'recommend' as const };
      const data = await withMarketplaceIpcTimeout(api.marketplaceAddSource(payload), '添加订阅');
      setConfig(data.config);
      setMarketplaceSkills(data.skills);
      setMarketplaceIssues(data.issues ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarketplaceBusy(false);
      setRecommendAddingKey(null);
    }
  }

  async function handleRemoveMarketplaceSource(sourceId: string) {
    setError(null);
    setMarketplaceBusy(true);
    try {
      const data = await api.marketplaceRemoveSource(sourceId);
      setConfig(data.config);
      setMarketplaceSkills(data.skills);
      setMarketplaceIssues(data.issues ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarketplaceBusy(false);
    }
  }

  async function handleRefreshMarketplaceRemote() {
    if ((config?.marketplaceSources ?? []).length === 0) return;
    setError(null);
    setMarketplaceBusy(true);
    try {
      const data = await withMarketplaceIpcTimeout(
        api.marketplaceRefreshRemote(),
        '拉取更新',
      );
      setConfig(data.config);
      setMarketplaceSkills(data.skills);
      setMarketplaceIssues(data.issues ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarketplaceBusy(false);
    }
  }

  const closeSkillDetail = useCallback(() => {
    skillDetailSessionRef.current += 1;
    skillFileLoadIdRef.current += 1;
    setSkillDetailOpen(null);
    setSkillTree(null);
    setSkillTreeErr(null);
    setSkillTreeLoading(false);
    setSkillExpandedDirs(new Set());
    setSkillSelectedFile(null);
    setSkillFilePayload(null);
    setSkillFileErr(null);
    setSkillFileLoading(false);
  }, []);

  const toggleSkillDir = useCallback((dirRel: string) => {
    setSkillExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirRel)) next.delete(dirRel);
      else next.add(dirRel);
      return next;
    });
  }, []);

  const selectSkillFile = useCallback(
    (fileRel: string) => {
      if (!skillDetailOpen) return;
      setSkillSelectedFile(fileRel);
      loadSkillFile(skillDetailOpen.rootPath, skillDetailOpen.row, fileRel);
    },
    [skillDetailOpen, loadSkillFile],
  );

  useEffect(() => {
    if (!skillDetailOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeSkillDetail();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [skillDetailOpen, closeSkillDetail]);

  const anyModalOpen = Boolean(
    skillDetailOpen || marketplaceInstallOpen || recommendUrlModalOpen,
  );
  useEffect(() => {
    const root = document.documentElement;
    if (anyModalOpen) {
      root.classList.add('modal-scroll-lock');
    } else {
      root.classList.remove('modal-scroll-lock');
    }
    return () => root.classList.remove('modal-scroll-lock');
  }, [anyModalOpen]);

  async function handleAddRepo() {
    setError(null);
    const picked = await api.pickRepo();
    if (!picked) return;
    const prevLen = config?.repos.length ?? 0;
    try {
      const c = await api.addRepo(picked);
      setConfig(c);
      // 主进程存的是 path.resolve(picked)，与对话框返回值可能差在尾部斜杠等，新增时用条数选中更稳
      if (c.repos.length > prevLen) {
        setActiveRepoId(c.repos[c.repos.length - 1].id);
      } else {
        const hit = c.repos.find((r) => r.path === picked);
        if (hit) setActiveRepoId(hit.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRemoveRepo(id: string) {
    setError(null);
    try {
      const c = await api.removeRepo(id);
      setConfig(c);
      if (activeRepoId === id) {
        setActiveRepoId(c.repos[0]?.id ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleSkill(row: SkillRow) {
    const rootPath = mainTab === 'global' ? globalRoot : activeRepo?.path;
    if (!rootPath) return;
    setError(null);
    setBusyId(row.id);
    try {
      if (row.state === 'enabled') {
        await api.disableSkill(rootPath, row.relPath);
      } else {
        await api.enableSkill(rootPath, row.id);
      }
      if (mainTab === 'global') {
        await refreshGlobalSkills();
      } else if (activeRepo) {
        await refreshRepoSkills(activeRepo);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteSkill(row: SkillRow) {
    const rootPath = mainTab === 'global' ? globalRoot : activeRepo?.path;
    if (!rootPath) return;
    const tip =
      row.state === 'disabled'
        ? `确定永久删除技能「${row.name}」？\n将删除 .skill_guard 中的禁用备份及 manifest 记录，不可撤销。`
        : `确定永久删除技能「${row.name}」？\n将删除磁盘上的技能文件夹，不可撤销。`;
    if (!window.confirm(tip)) return;
    setError(null);
    setBusyId(row.id);
    try {
      await ipcDeleteSkill(rootPath, row.relPath, row.state);
      if (
        skillDetailOpen &&
        skillDetailOpen.rootPath === rootPath &&
        skillDetailOpen.row.relPath === row.relPath &&
        skillDetailOpen.row.state === row.state
      ) {
        closeSkillDetail();
      }
      if (mainTab === 'global') {
        await refreshGlobalSkills();
      } else if (activeRepo) {
        await refreshRepoSkills(activeRepo);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handleUpdateSkillFromMarketplace(row: SkillRow) {
    const u = row.updateFromMarketplace;
    if (!u) return;
    const rootPath = mainTab === 'global' ? globalRoot : activeRepo?.path;
    if (!rootPath) return;
    setError(null);
    setBusyId(row.id);
    try {
      await api.marketplaceInstallSkill({
        marketplaceRootPath: u.marketplaceRootPath,
        skillRelPath: u.skillRelPath,
        installCursor: u.installCursor,
        installCodex: u.installCodex,
        installClaude: u.installClaude,
        scope: u.scope,
        repoPath: u.repoPath,
      });
      if (
        skillDetailOpen &&
        skillDetailOpen.rootPath === rootPath &&
        skillDetailOpen.row.relPath === row.relPath &&
        skillDetailOpen.row.state === row.state
      ) {
        closeSkillDetail();
      }
      if (mainTab === 'global') {
        await refreshGlobalSkills();
      } else if (activeRepo) {
        await refreshRepoSkills(activeRepo);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  function handleRescan() {
    if (mainTab === 'global') {
      refreshGlobalSkills();
    } else if (activeRepo) {
      refreshRepoSkills(activeRepo);
      refreshGitBranch(activeRepo.path);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="header-titles">
            <h1>Skill Guard</h1>
            <p className="subtitle">
              Skill Guard 是一款用于集中管理与订阅 Cursor、Codex、Claude Code 技能的桌面工具。
            </p>
          </div>
          <div className="theme-toggle" role="group" aria-label="主题风格">
            <button
              type="button"
              className={`theme-seg ${resolvedTheme(config?.theme) === 'dark' ? 'active' : ''}`}
              aria-pressed={resolvedTheme(config?.theme) === 'dark'}
              onClick={() => commitTheme('dark')}
            >
              深色
            </button>
            <button
              type="button"
              className={`theme-seg ${resolvedTheme(config?.theme) === 'light' ? 'active' : ''}`}
              aria-pressed={resolvedTheme(config?.theme) === 'light'}
              onClick={() => commitTheme('light')}
            >
              浅色
            </button>
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="主导航">
        <div className="tabs-tablist" role="tablist" aria-label="范围">
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'global'}
            className={`tab ${mainTab === 'global' ? 'active' : ''}`}
            onClick={() => setMainTab('global')}
          >
            全局（{userProfile?.username ?? '…'}）
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'repo'}
            className={`tab ${mainTab === 'repo' ? 'active' : ''}`}
            onClick={() => setMainTab('repo')}
          >
            工程仓库
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'marketplace'}
            className={`tab ${mainTab === 'marketplace' ? 'active' : ''}`}
            onClick={() => setMainTab('marketplace')}
          >
            Skill Marketplace
          </button>
        </div>
      </nav>

      {error ? (
        <div className="banner error" role="alert">
          {error}
        </div>
      ) : null}

      {mainTab === 'marketplace' ? (
        <div className="layout layout-single">
          <main className="main main-global marketplace-main">
            <div className="app-tab-page">
              {marketplaceSuccess ? (
                <div className="banner success marketplace-success-banner" role="status">
                  {marketplaceSuccess}
                </div>
              ) : null}
              <div className="mp-subtabs" role="tablist" aria-label="技能市场">
                <button
                  type="button"
                  role="tab"
                  id="mp-subtab-skills"
                  aria-selected={marketplaceSubTab === 'skills'}
                  aria-controls="mp-panel-skills"
                  className={`mp-subtab ${marketplaceSubTab === 'skills' ? 'active' : ''}`}
                  onClick={() => setMarketplaceSubTab('skills')}
                >
                  技能
                </button>
                <button
                  type="button"
                  role="tab"
                  id="mp-subtab-subscriptions"
                  aria-selected={marketplaceSubTab === 'subscriptions'}
                  aria-controls="mp-panel-subscriptions"
                  className={`mp-subtab ${marketplaceSubTab === 'subscriptions' ? 'active' : ''}`}
                  onClick={() => setMarketplaceSubTab('subscriptions')}
                >
                  订阅
                </button>
              </div>

              {marketplaceSubTab === 'skills' ? (
                <div
                  role="tabpanel"
                  id="mp-panel-skills"
                  aria-labelledby="mp-subtab-skills"
                >
                  <header className="mp-hero mp-hero--compact">
                    <h2 className="mp-title">技能</h2>
                    <p className="mp-lead">
                      浏览已订阅源中的技能，可按订阅筛选或搜索。列表来自本机克隆缓存中对 <code>SKILL.md</code> 的扫描结果。
                      若在「订阅」中添加源或拉取更新后，请点击 <strong>刷新</strong> 重新扫描。
                      若本地已安装技能与订阅缓存内容不一致，在「全局」或「工程仓库」技能表中会显示 <strong>可更新</strong>，可一键从订阅覆盖。
                    </p>
                  </header>

                  <div className="mp-toolbar">
                    <label className="mp-search-wrap" htmlFor="mp-skill-search">
                      <MpSearchIcon className="mp-search-icon" />
                      <input
                        id="mp-skill-search"
                        type="search"
                        className="mp-search-input"
                        placeholder="搜索技能…"
                        value={marketplaceSearch}
                        onChange={(e) => setMarketplaceSearch(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <CustomSelect
                      ariaLabel="按订阅筛选"
                      variant="toolbar"
                      value={marketplaceFilterSourceId}
                      onChange={setMarketplaceFilterSourceId}
                      options={marketplaceFilterOptions}
                      disabled={marketplaceLoading || marketplaceBusy}
                    />
                    <div className="mp-toolbar-btns">
                      <button
                        type="button"
                        className="mp-tool-btn"
                        disabled={marketplaceLoading || marketplaceBusy}
                        onClick={() => loadMarketplace()}
                      >
                        {marketplaceLoading ? '扫描中…' : '刷新'}
                      </button>
                    </div>
                  </div>

                  <section className="mp-section" aria-labelledby="mp-skills-heading">
                    <h3 id="mp-skills-heading" className="mp-section-heading">
                      全部技能
                    </h3>
                    <MarketplaceSkillGrid
                      skills={marketplaceFilteredSkills}
                      sources={config?.marketplaceSources ?? []}
                      totalCount={marketplaceSkills.length}
                      loading={marketplaceLoading}
                      onViewDetail={(row) =>
                        openSkillDetail(marketplaceSkillToRow(row), row.marketplaceRootPath, {
                          marketplaceSourceUrl: row.marketplaceSourceUrl,
                        })
                      }
                      onInstall={openMarketplaceInstall}
                    />
                  </section>
                </div>
              ) : (
                <div
                  role="tabpanel"
                  id="mp-panel-subscriptions"
                  aria-labelledby="mp-subtab-subscriptions"
                >
                  <header className="mp-hero">
                    <h2 className="mp-title">订阅</h2>
                    <p className="mp-lead">
                      通过 Git 地址订阅技能集合，克隆到本机缓存并参与扫描。会在 <code>skills/</code>、
                      <code>.cursor/skills</code>、<code>.cursor/skills-cursor</code>、<code>.codex/skills</code>、
                      <code>.claude/skills</code> 下查找{' '}
                      <code>SKILL.md</code>。需已安装 <code>git</code> 并可访问网络。
                    </p>
                  </header>

                  <div className="mp-toolbar mp-toolbar--subscriptions">
                    <p className="mp-toolbar-lead">
                      对已克隆的订阅仓库执行 <code className="mono">git pull</code>。拉取远程更新与重新扫描技能列表是分开的两步。
                    </p>
                    <button
                      type="button"
                      className="mp-tool-btn mp-tool-btn--primary"
                      disabled={
                        marketplaceBusy ||
                        marketplaceLoading ||
                        (config?.marketplaceSources ?? []).length === 0
                      }
                      onClick={() => handleRefreshMarketplaceRemote()}
                    >
                      {marketplaceBusy ? '更新中…' : '拉取更新'}
                    </button>
                  </div>

                  <div className="mp-add-bar">
                    <input
                      id="mp-git-url"
                      type="text"
                      className="mp-add-input"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="粘贴 Git 仓库地址，例如 https://github.com/org/skills.git"
                      value={marketplaceUrlInput}
                      disabled={marketplaceBusy}
                      onChange={(e) => setMarketplaceUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddMarketplaceSource();
                      }}
                    />
                    <button
                      type="button"
                      className="mp-add-btn"
                      disabled={marketplaceBusy || !marketplaceUrlInput.trim()}
                      onClick={() => handleAddMarketplaceSource()}
                    >
                      {marketplaceBusy ? '…' : '添加订阅'}
                    </button>
                  </div>

                  {marketplaceIssues.length > 0 ? (
                    <div className="mp-hints" role="status">
                      <ul className="mp-hints-list">
                        {marketplaceIssues.map((msg, i) => (
                          <li key={`${i}-${msg.slice(0, 48)}`}>{msg}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <section className="mp-section mp-section--sources-tabs" aria-label="订阅源">
                    <div
                      className="mp-subtabs mp-subtabs--sources"
                      role="tablist"
                      aria-label="已订阅与推荐"
                    >
                      <button
                        type="button"
                        role="tab"
                        id="mp-subtab-sources-subscribed"
                        aria-selected={sourcesListSubTab === 'subscribed'}
                        aria-controls="mp-panel-sources-subscribed"
                        className={`mp-subtab ${sourcesListSubTab === 'subscribed' ? 'active' : ''}`}
                        onClick={() => setSourcesListSubTab('subscribed')}
                      >
                        已订阅的源
                      </button>
                      <button
                        type="button"
                        role="tab"
                        id="mp-subtab-sources-recommend"
                        aria-selected={sourcesListSubTab === 'recommend'}
                        aria-controls="mp-panel-sources-recommend"
                        className={`mp-subtab ${sourcesListSubTab === 'recommend' ? 'active' : ''}`}
                        title="单击切换到推荐并拉取列表；双击打开设置（自定义 JSON 接口 URL）"
                        aria-label="推荐：单击切换并拉取，双击设置接口地址"
                        onClick={onRecommendTabClick}
                        onDoubleClick={onRecommendTabDoubleClick}
                      >
                        {recommendLoading && sourcesListSubTab === 'recommend' ? '拉取中…' : '推荐'}
                      </button>
                    </div>

                    {sourcesListSubTab === 'subscribed' ? (
                      <div
                        role="tabpanel"
                        id="mp-panel-sources-subscribed"
                        aria-labelledby="mp-subtab-sources-subscribed"
                      >
                        {(config?.marketplaceSources ?? []).length > 0 ? (
                          <div className="mp-subscribed-grid">
                            {(config?.marketplaceSources ?? []).map((s) => {
                              const label = gitRepoShortLabel(s.url);
                              const iconLetter = (label.trim().charAt(0) || 'G').toUpperCase();
                              const fromRecommend = s.sourceOrigin === 'recommend';
                              return (
                                <article
                                  key={s.id}
                                  className={`mp-subscribe-card ${mpCardTintClass(s.id)}${fromRecommend ? ' mp-subscribe-card--recommend' : ''}`}
                                >
                                  <button
                                    type="button"
                                    className="mp-subscribe-card-unsub"
                                    disabled={marketplaceBusy}
                                    aria-label={`取消订阅 ${s.url}`}
                                    title="取消订阅"
                                    onClick={() => handleRemoveMarketplaceSource(s.id)}
                                  >
                                    ×
                                  </button>
                                  <div className="mp-subscribe-card-layout">
                                    <div className="mp-subscribe-card-icon" aria-hidden>
                                      {iconLetter}
                                    </div>
                                    <div className="mp-subscribe-card-content">
                                      <h4 className="mp-subscribe-card-title">{label}</h4>
                                      <p className="mp-subscribe-card-url mono">{s.url}</p>
                                      <div
                                        className={[
                                          'mp-subscribe-card-footer',
                                          !s.lastPulledAt ? 'mp-subscribe-card-footer--pending' : '',
                                          fromRecommend ? 'mp-subscribe-card-footer--has-recommend-mark' : '',
                                        ]
                                          .filter(Boolean)
                                          .join(' ')}
                                      >
                                        <span className="mp-subscribe-card-footer-main">
                                          {s.lastPulledAt ? (
                                            <>最后同步 {formatMarketplaceLastPull(s.lastPulledAt)}</>
                                          ) : (
                                            <>尚未执行拉取更新</>
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  {fromRecommend ? (
                                    <span
                                      className="mp-subscribe-card-recommend-mark"
                                      title="从「推荐」列表添加"
                                    >
                                      推荐
                                    </span>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="mp-empty-subscriptions mp-empty-subscriptions--inline" role="status">
                            <p>
                              尚未添加订阅。在上方粘贴 Git 地址并点击「添加订阅」，或切换到「推荐」从远程列表添加；添加后可到「技能」页查看扫描结果。
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        role="tabpanel"
                        id="mp-panel-sources-recommend"
                        aria-labelledby="mp-subtab-sources-recommend"
                      >
                        {recommendFetchErr ? (
                          <div className="mp-recommend-inline-error" role="alert">
                            {recommendFetchErr}
                          </div>
                        ) : null}
                        {recommendLoading ? (
                          <p className="mp-recommend-loading muted">正在拉取推荐列表…</p>
                        ) : null}
                        {!recommendLoading && recommendItems.length > 0 ? (
                          <div className="mp-source-chips">
                            {recommendItems.map((item) => {
                              const already = (config?.marketplaceSources ?? []).some(
                                (s) => s.url === item.url && (s.skillsPath || '') === (item.path || ''),
                              );
                              const adding = recommendAddingKey === marketplaceRecommendItemKey(item);
                              return (
                                <div key={marketplaceRecommendItemKey(item)} className="mp-chip mp-chip--recommend">
                                  <div className="mp-chip-body">
                                    <span className="mp-chip-name">{item.name}</span>
                                    <span
                                      className="mp-chip-text mono"
                                      title={
                                        item.path
                                          ? `${item.url}\npath: ${item.path}`
                                          : item.url
                                      }
                                    >
                                      {shortGitUrl(item.url, 52)}
                                      {item.path ? (
                                        <span className="mp-chip-path-suffix mono"> · {item.path}</span>
                                      ) : null}
                                    </span>
                                    {item.description ? (
                                      <span className="mp-chip-updated">{item.description}</span>
                                    ) : null}
                                  </div>
                                  <button
                                    type="button"
                                    className="mp-chip-add"
                                    disabled={already || marketplaceBusy}
                                    onClick={() => void handleAddRecommendItem(item)}
                                  >
                                    {already ? '已添加' : adding ? '添加中…' : '添加'}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        {!recommendLoading &&
                        !recommendFetchErr &&
                        recommendItems.length === 0 ? (
                          <p className="muted mp-recommend-empty">本次未返回任何推荐条目。</p>
                        ) : null}
                        {!recommendLoading &&
                        !recommendFetchErr &&
                        recommendItems.length > 0 &&
                        !(config?.marketplaceRecommendIndexUrl ?? '').trim() ? (
                          <p className="muted mp-recommend-empty mp-recommend-default-hint">
                            当前使用内置推荐源。双击「推荐」页签可填写自定义 JSON 地址（留空则继续使用内置）。
                          </p>
                        ) : null}
                      </div>
                    )}
                  </section>
                </div>
              )}
            </div>
          </main>
        </div>
      ) : mainTab === 'global' ? (
        <div className="layout layout-single">
          <main className="main main-global">
            <div className="app-tab-page">
              <div className="main-head">
                <div className="main-head-left">
                  <div className="title-row">
                    <h2>{userProfile?.username ? `${userProfile.username} 的全局 skills` : '全局 skills'}</h2>
                    <div className="source-filter" role="group" aria-label="来源">
                      <button
                        type="button"
                        className={`source-seg ${globalSourceFilter === 'all' ? 'active' : ''}`}
                        aria-pressed={globalSourceFilter === 'all'}
                        onClick={() => setGlobalSourceFilter('all')}
                      >
                        全部
                      </button>
                      <button
                        type="button"
                        className={`source-seg ${globalSourceFilter === 'cursor' ? 'active' : ''}`}
                        aria-pressed={globalSourceFilter === 'cursor'}
                        onClick={() => setGlobalSourceFilter('cursor')}
                      >
                        Cursor
                      </button>
                      <button
                        type="button"
                        className={`source-seg ${globalSourceFilter === 'codex' ? 'active' : ''}`}
                        aria-pressed={globalSourceFilter === 'codex'}
                        onClick={() => setGlobalSourceFilter('codex')}
                      >
                        Codex
                      </button>
                      <button
                        type="button"
                        className={`source-seg ${globalSourceFilter === 'claude' ? 'active' : ''}`}
                        aria-pressed={globalSourceFilter === 'claude'}
                        onClick={() => setGlobalSourceFilter('claude')}
                      >
                        Claude
                      </button>
                    </div>
                  </div>
                </div>
                <button type="button" className="btn" disabled={loading} onClick={handleRescan}>
                  {loading ? '扫描中…' : '重新扫描'}
                </button>
              </div>

              <SkillTable
                skills={globalFilteredSkills}
                loading={loading}
                busyId={busyId}
                onToggle={toggleSkill}
                onDelete={handleDeleteSkill}
                onUpdateFromMarketplace={handleUpdateSkillFromMarketplace}
                onViewDetail={openSkillDetail}
                emptyHint={
                  skills.length > 0 && globalFilteredSkills.length === 0 ? (
                    <>当前来源筛选下没有 skills，可切换为「全部」或其它来源</>
                  ) : (
                    <>
                      未发现 <code>~/.cursor/skills/**/SKILL.md</code>、<code>~/.cursor/skills-cursor/**/SKILL.md</code>、
                      <code>~/.codex/skills/**/SKILL.md</code> 或{' '}
                      <code>~/.claude/skills/**/SKILL.md</code>
                      （且无用户目录下 manifest 中的禁用项）
                    </>
                  )
                }
              />
            </div>
          </main>
        </div>
      ) : (
        <div className="layout">
          <aside className="sidebar">
            <div className="sidebar-head">
              <h2>工程仓库</h2>
              <button type="button" className="btn sidebar-add-repo" onClick={handleAddRepo}>
                添加仓库
              </button>
            </div>
            <ul className="repo-list">
              {(config?.repos ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`repo-item ${r.id === activeRepoId ? 'active' : ''}`}
                    title={r.path}
                    onClick={() => setActiveRepoId(r.id)}
                  >
                    <RepoFolderIcon />
                    <span className="repo-item-body">
                      <span className="repo-name">{r.name}</span>
                      {r.id === activeRepoId && gitBranch ? (
                        <span className="repo-item-branch">{gitBranch}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <main className="main">
            <div className="app-tab-page">
              {!activeRepo ? (
                <div className="empty">请添加一个本地仓库目录</div>
              ) : (
                <>
                  <div className="main-head">
                    <div className="main-head-left">
                      <h2 className="repo-main-title">
                        <span className="repo-main-name">{activeRepo.name}</span>
                        {gitBranch ? (
                          <span className="repo-branch-pill" title="当前 Git 分支">
                            {gitBranch}
                          </span>
                        ) : null}
                      </h2>
                      <div className="scope-path-row">
                        <span className="scope-path" title={activeRepo.path}>
                          {activeRepo.path}
                        </span>
                        <button
                          type="button"
                          className={`scope-path-copy ${repoPathCopied ? 'is-done' : ''}`}
                          aria-label={repoPathCopied ? '已复制路径' : '复制路径'}
                          title={repoPathCopied ? '已复制' : '复制路径'}
                          onClick={() => void copyRepoPath(activeRepo.path)}
                        >
                          <CopyPathIcon />
                        </button>
                      </div>
                    </div>
                    <div className="main-head-actions">
                      <button type="button" className="btn" disabled={loading} onClick={handleRescan}>
                        {loading ? '扫描中…' : '重新扫描'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline-danger"
                        title={`仅从本应用列表移除，不删除磁盘上的仓库。${activeRepo.path}`}
                        onClick={() => handleRemoveRepo(activeRepo.id)}
                      >
                        从列表移除
                      </button>
                    </div>
                  </div>

                  <SkillTable
                    skills={skills}
                    loading={loading}
                    busyId={busyId}
                    onToggle={toggleSkill}
                    onDelete={handleDeleteSkill}
                    onUpdateFromMarketplace={handleUpdateSkillFromMarketplace}
                    onViewDetail={openSkillDetail}
                    emptyHint={
                      <>
                        未发现仓库内 <code>**/.cursor/skills/**/SKILL.md</code>、
                        <code>**/.cursor/skills-cursor/**/SKILL.md</code>、<code>**/.codex/skills/**/SKILL.md</code> 或{' '}
                        <code>**/.claude/skills/**/SKILL.md</code>
                        （且无该仓库 manifest 中的禁用项）
                      </>
                    }
                  />
                </>
              )}
            </div>
          </main>
        </div>
      )}

      {skillDetailOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeSkillDetail}
        >
          <div
            className="modal-panel modal-panel-wide skill-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="skill-detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div className="modal-head-text">
                <h2 id="skill-detail-title" className="modal-title">
                  {skillDetailOpen.row.name}
                </h2>
                <p className="modal-sub mono small">{skillDetailOpen.row.relPath}/</p>
                {skillDetailOpen.marketplaceSourceUrl ? (
                  <p
                    className="modal-marketplace-source mono small"
                    title={skillDetailOpen.marketplaceSourceUrl}
                  >
                    <span className="modal-marketplace-source-label">订阅来源</span>
                    {skillDetailOpen.marketplaceSourceUrl}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={closeSkillDetail}
                aria-label="关闭"
              >
                <ModalCloseIcon />
              </button>
            </div>
            <div className="skill-detail-split">
              <div className="skill-tree-pane">
                <div className="skill-pane-label">文件</div>
                {skillTreeLoading ? (
                  <p className="muted skill-pane-pad">加载目录…</p>
                ) : skillTreeErr ? (
                  <p className="modal-error skill-pane-pad">{skillTreeErr}</p>
                ) : skillTree && skillTree.length > 0 ? (
                  <nav className="skill-tree-nav" aria-label="技能目录">
                    <SkillFileTree
                      nodes={skillTree}
                      depth={0}
                      expanded={skillExpandedDirs}
                      selectedFile={skillSelectedFile}
                      onToggleDir={toggleSkillDir}
                      onSelectFile={selectSkillFile}
                    />
                  </nav>
                ) : (
                  <p className="muted skill-pane-pad">目录为空</p>
                )}
              </div>
              <div className="skill-file-pane">
                <div className="skill-pane-label">内容</div>
                {!skillSelectedFile ? (
                  <p className="muted skill-pane-pad">在左侧选择文件</p>
                ) : (
                  <>
                    <div className="skill-file-path mono small">{skillSelectedFile}</div>
                    <div className="skill-file-body">
                      {skillFileLoading ? (
                        <p className="muted skill-pane-pad">读取中…</p>
                      ) : skillFileErr ? (
                        <p className="modal-error skill-pane-pad">{skillFileErr}</p>
                      ) : (
                        <SkillFilePreview
                          payload={skillFilePayload}
                          fileRel={skillSelectedFile}
                        />
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
            {!skillDetailOpen.marketplaceSourceUrl ? (
              <div className="skill-detail-foot">
                {skillDetailOpen.row.updateAvailable && skillDetailOpen.row.updateFromMarketplace ? (
                  <button
                    type="button"
                    className="btn btn-update"
                    disabled={busyId === skillDetailOpen.row.id}
                    title="用当前订阅缓存中的同名技能覆盖本机目录"
                    onClick={() => void handleUpdateSkillFromMarketplace(skillDetailOpen.row)}
                  >
                    从订阅更新
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-outline-danger"
                  disabled={busyId === skillDetailOpen.row.id}
                  onClick={() => void handleDeleteSkill(skillDetailOpen.row)}
                >
                  移除技能
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {marketplaceInstallOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!marketplaceInstallBusy) setMarketplaceInstallOpen(null);
          }}
        >
          <div
            className="modal-panel mp-install-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mp-install-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head mp-install-head">
              <div className="modal-head-text">
                <h2 id="mp-install-title" className="modal-title">
                  安装技能
                </h2>
                <p
                  className="mp-install-skill-line mono"
                  title={marketplaceInstallDisplayLine(marketplaceInstallOpen)}
                >
                  {marketplaceInstallDisplayLine(marketplaceInstallOpen)}
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                disabled={marketplaceInstallBusy}
                onClick={() => setMarketplaceInstallOpen(null)}
                aria-label="关闭"
              >
                <ModalCloseIcon />
              </button>
            </div>
            <div className="modal-body mp-install-body">
              <div className="mp-install-card" role="group" aria-labelledby="mp-install-scope-label">
                <div id="mp-install-scope-label" className="mp-install-card-title">
                  安装范围
                </div>
                <p className="mp-install-card-desc">选择主目录或已添加的本地仓库根目录。</p>
                <div
                  className="mp-install-target-row"
                  role="radiogroup"
                  aria-labelledby="mp-install-scope-label"
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                    e.preventDefault();
                    const hasRepos = (config?.repos ?? []).length > 0;
                    if (e.key === 'ArrowRight') {
                      if (installScope === 'global' && hasRepos && !marketplaceInstallBusy) {
                        setInstallScope('repo');
                      }
                    } else if (installScope === 'repo' && !marketplaceInstallBusy) {
                      setInstallScope('global');
                    }
                  }}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={installScope === 'global'}
                    className={`mp-install-target-tile mp-install-scope-tile ${installScope === 'global' ? 'is-on' : ''}`}
                    disabled={marketplaceInstallBusy}
                    onClick={() => setInstallScope('global')}
                  >
                    <span className="mp-install-target-name">全局</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={installScope === 'repo'}
                    className={`mp-install-target-tile mp-install-scope-tile ${installScope === 'repo' ? 'is-on' : ''}`}
                    disabled={marketplaceInstallBusy || (config?.repos ?? []).length === 0}
                    onClick={() => setInstallScope('repo')}
                  >
                    <span className="mp-install-target-name">工程仓库</span>
                  </button>
                </div>
                {installScope === 'repo' && (config?.repos ?? []).length > 0 ? (
                  <div className="mp-install-scope-repo">
                    <CustomSelect
                      id="mp-install-repo-select"
                      ariaLabel="目标工程仓库"
                      variant="install"
                      value={installRepoId ?? ''}
                      onChange={(v) => setInstallRepoId(v || null)}
                      options={installRepoOptions}
                      disabled={marketplaceInstallBusy}
                    />
                  </div>
                ) : null}
              </div>

              <div className="mp-install-card" role="group" aria-labelledby="mp-install-loc-label">
                <div id="mp-install-loc-label" className="mp-install-card-title">
                  安装到
                </div>
                <p className="mp-install-card-desc">可多选，将同一技能复制到所选平台的 skills 目录。</p>
                <div className="mp-install-target-row">
                  <label
                    className={`mp-install-target-tile mp-install-platform-tile ${installTargetCursor ? 'is-on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={installTargetCursor}
                      onChange={(e) => setInstallTargetCursor(e.target.checked)}
                      disabled={marketplaceInstallBusy}
                      aria-label="安装到 Cursor"
                    />
                    <span className="mp-install-target-name">Cursor</span>
                  </label>
                  <label
                    className={`mp-install-target-tile mp-install-platform-tile ${installTargetCodex ? 'is-on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={installTargetCodex}
                      onChange={(e) => setInstallTargetCodex(e.target.checked)}
                      disabled={marketplaceInstallBusy}
                      aria-label="安装到 Codex"
                    />
                    <span className="mp-install-target-name">Codex</span>
                  </label>
                  <label
                    className={`mp-install-target-tile mp-install-platform-tile ${installTargetClaude ? 'is-on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={installTargetClaude}
                      onChange={(e) => setInstallTargetClaude(e.target.checked)}
                      disabled={marketplaceInstallBusy}
                      aria-label="安装到 Claude Code"
                    />
                    <span className="mp-install-target-name">Claude</span>
                  </label>
                </div>
              </div>

              <div className="mp-install-tip">
                <span className="mp-install-tip-icon" aria-hidden>
                  ⓘ
                </span>
                <p>
                  将复制技能整个文件夹到所选范围内的 <span className="mono">.cursor/skills-cursor</span>、{' '}
                  <span className="mono">.codex/skills</span> 或 <span className="mono">.claude/skills</span>
                  。若目标位置已有同名技能文件夹，将先删除再写入（覆盖为当前订阅源版本）。
                </p>
              </div>

              <div className="mp-install-actions">
                <button
                  type="button"
                  className="btn mp-install-btn-secondary"
                  disabled={marketplaceInstallBusy}
                  onClick={() => setMarketplaceInstallOpen(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn primary mp-install-btn-primary"
                  disabled={
                    marketplaceInstallBusy ||
                    (!installTargetCursor && !installTargetCodex && !installTargetClaude) ||
                    (installScope === 'repo' && !installRepoId)
                  }
                  onClick={() => void confirmMarketplaceInstall()}
                >
                  {marketplaceInstallBusy ? '安装中…' : '安装'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {recommendUrlModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setRecommendUrlModalOpen(false)}
        >
          <div
            className="modal-panel mp-recommend-url-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mp-recommend-url-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div className="modal-head-text">
                <h2 id="mp-recommend-url-title" className="modal-title">
                  推荐接口地址
                </h2>
                <p className="modal-sub">
                  保存后，在「订阅」中切换到「推荐」页签时会向该地址发起 <strong>GET</strong> 并解析 JSON。若留空则使用内置默认地址。双击「推荐」页签可随时打开本设置。
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setRecommendUrlModalOpen(false)}
                aria-label="关闭"
              >
                <ModalCloseIcon />
              </button>
            </div>
            <div className="modal-body">
              <label className="mp-recommend-url-label" htmlFor="mp-recommend-url-input">
                JSON 接口 URL（GET）
              </label>
              <input
                id="mp-recommend-url-input"
                type="url"
                className="mp-recommend-url-input"
                placeholder={DEFAULT_MARKETPLACE_RECOMMEND_INDEX_URL}
                value={recommendUrlDraft}
                onChange={(e) => setRecommendUrlDraft(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="mp-recommend-url-hint muted small">
                返回体须为 JSON 数组，或包含 <code>sources</code> / <code>items</code> / <code>data</code> 数组字段；每项含{' '}
                <code>url</code>（Git 地址），可选 <code>name</code>、<code>description</code>。
              </p>
              <div className="mp-recommend-url-actions">
                <button type="button" className="btn" onClick={() => setRecommendUrlModalOpen(false)}>
                  取消
                </button>
                <button type="button" className="btn primary" onClick={() => void saveRecommendIndexUrl()}>
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}

function SkillFilePreview({
  payload,
  fileRel,
}: {
  payload: SkillFilePayload | null;
  fileRel: string;
}) {
  const highlighted = useMemo(() => {
    if (!payload || payload.kind !== 'text') return '';
    return highlightSkillCode(payload.content, fileRel);
  }, [payload, fileRel]);

  if (!payload) {
    return <p className="muted skill-pane-pad">无内容</p>;
  }

  if (payload.kind === 'image') {
    const src = `data:${payload.mime};base64,${payload.base64}`;
    return (
      <div className="skill-preview-media">
        <img src={src} alt={fileRel} className="skill-preview-img" />
      </div>
    );
  }

  return (
    <div className="skill-code-frame">
      <pre className="skill-code-pre">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

function SkillFileTree({
  nodes,
  depth,
  expanded,
  selectedFile,
  onToggleDir,
  onSelectFile,
}: {
  nodes: SkillTreeNode[];
  depth: number;
  expanded: Set<string>;
  selectedFile: string | null;
  onToggleDir: (rel: string) => void;
  onSelectFile: (rel: string) => void;
}) {
  return (
    <ul className={depth === 0 ? 'skill-tree-ul skill-tree-root' : 'skill-tree-ul'}>
      {nodes.map((n) => (
        <li key={n.relPath} className="skill-tree-li">
          {n.type === 'dir' ? (
            <>
              <button
                type="button"
                className="skill-tree-row skill-tree-dir"
                onClick={() => onToggleDir(n.relPath)}
                aria-expanded={expanded.has(n.relPath)}
              >
                <span className="skill-tree-chevron" aria-hidden>
                  {expanded.has(n.relPath) ? '▾' : '▸'}
                </span>
                <span className="skill-tree-name">{n.name}</span>
              </button>
              {expanded.has(n.relPath) ? (
                <SkillFileTree
                  nodes={n.children}
                  depth={depth + 1}
                  expanded={expanded}
                  selectedFile={selectedFile}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                />
              ) : null}
            </>
          ) : (
            <button
              type="button"
              className={`skill-tree-row skill-tree-file ${selectedFile === n.relPath ? 'is-selected' : ''}`}
              onClick={() => onSelectFile(n.relPath)}
            >
              <span className="skill-tree-file-spacer" aria-hidden />
              <span className="skill-tree-name">{n.name}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ModalCloseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function RepoFolderIcon() {
  return (
    <svg
      className="repo-item-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CopyPathIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function marketplaceSkillToRow(s: MarketplaceListedSkill): SkillRow {
  return {
    id: s.id,
    relPath: s.relPath,
    name: s.name,
    state: s.state,
  };
}

function shortGitUrl(url: string, max = 40): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

/** 从 Git 远程地址提取简短展示名（如 owner/repo），用于订阅源分组标题 */
function gitRepoShortLabel(gitUrl: string): string {
  const u = gitUrl.trim();
  const ssh = u.match(/^git@([^:]+):([\s\S]+?)(?:\.git)?$/i);
  if (ssh) {
    const p = ssh[2].replace(/\.git$/i, '').trim();
    const parts = p.split(/[/\\]/).filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    if (parts.length === 1) return parts[0];
  }
  try {
    const parsed = new URL(u);
    const pathname = parsed.pathname.replace(/\.git$/i, '').replace(/^\/+/, '');
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    if (parts.length === 1) return parts[0];
    return parsed.hostname.replace(/^www\./i, '') || shortGitUrl(u, 32);
  } catch {
    return shortGitUrl(u, 36);
  }
}

type CustomSelectOpt = { value: string; label: string; title?: string };

/** 自定义下拉列表项为 DOM，选项可完整样式（原生 select 的系统菜单无法统一） */
function CustomSelect({
  id,
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  variant,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  options: CustomSelectOpt[];
  disabled?: boolean;
  ariaLabel: string;
  variant: 'toolbar' | 'install';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? options[0],
    [options, value],
  );
  const displayLabel = selected?.label ?? '—';

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const triggerClass =
    variant === 'install' ? 'mp-install-target-tile mp-install-select-trigger' : 'mp-select';

  if (options.length === 0) {
    return (
      <div className={`custom-select custom-select--${variant}`}>
        <button type="button" className={triggerClass} disabled>
          {variant === 'install' ? (
            <>
              <span className="custom-select-trigger-stack">
                <span className="mp-install-target-name">—</span>
              </span>
              <span className="custom-select-chevron" aria-hidden />
            </>
          ) : (
            <span className="custom-select-value">—</span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`custom-select custom-select--${variant}${open ? ' is-open' : ''}`}
    >
      <button
        type="button"
        id={id}
        className={triggerClass}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        {variant === 'install' ? (
          <>
            <span className="custom-select-trigger-stack">
              <span className="mp-install-target-name">{displayLabel}</span>
            </span>
            <span className="custom-select-chevron" aria-hidden />
          </>
        ) : (
          <span className="custom-select-value">{displayLabel}</span>
        )}
      </button>
      {open ? (
        <ul className="custom-select-menu" id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((o) => (
            <li key={o.value} role="presentation">
              <button
                type="button"
                role="option"
                title={o.title}
                aria-selected={value === o.value}
                className={`custom-select-option${value === o.value ? ' is-selected' : ''}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 安装弹窗单行：源（订阅 URL）+ 市场克隆内相对路径，常见为 …/skills/技能名 */
function marketplaceInstallDisplayLine(s: MarketplaceListedSkill): string {
  const base = s.marketplaceSourceUrl.replace(/\/+$/, '');
  const rel = s.relPath.replace(/^\/+/, '');
  return rel ? `${base}/${rel}` : base;
}

/** 展示订阅源最后一次成功拉取/克隆时间 */
function formatMarketplaceLastPull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function MpSearchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

/** 稳定哈希，用于市场卡片图标色相（6 种），避免整页灰一片 */
function mpCardTintClass(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = (h >>> 0) % 6;
  return `mp-card--t${idx}`;
}

function MpPlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MarketplaceSkillGrid({
  skills,
  sources,
  totalCount,
  loading,
  onViewDetail,
  onInstall,
}: {
  skills: MarketplaceListedSkill[];
  sources: MarketplaceSourceConfig[];
  totalCount: number;
  loading: boolean;
  onViewDetail: (row: MarketplaceListedSkill) => void;
  onInstall: (row: MarketplaceListedSkill) => void;
}) {
  const groups = useMemo(() => {
    const byId = new Map<string, MarketplaceListedSkill[]>();
    for (const s of skills) {
      const arr = byId.get(s.marketplaceSourceId) ?? [];
      arr.push(s);
      byId.set(s.marketplaceSourceId, arr);
    }
    for (const arr of byId.values()) {
      arr.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
      );
    }
    const out: {
      key: string;
      title: string;
      url: string;
      skills: MarketplaceListedSkill[];
    }[] = [];
    const seen = new Set<string>();
    for (const src of sources) {
      const sk = byId.get(src.id);
      if (!sk?.length) continue;
      seen.add(src.id);
      const url = src.url;
      const base = gitRepoShortLabel(url);
      out.push({ key: src.id, title: base, url, skills: sk });
    }
    for (const [id, sk] of byId) {
      if (seen.has(id) || !sk.length) continue;
      const url = sk[0]?.marketplaceSourceUrl ?? '';
      out.push({ key: id, title: gitRepoShortLabel(url) || '未知源', url, skills: sk });
    }
    return out;
  }, [skills, sources]);

  if (loading && totalCount === 0) {
    return <div className="mp-grid-empty">正在扫描…</div>;
  }
  if (skills.length === 0) {
    return (
      <div className="mp-grid-empty">
        {totalCount === 0
          ? '请先在「订阅」中添加 Git 仓库并成功克隆；扫描完成后，技能会在此以卡片列出（只读浏览）。'
          : '当前筛选条件下没有匹配的技能。'}
      </div>
    );
  }

  return (
    <div className="mp-skill-groups">
      {groups.map((g) => (
        <section
          key={g.key}
          className="mp-skill-source-block"
          aria-labelledby={`mp-skill-src-title-${g.key}`}
        >
          <header className="mp-skill-source-head">
            <div className="mp-skill-source-title-row">
              <h4 className="mp-skill-source-title" id={`mp-skill-src-title-${g.key}`}>
                {g.title}
              </h4>
              <span className="mp-skill-source-count" aria-label={`${g.skills.length} 个技能`}>
                {g.skills.length} 个技能
              </span>
            </div>
            <p className="mp-skill-source-url mono" title={g.url}>
              {g.url}
            </p>
          </header>
          <div className="mp-grid">
            {g.skills.map((s) => (
              <article key={s.id} className={`mp-card ${mpCardTintClass(s.id)}`}>
                <button
                  type="button"
                  className="mp-card-body"
                  onClick={() => onViewDetail(s)}
                  aria-label={`查看 ${s.name} 详情`}
                >
                  <div className="mp-card-icon" aria-hidden>
                    {(s.name.trim().charAt(0) || '?').toUpperCase()}
                  </div>
                  <div className="mp-card-text">
                    <h5 className="mp-card-name">{s.name}</h5>
                    <p className="mp-card-desc" title={s.relPath}>
                      <span className="mp-card-path mono">{s.relPath}</span>
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  className="mp-card-plus"
                  aria-label={`安装 ${s.name}`}
                  onClick={() => onInstall(s)}
                >
                  <MpPlusIcon />
                </button>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SkillTable({
  skills,
  loading,
  busyId,
  onToggle,
  onDelete,
  onUpdateFromMarketplace,
  onViewDetail,
  emptyHint,
}: {
  skills: SkillRow[];
  loading: boolean;
  busyId: string | null;
  onToggle: (row: SkillRow) => void;
  onDelete: (row: SkillRow) => void;
  onUpdateFromMarketplace: (row: SkillRow) => void;
  onViewDetail: (row: SkillRow) => void;
  emptyHint: ReactNode;
}) {
  return (
    <div className="table-wrap">
      <table className="skill-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>路径</th>
            <th className="th-status-actions">状态与操作</th>
          </tr>
        </thead>
        <tbody>
          {skills.length === 0 && !loading ? (
            <tr>
              <td colSpan={3} className="cell-empty">
                {emptyHint}
              </td>
            </tr>
          ) : null}
          {skills.map((s) => (
            <tr key={`${s.state}-${s.id}-${s.relPath}`}>
              <td className="mono">
                {s.name}
                {s.updateAvailable ? (
                  <span className="skill-update-badge" title="与订阅缓存内容不一致，可从订阅一键覆盖">
                    可更新
                  </span>
                ) : null}
              </td>
              <td className="mono small">{s.relPath}</td>
              <td className="cell-status-actions">
                <div className="cell-status-actions-inner">
                  <div className="action-btns">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => onViewDetail(s)}
                    >
                      查看详情
                    </button>
                    {s.updateAvailable && s.updateFromMarketplace ? (
                      <button
                        type="button"
                        className="btn btn-update"
                        disabled={busyId === s.id}
                        title="用订阅缓存覆盖本机该技能目录"
                        onClick={() => void onUpdateFromMarketplace(s)}
                      >
                        更新
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-outline-danger"
                      disabled={busyId === s.id}
                      onClick={() => void onDelete(s)}
                    >
                      移除
                    </button>
                  </div>
                  <div className="cell-status-inner">
                    <button
                      type="button"
                      className="skill-toggle"
                      role="switch"
                      aria-checked={s.state === 'enabled'}
                      aria-label={
                        s.state === 'enabled' ? '已启用，点击切换为禁用' : '已禁用，点击切换为启用'
                      }
                      disabled={busyId === s.id}
                      onClick={() => onToggle(s)}
                    >
                      <span className="skill-toggle-track" aria-hidden>
                        <span className="skill-toggle-thumb" />
                      </span>
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
