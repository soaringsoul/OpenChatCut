// 模型设置总览：「我在用的」用途卡片 + 影响提示条 +「已连接的服务」+「更多设置」。
// 所有改动都走 SettingsDialog 的同一条保存路径（POST /api/keys，带 revision 校验），
// 抽屉里直接复用原有的厂商配置面板，登录流程与字段语义保持不变。
import { useMemo, useState, type MouseEvent } from 'react';
import { useT } from '../../i18n/locale';
import './modelSettings.css';
import { Ph, HealthBadge, HealthDot, Logo, Spinner } from './ModelSettingsParts';
import {
  BAD_HEALTH, CONSOLE_URL, HEALTH_LABEL, PURPOSES, fallbackChoice, impactGroups, purposeState, services,
  serviceLabel, servicePage, allSecretFields, effortLabel, relativeTime, type PurposeState,
} from './modelSettingsModel';
import { findGroup, type SettingsVendorPage } from './settingsSchema';
import { PROXY_PAGE } from './settingsAgentProviders';
import type { MsController } from './modelSettingsController';
import { ModelSwitchPopover } from './ModelSwitchPopover';
import { AddServiceFlow } from './AddServiceFlow';
import { ServiceDrawer, PagesDrawer, KeysDrawer } from './ServiceDrawer';
import { checkPageFor } from './modelSettingsChecks';

