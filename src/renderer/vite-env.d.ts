/// <reference types="vite/client" />

export type SkillState = 'enabled' | 'disabled';

export type SkillTreeNode =
  | { type: 'file'; name: string; relPath: string }
  | { type: 'dir'; name: string; relPath: string; children: SkillTreeNode[] };

export type SkillFilePayload =
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'text'; content: string; ext: string };

/** 与 ipc marketplace:installSkill 一致，用于从订阅缓存覆盖当前安装目录 */
export type SkillUpdateFromMarketplace = {
  marketplaceRootPath: string;
  skillRelPath: string;
  installCursor: boolean;
  installCodex: boolean;
  installClaude: boolean;
  scope: 'global' | 'repo';
  repoPath?: string;
};

export type SkillRow = {
  id: string;
  relPath: string;
  name: string;
  state: SkillState;
  disabledAt?: string;
  /** 订阅源中存在同名技能且缓存内容与当前目录签名不一致（仅启用态标准路径） */
  updateAvailable?: boolean;
  updateFromMarketplace?: SkillUpdateFromMarketplace;
};

export type RepoConfig = {
  id: string;
  path: string;
  name: string;
};

export type MarketplaceSourceConfig = {
  id: string;
  url: string;
  /** ISO 8601，最后一次成功 clone/pull 的时间 */
  lastPulledAt?: string;
  /** 克隆根内的子目录（POSIX 相对路径），仅在此目录下递归扫描 SKILL.md；缺省则按仓库根约定路径扫描 */
  skillsPath?: string;
  /** 手动输入 Git 添加为 manual；从「推荐」页添加为 recommend；旧数据缺省视为 manual */
  sourceOrigin?: 'manual' | 'recommend';
};

/** 推荐接口返回的单条源（GET JSON） */
export type MarketplaceRecommendItem = {
  name: string;
  description: string;
  url: string;
  /** 与订阅 skillsPath 对应，来自 JSON 的 path / skillsPath；缺省表示克隆根下按约定目录扫描 */
  path?: string;
};

/** 来自 Marketplace 克隆目录的列表项（只读浏览，不写入 manifest） */
export type MarketplaceListedSkill = SkillRow & {
  marketplaceSourceId: string;
  marketplaceSourceUrl: string;
  marketplaceRootPath: string;
};

export type ThemeId = 'dark' | 'light';

export type AppConfig = {
  repos: RepoConfig[];
  theme?: ThemeId;
  marketplaceSources?: MarketplaceSourceConfig[];
  /** GET 返回推荐源 JSON 的地址（长按「推荐」配置） */
  marketplaceRecommendIndexUrl?: string;
  /** 当订阅缓存与已安装技能不一致时，自动用订阅缓存覆盖安装目录（全局 + 已登记仓库） */
  autoUpdateInstalledSkills?: boolean;
  /** 应用启动约 10 秒后拉取一次订阅源，之后每 30 分钟拉取；失败仅打日志 */
  autoPullMarketplaceSources?: boolean;
};

export type UserProfile = {
  username: string;
  homedir: string;
};

declare global {
  interface Window {
    skillGuardApi: {
      /** 兜底 IPC，勿在业务中优先使用 */
      _invoke?: (channel: string, data?: unknown) => Promise<unknown>;
      getUserProfile: () => Promise<UserProfile>;
      /** 与 package.json version 一致（Electron app.getVersion） */
      getAppVersion: () => Promise<string>;
      loadConfig: () => Promise<AppConfig>;
      saveConfig: (cfg: AppConfig) => Promise<{ ok: boolean }>;
      pickRepo: () => Promise<string | null>;
      addRepo: (dirPath: string) => Promise<AppConfig>;
      removeRepo: (id: string) => Promise<AppConfig>;
      getGitBranch: (repoPath: string) => Promise<string | null>;
      scan: (repoPath: string) => Promise<{ root: string; skills: SkillRow[] }>;
      scanGlobal: () => Promise<{ root: string; skills: SkillRow[] }>;
      disableSkill: (repoPath: string, skillRelPath: string) => Promise<unknown>;
      enableSkill: (repoPath: string, entryId: string) => Promise<unknown>;
      deleteSkill: (
        rootPath: string,
        skillRelPath: string,
        state: SkillState,
      ) => Promise<{ ok: true }>;
      listSkillTree: (
        rootPath: string,
        skillRelPath: string,
        state: SkillState,
      ) => Promise<SkillTreeNode[]>;
      readSkillFile: (
        rootPath: string,
        skillRelPath: string,
        state: SkillState,
        fileRel: string,
      ) => Promise<SkillFilePayload>;
      marketplaceLoad: () => Promise<{
        sources: MarketplaceSourceConfig[];
        skills: MarketplaceListedSkill[];
        issues: string[];
      }>;
      marketplaceFetchRecommendations: () => Promise<{ items: MarketplaceRecommendItem[] }>;
      marketplaceAddSource: (
        payload:
          | string
          | { url: string; skillsPath?: string; sourceOrigin?: 'manual' | 'recommend' },
      ) => Promise<{
        config: AppConfig;
        skills: MarketplaceListedSkill[];
        issues: string[];
      }>;
      marketplaceRemoveSource: (sourceId: string) => Promise<{
        config: AppConfig;
        skills: MarketplaceListedSkill[];
        issues: string[];
      }>;
      marketplaceRefreshRemote: () => Promise<{
        config: AppConfig;
        skills: MarketplaceListedSkill[];
        issues: string[];
      }>;
      marketplaceInstallSkill: (opts: {
        marketplaceRootPath: string;
        skillRelPath: string;
        installCursor: boolean;
        installCodex: boolean;
        installClaude: boolean;
        scope: 'global' | 'repo';
        repoPath?: string;
      }) => Promise<{ ok: true; installed: string[] }>;
    };
  }
}

export {};
