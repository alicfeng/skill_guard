import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

const IMG_BASE = `${import.meta.env.BASE_URL}manual/`;

type ManualShotId = 'global' | 'diagram' | 'marketplace';

const MANUAL_SHOT_FILES: Record<
  ManualShotId,
  { file: string; alt: string; placeholderLabel: string }
> = {
  global: {
    file: 'manual-screenshot-global.png',
    alt: '全局或仓库技能列表界面截图',
    placeholderLabel: '图 1 · 全局 / 仓库技能列表',
  },
  diagram: {
    file: 'manual-diagram-skill-guard.png',
    alt: '.skill_guard 目录结构截图或示意图',
    placeholderLabel: '图 2 · .skill_guard 目录与清单',
  },
  marketplace: {
    file: 'manual-screenshot-marketplace.png',
    alt: 'Skill Marketplace 技能浏览区截图',
    placeholderLabel: '图 3 · Marketplace 技能浏览',
  },
};

function ManualOptionalScreenshot({
  shotId,
  caption,
}: {
  shotId: ManualShotId;
  caption: string;
}) {
  const { file, alt, placeholderLabel } = MANUAL_SHOT_FILES[shotId];
  const src = `${IMG_BASE}${file}`;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    const img = new Image();
    img.onload = () => setLoaded(true);
    img.onerror = () => setLoaded(false);
    img.src = src;
  }, [src]);

  return (
    <figure className="manual-figure">
      {loaded ? (
        <img src={src} alt={alt} className="manual-figure-img" loading="lazy" />
      ) : (
        <div className="manual-shot-placeholder">
          <p className="manual-shot-placeholder-title">{placeholderLabel}</p>
          <p className="manual-shot-placeholder-body">
            我无法在你的电脑上打开本应用或替你按系统截图快捷键。此前使用的配图仅为示意，容易显得「不真实」。
          </p>
          <p className="manual-shot-placeholder-body">
            请你在本机运行 Skill Guard，用系统截图（例如 macOS <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>4</kbd>
            ）截取实际界面，将文件保存到项目目录{' '}
            <code>
              public/manual/{file}
            </code>
            （与上表文件名一致）。保存后刷新本页，图片会在此处自动显示。
          </p>
        </div>
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

const SECTIONS: { id: string; label: string }[] = [
  { id: 'manual-intro', label: '概述' },
  { id: 'manual-value', label: '能为你做什么' },
  { id: 'manual-ui', label: '界面与导航' },
  { id: 'manual-scopes', label: '全局 · 仓库 · 市场' },
  { id: 'manual-guard', label: '.skill_guard 机制' },
  { id: 'manual-marketplace', label: 'Marketplace 流程' },
  { id: 'manual-detail', label: '技能详情与维护' },
  { id: 'manual-safety', label: '安全与边界' },
  { id: 'manual-faq', label: '常见问题' },
  { id: 'manual-dev', label: '开发与构建' },
];

function computeActiveSectionId(scrollRoot: HTMLElement): string {
  const tolerance = 6;
  const { scrollTop, scrollHeight, clientHeight } = scrollRoot;
  if (scrollHeight - clientHeight - scrollTop <= tolerance) {
    return SECTIONS[SECTIONS.length - 1]!.id;
  }

  const rootRect = scrollRoot.getBoundingClientRect();
  const band = Math.min(96, rootRect.height * 0.14);
  const lineY = rootRect.top + band;

  let active = SECTIONS[0]!.id;
  for (const { id } of SECTIONS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const top = el.getBoundingClientRect().top;
    if (top <= lineY) active = id;
  }
  return active;
}

/** 使用手册：嵌入主内容区（非弹层） */
export default function ProductManual() {
  const contentRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const tocBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const tickingRef = useRef(false);

  const [activeSectionId, setActiveSectionId] = useState<string>(SECTIONS[0]!.id);

  const scrollToId = useCallback((id: string) => {
    setActiveSectionId(id);
    const el = document.getElementById(id);
    if (!el) return;
    const pane = contentRef.current;
    if (pane?.contains(el)) {
      const top =
        el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
      pane.scrollTo({ top: Math.max(0, top - 16), behavior: 'smooth' });
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    let ro: ResizeObserver | null = null;

    const flush = () => {
      tickingRef.current = false;
      setActiveSectionId(computeActiveSectionId(contentEl));
    };

    const onScroll = () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      requestAnimationFrame(flush);
    };

    contentEl.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onScroll);
      ro.observe(contentEl);
    }
    flush();
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      contentEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro?.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const btn = tocBtnRefs.current.get(activeSectionId);
    const nav = tocRef.current;
    if (!btn || !nav) return;

    const nr = nav.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const pad = 6;
    if (br.top < nr.top + pad || br.bottom > nr.bottom - pad) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      btn.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    }
  }, [activeSectionId]);

  return (
    <div className="product-manual-page">
      <header className="product-manual-page-head">
        <h2 className="product-manual-page-title">Skill Guard 使用手册</h2>
        <p className="product-manual-page-lead">
          体系化说明产品能力、典型流程与注意事项。下方预留截图位：将真实界面图放入 <code>public/manual/</code>{' '}
          指定文件名后即可显示。通过顶部 <strong>ReadMe</strong> 页签可随时回到本页。
        </p>
      </header>

      <div className="product-manual-body product-manual-body--page">
        <nav className="product-manual-toc" aria-label="手册目录" ref={tocRef}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`product-manual-toc-item ${activeSectionId === s.id ? 'is-active' : ''}`}
              aria-current={activeSectionId === s.id ? 'location' : undefined}
              ref={(el) => {
                if (el) tocBtnRefs.current.set(s.id, el);
                else tocBtnRefs.current.delete(s.id);
              }}
              onClick={() => scrollToId(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="product-manual-scroll" ref={contentRef}>
          <section id="manual-intro" className="manual-section">
            <h3 className="manual-h3">概述</h3>
            <p>
              <strong>Skill Guard</strong> 是一款桌面应用，用于在本地集中管理{' '}
              <strong>Cursor</strong>、<strong>Codex</strong>、<strong>Claude Code</strong>{' '}
              等环境下的 Agent Skills。你可以在「全局」与「已注册仓库」范围内查看技能列表、阅读{' '}
              <code>SKILL.md</code> 与附属文件，并安全地<strong>启用 / 禁用</strong>技能，而无需手动改目录结构。
            </p>
            <p>
              <strong>Skill Marketplace</strong> 则面向「从 Git 订阅技能集合」：添加远程源、本地克隆缓存、浏览卡片式列表，并按与主流程一致的策略安装到全局或指定仓库。
            </p>
          </section>

          <section id="manual-value" className="manual-section">
            <h3 className="manual-h3">能为你做什么</h3>
            <ul className="manual-list">
              <li>
                <strong>统一视图</strong>：多仓库、多平台路径（<code>.cursor/skills</code>、<code>.cursor/skills-cursor</code>、
                <code>.codex/skills</code>、<code>.claude/skills</code>）下的技能一览，减少在磁盘里翻找的时间。
              </li>
              <li>
                <strong>可逆的禁用</strong>：禁用不会删除技能，而是迁入仓库内 <code>.skill_guard/</code> 并记录清单，随时可恢复。
              </li>
              <li>
                <strong>市场式浏览</strong>：对已订阅的 Git 源做搜索、筛选与安装，并可在已安装技能上提示「可更新」。
              </li>
              <li>
                <strong>本地优先</strong>：所有扫描与文件操作在本地完成；配置与 Marketplace 缓存保存在应用数据目录，不依赖云端账号。
              </li>
            </ul>
          </section>

          <section id="manual-ui" className="manual-section">
            <h3 className="manual-h3">界面与导航</h3>
            <p>
              顶部为应用标题与<strong>深色 / 浅色</strong>主题切换。主导航为四个页签：<strong>全局</strong>、<strong>仓库</strong>、
              <strong>Skill Marketplace</strong> 与本页对应的 <strong>ReadMe</strong>。手册内容在主区域展示，可与其它功能页签随时切换。
            </p>
            <ManualOptionalScreenshot
              shotId="global"
              caption="图 1 · 全局 / 仓库技能列表（侧栏与表格；有截图文件时显示真实界面）"
            />
          </section>

          <section id="manual-scopes" className="manual-section">
            <h3 className="manual-h3">全局 · 仓库 · Marketplace</h3>
            <dl className="manual-dl">
              <dt>全局</dt>
              <dd>
                扫描当前系统用户主目录下符合约定的 skills 根路径。可按来源（Cursor / Codex / Claude）筛选，适合管理「对所有项目生效」的技能。
              </dd>
              <dt>仓库</dt>
              <dd>
                先在侧栏<strong>添加本地 Git 仓库</strong>，应用仅在这些已注册根路径下扫描与操作。选中仓库后可查看分支等信息，并对该仓库内的技能启用 / 禁用。
              </dd>
              <dt>Skill Marketplace</dt>
              <dd>
                分为<strong>技能</strong>与<strong>订阅</strong>两个子页签：订阅页添加 Git 地址并拉取；技能页展示克隆缓存中扫描到的 <code>SKILL.md</code>，支持搜索与按订阅筛选。
                安装时可选择全局或某一仓库，并勾选写入 Cursor / Codex / Claude 的目录。
              </dd>
            </dl>
          </section>

          <section id="manual-guard" className="manual-section">
            <h3 className="manual-h3">.skill_guard 机制</h3>
            <p>
              在<strong>仓库范围</strong>内禁用技能时，目录会从原始位置<strong>移动</strong>到{' '}
              <code>&lt;仓库根&gt;/.skill_guard/disabled/</code> 下，并保持相对路径镜像；<code>manifest.json</code>{' '}
              记录原始路径与禁用时间等信息。启用时按清单迁回，从而避免直接删除文件，也便于在版本控制中单独处理（可将{' '}
              <code>.skill_guard</code> 加入 <code>.gitignore</code> 或按需提交，由团队约定）。
            </p>
            <ManualOptionalScreenshot
              shotId="diagram"
              caption="图 2 · .skill_guard 目录、manifest 与 disabled 的关系（可用仓库内实际目录截图或自制示意图）"
            />
          </section>

          <section id="manual-marketplace" className="manual-section">
            <h3 className="manual-h3">Marketplace 推荐流程</h3>
            <ol className="manual-ol">
              <li>
                打开 <strong>订阅</strong>子页签，粘贴<strong> Git 仓库 HTTPS/SSH 地址</strong>并添加；本机需已安装 <code>git</code> 且能访问网络。在「已订阅的源」与<strong>推荐</strong>之间可切换：单击「推荐」拉取远程 JSON 源列表（未自定义接口时使用内置默认地址），双击「推荐」可设置自定义 JSON 的 GET 地址。
              </li>
              <li>
                克隆完成后，在 <strong>技能</strong>子页签点击<strong>刷新</strong>，重新扫描缓存中的 <code>SKILL.md</code>。
              </li>
              <li>
                在卡片上选择<strong>安装</strong>，指定<strong>全局或某一仓库</strong>，并勾选要写入的平台目录（可多选）。
              </li>
              <li>
                若已安装副本与订阅缓存不一致，在全局或仓库列表中可能出现<strong>可更新</strong>，可从订阅覆盖本地目录。
              </li>
            </ol>
            <ManualOptionalScreenshot
              shotId="marketplace"
              caption="图 3 · Marketplace 技能浏览（搜索、筛选与卡片；有截图文件时显示真实界面）"
            />

            <div className="manual-inline-shot" aria-hidden="true">
              <div className="manual-inline-shot-caption">界面元素对照：安装技能（弹窗结构）</div>
              <div className="manual-mock-modal">
                <div className="manual-mock-modal-title">安装技能</div>
                <div className="manual-mock-modal-row">
                  <span className="manual-mock-label">安装范围</span>
                  <span className="manual-mock-pills">
                    <span className="manual-mock-pill is-on">全局</span>
                    <span className="manual-mock-pill">仓库</span>
                  </span>
                </div>
                <div className="manual-mock-modal-row">
                  <span className="manual-mock-label">安装到</span>
                  <span className="manual-mock-pills">
                    <span className="manual-mock-pill is-on">.cursor/skills-cursor</span>
                    <span className="manual-mock-pill is-on">.codex/skills</span>
                    <span className="manual-mock-pill">.claude/skills</span>
                  </span>
                </div>
                <div className="manual-mock-modal-actions">
                  <span className="manual-mock-btn secondary">取消</span>
                  <span className="manual-mock-btn primary">确认安装</span>
                </div>
              </div>
              <p className="manual-inline-shot-note">
                上图仅为结构示意，真实文案与选项以应用内为准。
              </p>
            </div>
          </section>

          <section id="manual-detail" className="manual-section">
            <h3 className="manual-h3">技能详情与维护</h3>
            <p>
              点击技能行可打开<strong>详情</strong>：左侧为目录树，右侧预览选中文件（含 <code>SKILL.md</code> 高亮）。在来自 Marketplace
              的只读浏览场景中，会显示订阅来源 Git 地址。对本地已安装技能，可按需<strong>从订阅更新</strong>或<strong>移除技能</strong>（请谨慎确认路径与备份）。
            </p>
          </section>

          <section id="manual-safety" className="manual-section">
            <h3 className="manual-h3">安全与边界</h3>
            <ul className="manual-list">
              <li>文件系统操作限制在已解析的注册仓库根路径（及全局主目录约定路径）之下，降低误删盘外文件的风险。</li>
              <li>同一仓库上的启用 / 禁用等写操作会串行化，减少清单与磁盘不一致的概率。</li>
              <li>Git 拉取、克隆可能较慢或失败，请检查网络与凭证；超时后界面会提示，可稍后重试刷新或拉取。</li>
            </ul>
          </section>

          <section id="manual-faq" className="manual-section">
            <h3 className="manual-h3">常见问题</h3>
            <dl className="manual-dl manual-dl-faq">
              <dt>Marketplace 添加源后没有技能？</dt>
              <dd>
                确认仓库布局：在 <code>skills/</code>、<code>.cursor/skills</code>、<code>.cursor/skills-cursor</code>、
                <code>.codex/skills</code> 或 <code>.claude/skills</code> 下存在 <code>SKILL.md</code>（大小写不敏感），并在技能页执行
                <strong>刷新</strong>。
              </dd>
              <dt>开发时列表空白或 IPC 报错？</dt>
              <dd>
                请通过 <code>npm run dev</code> 启动 Electron，不要只用浏览器打开 Vite 地址，否则预加载与 IPC 不可用。
              </dd>
              <dt>禁用后 Git 里多了 .skill_guard？</dt>
              <dd>
                这是预期行为；是否与团队共享该目录取决于你是否将其提交或写入 <code>.gitignore</code>。
              </dd>
              <dt>手册里的图看起来不像真界面？</dt>
              <dd>
                应用无法自动替你截屏。将本机运行时的界面截图按文件名放入 <code>public/manual/</code> 后，ReadMe
                手册中对应位置会显示真实图片；未放置文件时仅显示说明文字。
              </dd>
            </dl>
          </section>

          <section id="manual-dev" className="manual-section">
            <h3 className="manual-h3">开发与构建</h3>
            <p>
              开发：在项目根目录执行 <code>npm install</code> 与 <code>npm run dev</code>。构建安装包：<code>npm run build</code>（具体平台要求见{' '}
              <code>electron-builder</code> 文档）。仓库内 <code>README.md</code> 与 <code>docs/PLAN.md</code> 提供补充说明。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