export function ModelSettingsView({ c, fullPage, versionSlot, scheme, onToggleScheme, onClose, onClassic }: {
  c: MsController; fullPage: boolean; versionSlot: React.ReactNode; scheme: 'light' | 'dark';
  onToggleScheme: () => void; onClose: () => void; onClassic: () => void;
}) {
  const t = useT();
  const states = useMemo(() => PURPOSES.map((def) => purposeState(c.model, def)), [c.model]);
  const all = useMemo(() => services(c.model, states), [c.model, states]);
  const connected = all.filter((s) => s.connected);
  const impacts = impactGroups(states);
  const affected = states.filter((s) => s.affected);
  const fixable = affected.map((s) => ({ s, f: fallbackChoice(s) })).filter((x) => x.f && x.s.routeName);
  const unknown = connected.filter((s) => s.health.kind === 'unknown');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'bad' | 'warn' } | null>(null);
  const setCount = states.filter((s) => s.def.key !== 'local' && s.choice && s.health.kind !== 'none').length;

  const checkAll = async (keys: readonly string[]): Promise<void> => {
    setBusy('check'); setNote(null);
    let bad = 0;
    for (const key of keys) {
      const page = checkPageFor(c.model, key);
      if (!page) continue;
      const result = await c.check(page.key);
      if (!result.ok) bad += 1;
    }
    await c.refreshHealth();
    setBusy(null);
    setNote(bad ? { text: t('检测完成 · {n} 个服务不可用', { n: bad }), tone: 'warn' } : { text: t('检测完成 · 全部可用'), tone: 'ok' });
  };
  const switchAffected = async (): Promise<void> => {
    const patch: Record<string, string> = {};
    for (const { s, f } of fixable) patch[s.routeName!] = f!.value;
    setBusy('switch');
    const error = await c.applyPatch(patch);
    setBusy(null);
    setNote(error ? { text: error, tone: 'bad' } : { text: t('已切换 {n} 个用途到可用模型', { n: fixable.length }), tone: 'ok' });
  };
  const openSwitch = (state: PurposeState, event: MouseEvent<HTMLButtonElement>): void => {
    const stage = (event.currentTarget.closest('.ms-stage') as HTMLElement | null)?.getBoundingClientRect();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(12, Math.min((stage?.width ?? 1200) - 412, rect.left - (stage?.left ?? 0) - 160));
    const y = rect.bottom - (stage?.top ?? 0) + 6;
    c.setOverlay({ type: 'switch', purpose: state.def.key, x, y });
  };
  const firstBalance = impacts.find((g) => g.health.kind === 'balance' && CONSOLE_URL[g.service]);

  const models = c.status?.models ?? {};
  const storageGroup = findGroup('storage');
  const r2On = Boolean(c.status?.keys.R2_BUCKET?.configured) && models.R2_ENABLED !== '0';
  const secretCount = allSecretFields().filter((f) => c.status?.keys[f.name]?.configured).length;
  const tiles: Array<{ icon: Parameters<typeof Ph>[0]['name']; title: string; sub: string; onClick: () => void }> = [
    { icon: 'Globe', title: t('网络代理'), sub: models.PROXY_URL ? models.PROXY_URL.replace(/^https?:\/\//, '') : t('未设置 · 系统代理或直连'),
      onClick: () => c.setOverlay({ type: 'pages', title: t('网络代理'), pages: [PROXY_PAGE] }) },
    { icon: 'HardDrives', title: t('存储'), sub: `${models.OPENCHATCUT_DATA_DIR ? t('自定义位置') : t('本机默认位置')} · R2 ${r2On ? t('开') : t('关')}`,
      onClick: () => c.setOverlay({ type: 'pages', title: t('存储'), pages: storageGroup.vendors }) },
    { icon: 'Wrench', title: t('增强工具'), sub: [
      c.status?.keys.E2B_API_KEY?.configured ? t('沙箱 已配置') : t('沙箱 未配置'),
      c.status?.keys.FIRECRAWL_API_KEY?.configured ? t('网页抓取 已配置') : t('网页抓取 未配置'),
    ].join(' · '), onClick: () => c.setOverlay({ type: 'pages', title: t('增强工具'), pages: [...findGroup('sandbox').vendors, ...findGroup('web').vendors] }) },
    { icon: 'Eye', title: t('视觉理解'), sub: t('图片与时间线帧如何交给模型'),
      onClick: () => c.setOverlay({ type: 'pages', title: t('视觉理解'), pages: findGroup('llm').vendors.filter((p) => p.vendor === 'vision') }) },
    { icon: 'Layout', title: t('界面'), sub: t('缩放 {n}', { n: models.UI_SCALE ? `${Math.round(Number(models.UI_SCALE) * 100)}%` : '100%' }),
      onClick: () => c.setOverlay({ type: 'pages', title: t('界面'), pages: findGroup('display').vendors }) },
    { icon: 'Plug', title: t('外部 Agent 接入'), sub: t('MCP 配置指南'), onClick: c.openMcpGuide },
    { icon: 'Key', title: t('全部密钥'), sub: t('仅存本机 · {n} 个', { n: secretCount }), onClick: () => c.setOverlay({ type: 'keys' }) },
    { icon: 'SlidersHorizontal', title: t('经典视图'), sub: t('按分类浏览全部设置'), onClick: onClassic },
  ];

  const overlay = c.overlay;
  return (
    <>
      <header className="ms-topbar">
        {fullPage ? <button type="button" className="ms-btn ghost" onClick={onClose}><Ph name="ArrowLeft" size={14} weight="bold" />{t('返回')}</button> : null}
        {fullPage ? <span className="ms-divider" /> : null}
        <span className="ms-title">{t('模型设置')}</span>
        <span className="ms-grow" />
        {c.message ? <span className={`ms-msg ${c.message.tone}`}>{c.message.text}</span> : null}
        {versionSlot}
        <button type="button" className="ms-btn sm ghost" onClick={onToggleScheme} title={scheme === 'dark' ? t('浅色') : t('深色')} aria-label={t('切换深浅色')}>
          <Ph name={scheme === 'dark' ? 'Sun' : 'Moon'} size={14} />{scheme === 'dark' ? t('浅色') : t('深色')}
        </button>
        {!fullPage ? <button type="button" className="ms-btn sm ghost" onClick={onClose} aria-label={t('关闭')}><Ph name="X" size={14} /></button> : null}
      </header>
      <div className="ms-stage">
        <div className="ms-page">
          <div className="ms-wrap">
            <div className="ms-row">
              <div className="ms-grow">
                <h1>{t('模型设置')}</h1>
                <div className="ms-muted" style={{ marginTop: 2 }}>{t('为每个用途选一个模型；连接服务一次，所有用途都能用。')}</div>
              </div>
              <button type="button" className="ms-btn primary" onClick={() => c.setOverlay({ type: 'add' })}><Ph name="Plus" size={14} weight="bold" />{t('添加模型服务')}</button>
            </div>

            {impacts.length > 0 ? (
              <div className={`ms-banner${impacts.some((g) => HEALTH_LABEL[g.health.kind].tone === 'bad') ? ' bad' : ''}`} role="alert">
                <Ph name="WarningCircle" size={18} weight="fill" />
                <span className="ms-grow">
                  <b>{t('{n} 个用途受影响', { n: affected.length })}</b>
                  <span className="ms-muted"> · {impacts.map((g) => `${t(g.label)} ${t(HEALTH_LABEL[g.health.kind].text)}（${g.purposes.map((p) => t(p)).join('、')}）`).join(' · ')}</span>
                </span>
                {firstBalance ? <a className="ms-btn sm" href={CONSOLE_URL[firstBalance.service]} target="_blank" rel="noreferrer"><Ph name="CreditCard" size={12} />{t('去 {name} 充值', { name: t(firstBalance.label) })}</a> : null}
                {fixable.length ? <button type="button" className="ms-btn sm" disabled={busy !== null} onClick={() => { void switchAffected(); }}>{busy === 'switch' ? <Spinner size={12} /> : <Ph name="ArrowsLeftRight" size={12} />}{t('把受影响的用途换成可用模型')}</button> : null}
                <button type="button" className="ms-btn sm ghost" disabled={busy !== null} onClick={() => { void checkAll(impacts.map((g) => g.service)); }}>{busy === 'check' ? <Spinner size={12} /> : <Ph name="ArrowsClockwise" size={12} />}{t('重新检测')}</button>
              </div>
            ) : unknown.length > 0 ? (
              <div className="ms-banner" style={{ background: 'var(--ms-info-bg)' }}>
                <Ph name="Info" size={18} weight="fill" className="ms-off" />
                <span className="ms-grow"><b>{t('{n} 个已连接服务尚未检测', { n: unknown.length })}</b><span className="ms-muted"> · {unknown.map((s) => t(s.label)).join('、')}</span></span>
                <button type="button" className="ms-btn sm" disabled={busy !== null} onClick={() => { void checkAll(unknown.map((s) => s.key)); }}>{busy === 'check' ? <Spinner size={12} /> : <Ph name="Lightning" size={12} />}{t('全部检测')}</button>
              </div>
            ) : null}
            {note ? <div className={`ms-msg ${note.tone}`} style={{ marginTop: 8 }}>{note.text}</div> : null}

            <h2>{t('我在用的')} <span className="ms-count">{t('{done} / {total} 已设置', { done: setCount, total: PURPOSES.length - 1 })}</span>
              <span className="ms-grow" />
              {connected.length ? <button type="button" className="ms-btn sm ghost" disabled={busy !== null} onClick={() => { void checkAll(connected.map((s) => s.key)); }}>{busy === 'check' ? <Spinner size={12} /> : <Ph name="ArrowsClockwise" size={12} />}{t('检测全部服务')}</button> : null}
            </h2>
            <div className="ms-grid">
              {states.map((state) => <PurposeCard key={state.def.key} state={state} c={c}
                focus={overlay?.type === 'switch' && overlay.purpose === state.def.key}
                onSwitch={(e) => openSwitch(state, e)} />)}
            </div>

            <h2>{t('已连接的服务')} <span className="ms-count">{connected.length}</span></h2>
            <div className="ms-services">
              {connected.map((s) => (
                <button type="button" key={s.key} className="ms-chip" onClick={() => c.setOverlay({ type: 'service', key: s.key })} title={t(s.health.message)}>
                  <Logo page={s.page} />{t(s.label)}<HealthDot kind={s.health.kind} />
                  <span className="ms-why">{s.health.kind === 'ok' || s.health.kind === 'unknown'
                    ? (s.usedBy.length ? s.usedBy.map((p) => t(p)).join(' · ') : t('未在使用'))
                    : `${t(HEALTH_LABEL[s.health.kind].text)} · ${s.usedBy.length ? s.usedBy.map((p) => t(p)).join(' · ') : t('未在使用')}`}</span>
                </button>
              ))}
              <button type="button" className="ms-chip add" onClick={() => c.setOverlay({ type: 'add' })}><Ph name="Plus" size={14} weight="bold" />{t('添加模型服务')}</button>
            </div>

            <h2>{t('更多设置')}</h2>
            <div className="ms-more">
              {tiles.map((tile) => (
                <button type="button" key={tile.title} className="ms-tile" onClick={tile.onClick}>
                  <Ph name={tile.icon} size={18} />
                  <span className="ms-grow"><b>{tile.title}</b><span className="ms-sub">{tile.sub}</span></span>
                  <Ph name="CaretRight" size={12} className="ms-off" />
                </button>
              ))}
            </div>
            <div className="ms-foot-note"><Ph name="Lock" size={12} />{t('密钥只保存在本机（.env.local / 工作室 profile settings.env），不会进入工程文件或上传；界面只显示末 4 位。修改即时生效，Agent 下一条消息即可使用。')}</div>
          </div>
        </div>

        {overlay?.type === 'switch' ? <>
          <div className="ms-click-catch" onMouseDown={() => c.setOverlay(null)} />
          <ModelSwitchPopover c={c} state={states.find((s) => s.def.key === overlay.purpose)!} x={overlay.x} y={overlay.y} />
        </> : null}
        {overlay && overlay.type !== 'switch' ? <div className="ms-scrim" onMouseDown={() => { if (!c.dirty) c.setOverlay(null); }} /> : null}
        {overlay?.type === 'add' ? <AddServiceFlow c={c} all={all} initialService={overlay.service} initialPurpose={overlay.purpose} /> : null}
        {overlay?.type === 'service' ? <ServiceDrawer c={c} serviceKey={overlay.key} states={states} /> : null}
        {overlay?.type === 'pages' ? <PagesDrawer c={c} title={overlay.title} pages={overlay.pages} /> : null}
        {overlay?.type === 'keys' ? <KeysDrawer c={c} /> : null}
      </div>
    </>
  );
}

