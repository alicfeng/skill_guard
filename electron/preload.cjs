const { contextBridge, ipcRenderer } = require('electron');

/** 供渲染进程在个别方法未注入时直接走 IPC（避免旧进程缓存预加载脚本） */
function invoke(channel, data) {
  return ipcRenderer.invoke(channel, data);
}

contextBridge.exposeInMainWorld('skillGuardApi', {
  _invoke: invoke,
  getUserProfile: () => invoke('app:userProfile'),
  loadConfig: () => invoke('config:load'),
  saveConfig: (cfg) => invoke('config:save', cfg),
  pickRepo: () => invoke('dialog:pickRepo'),
  addRepo: (dirPath) => invoke('repos:add', dirPath),
  removeRepo: (id) => invoke('repos:remove', id),
  getGitBranch: (repoPath) => invoke('git:currentBranch', repoPath),
  scan: (repoPath) => invoke('skills:scan', repoPath),
  scanGlobal: () => invoke('skills:scanGlobal'),
  disableSkill: (repoPath, skillRelPath) =>
    invoke('skills:disable', { repoPath, skillRelPath }),
  enableSkill: (repoPath, entryId) =>
    invoke('skills:enable', { repoPath, entryId }),
  deleteSkill: (rootPath, skillRelPath, state) =>
    invoke('skills:delete', { rootPath, skillRelPath, state }),
  listSkillTree: (rootPath, skillRelPath, state) =>
    invoke('skills:listTree', { rootPath, skillRelPath, state }),
  readSkillFile: (rootPath, skillRelPath, state, fileRel) =>
    invoke('skills:readFile', { rootPath, skillRelPath, state, fileRel }),
  marketplaceLoad: () => invoke('marketplace:load'),
  marketplaceFetchRecommendations: () => invoke('marketplace:fetchRecommendations'),
  marketplaceAddSource: (payload) => invoke('marketplace:addSource', payload),
  marketplaceRemoveSource: (sourceId) => invoke('marketplace:removeSource', sourceId),
  marketplaceRefreshRemote: () => invoke('marketplace:refreshRemote'),
  marketplaceInstallSkill: (opts) => invoke('marketplace:installSkill', opts),
});