function PurposeCard({ state, c, focus, onSwitch }: {
  state: PurposeState; c: MsController; focus: boolean; onSwitch: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const t = useT();
  const { def, choice, health } = state;
  const local = def.key === 'local';
  const stock = def.key === 'stock';
  const empty = local || !choice || health.kind === 'none';
  const tone = HEALTH_LABEL[health.kind].tone;
  const cls = empty ? ' empty' : state.affected ? (tone === 'bad' ? ' bad' : ' attn') : '';
  const page: SettingsVendorPage | undefined = choice?.page ?? (choice ? servicePage(choice.service) : undefined);
  const openService = (): void => {
    if (local) c.setOverlay({ type: 'pages', title: t('本地模型'), pages: findGroup('local').vendors });
    else if (stock) c.setOverlay({ type: 'pages', title: t('在线图库'), pages: findGroup('stock').vendors });
    else if (choice && choice.configured) c.setOverlay({ type: 'service', key: choice.service });
  };
  const footNote = health.kind === 'ok'
    ? (health.at ? t('{when}成功', { when: t(relativeTime(health.at)) }) : '')
    : BAD_HEALTH.has(health.kind) ? [health.status ? `HTTP ${health.status}` : '', health.at ? t(relativeTime(health.at)) : ''].filter(Boolean).join(' · ') : '';
  return (
    <div className={`ms-card${cls}${focus ? ' focus' : ''}`} data-purpose={def.key}>
      <div className="ms-purpose"><span className="ms-pi"><Ph name={def.icon} /></span><span>{t(def.title)}<small>{t(def.desc)}</small></span></div>
      {empty ? (
        <div className="ms-prov"><Ph name={local ? 'Cpu' : 'Plus'} size={14} /><span className="ms-grow" style={{ fontSize: 12 }}>{t(state.summary)}</span></div>
      ) : (
        <button type="button" className="ms-prov" style={{ cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit' }} onClick={openService}>
          <Logo page={page} />
          <span className="ms-grow">
            <b className="ms-ellipsis">{stock ? t(state.summary) : t(serviceLabel(choice!.service, choice!.label))}</b>
            {!stock ? <span className="ms-mono ms-ellipsis">{state.summary || t(choice!.label)}{def.key === 'agent' && choice!.service === 'codex' && c.status?.models.CODEX_REASONING_EFFORT ? ` · ${t('推理')} ${effortLabel(c.status.models.CODEX_REASONING_EFFORT, t)}` : ''}</span> : null}
          </span>
        </button>
      )}
      <div className="ms-card-foot">
        <HealthBadge kind={local ? 'local' : health.kind} />
        <span className="ms-off ms-ellipsis ms-grow" style={{ fontSize: 11.5 }} title={t(health.message)}>{footNote}</span>
        {local || stock
          ? <button type="button" className="ms-btn sm" onClick={openService}><Ph name="SlidersHorizontal" size={12} />{t('管理')}</button>
          : empty && !state.choices.some((ch) => ch.configured)
            ? <button type="button" className="ms-btn sm primary" onClick={() => c.setOverlay({ type: 'add', purpose: def.key })}><Ph name="Plus" size={12} weight="bold" />{t('选择模型')}</button>
            : <button type="button" className="ms-btn sm" onClick={onSwitch}><Ph name="ArrowsLeftRight" size={12} />{t('更换')}</button>}
      </div>
    </div>
  );
}
