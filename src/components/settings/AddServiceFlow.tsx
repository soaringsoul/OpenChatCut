// 「添加模型服务」三步：选择服务（常用 / 订阅登录 / 国内 / 本地 / 素材 / 海外，支持搜索）→ 连接（密钥或原有登录流程）
// → 测试连接（真实最小调用）通过后自动保存，并按勾选把它设为各用途的默认。测试失败不保存任何内容。
import { useMemo, useState } from 'react';
import { useT } from '../../i18n/locale';
import { Ph, HealthBadge, Logo, Spinner, Collapse } from './ModelSettingsParts';
import {
  CONSOLE_URL, HEALTH_LABEL, addCatalog, isCredentialPage, maskedKey, pageConfigured, pagesFor, purposeState, purposeTargets,
  PURPOSES, type ServiceView,
} from './modelSettingsModel';
import { buildPatch, findGroup, type SettingsField, type SettingsVendorPage } from './settingsSchema';
import { FieldRow, VendorPane } from './settingsVendorPane';
import type { CheckResult, MsController } from './modelSettingsController';

function groupTitleOf(page: SettingsVendorPage): string {
  const key = page.key.split('/')[0];
  return key === 'llm' ? '对话' : findGroup(key).key === key ? findGroup(key).title : key;
}

export function AddServiceFlow({ c, all, initialService, initialPurpose }: {
  c: MsController; all: readonly ServiceView[]; initialService?: string; initialPurpose?: string;
}) {
  const t = useT();
  const [step, setStep] = useState<1 | 2 | 3>(initialService ? 2 : 1);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | undefined>(initialService);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(CheckResult & { saved: boolean; applied: string[]; error?: string }) | null>(null);
  const [reveal, setReveal] = useState(false);
  const service = all.find((s) => s.key === selected);
  const catalog = useMemo(() => addCatalog(all, query), [all, query]);
  const filteredByPurpose = initialPurpose && !query
    ? catalog.map((g) => ({ ...g, items: g.items.filter((s) => s.caps.includes(initialPurpose === 'agent' ? '对话' : PURPOSES.find((p) => p.key === initialPurpose)?.title ?? '')) })).filter((g) => g.items.length)
    : catalog;

  const pages = selected ? pagesFor(selected).filter(isCredentialPage) : [];
  const primary = pages.find((p) => p.key.startsWith('llm/')) ?? pages[0];
  const secrets: Array<{ field: SettingsField; page: SettingsVendorPage }> = [];
  for (const page of pages) for (const field of page.fields) {
    if (field.kind === 'secret' && !secrets.some((s) => s.field.name === field.name)) secrets.push({ field, page });
  }
  const multi = new Set(secrets.map((s) => s.page.key.split('/')[0])).size > 1;
  const names = new Set(pages.flatMap((p) => p.fields.map((f) => f.name)));
  const targets = selected ? purposeTargets(c.model, selected) : [];
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const defaultChecked = (purposeKey: string): boolean => {
    if (purposeKey === initialPurpose) return true;
    const def = PURPOSES.find((p) => p.key === purposeKey);
    if (!def) return false;
    const state = purposeState(c.model, def);
    return !state.choice || state.affected;
  };
  const isChecked = (purposeKey: string): boolean => chosen[purposeKey] ?? defaultChecked(purposeKey);

  const staged = (name: string): string => c.ctx.values[name] ?? '';
  const filled = (name: string): boolean => staged(name).trim() !== '' || Boolean(c.status?.keys[name]?.configured);
  const testPage = primary?.connection ? primary
    : pages.find((p) => p.fields.filter((f) => f.kind === 'secret').every((f) => filled(f.name))) ?? primary;

  const run = async (): Promise<void> => {
    if (!primary || !selected) return;
    setBusy(true);
    const overrides = buildPatch(Object.fromEntries(Object.entries(c.ctx.values).filter(([k]) => names.has(k))));
    let check: CheckResult;
    if (primary.connection === 'copilot' || primary.connection === 'claude-code') {
      const ok = pageConfigured(c.model, primary);
      check = { ok, kind: ok ? 'ok' : 'invalid', message: ok ? t('账号已登录') : t('尚未登录 · 请先按上面的步骤完成登录') };
    } else {
      check = await c.check((testPage ?? primary).key, overrides);
    }
    if (!check.ok) { setResult({ ...check, saved: false, applied: [] }); setBusy(false); setStep(3); return; }
    const patch: Record<string, string> = { ...overrides };
    const applied: string[] = [];
    for (const target of targets) {
      if (isChecked(target.def.key) && !target.current) { patch[target.routeName] = target.value; applied.push(target.def.title); }
    }
    const error = Object.keys(patch).length ? await c.applyPatch(patch) : null;
    if (!error) c.discard([...names]);
    await c.refreshHealth();
    setResult({ ...check, saved: !error, applied, error: error ?? undefined });
    setBusy(false);
    setStep(3);
  };

  const steps = [t('选择服务'), t('连接'), t('测试并保存')];
  const close = (): void => { c.discard([...names]); c.setOverlay(null); };
  return (
    <div className="ms-modal" role="dialog" aria-label={t('添加模型服务')}>
      <header>
        <b>{t('添加模型服务')}</b>
        <div className="ms-steps">{steps.map((label, i) => (
          <span key={label} style={{ display: 'contents' }}>
            {i > 0 ? <span className="ms-step-sep" /> : null}
            <span className={`ms-step${i + 1 === step ? ' on' : i + 1 < step ? ' done' : ''}`}><i>{i + 1 < step ? <Ph name="Check" size={10} weight="bold" /> : i + 1}</i>{label}</span>
          </span>
        ))}</div>
        <span className="ms-grow" />
        <button type="button" className="ms-btn ghost sm" onClick={close} aria-label={t('关闭')}><Ph name="X" size={14} /></button>
      </header>

      {step === 1 ? <>
        <div className="ms-modal-body">
          <label className="ms-search"><Ph name="MagnifyingGlass" size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索服务或能力，例如 DeepSeek、Kimi、可灵、生图…')} autoFocus /></label>
          {initialPurpose && !query ? <div className="ms-hint" style={{ marginTop: 8 }}><Ph name="Info" size={12} />{t('只显示能用于「{name}」的服务；搜索可查看全部。', { name: t(PURPOSES.find((p) => p.key === initialPurpose)?.title ?? '') })}</div> : null}
          {filteredByPurpose.map((group) => (
            <div key={group.key}>
              <div className="ms-group-title">{group.key === 'login' ? <Ph name="SignIn" size={12} /> : null}{t(group.title)}</div>
              <div className="ms-ptiles">{group.items.map((s) => (
                <button type="button" key={s.key} className={`ms-ptile${selected === s.key ? ' sel' : ''}`} onClick={() => setSelected(s.key)} onDoubleClick={() => { setSelected(s.key); setStep(2); }}>
                  <Logo page={s.page} large />
                  <span className="ms-grow" style={{ minWidth: 0 }}><b>{t(s.label)}</b>
                    <span className="ms-caps">{s.connected ? <span className="ms-cap on">{t('已连接')}</span> : null}{s.page.connection ? <span className="ms-cap">{t('账号登录')}</span> : null}{s.caps.slice(0, 3).map((cap) => <span className="ms-cap" key={cap}>{t(cap)}</span>)}</span></span>
                  {selected === s.key ? <span style={{ color: 'var(--ms-ac-ink)' }}><Ph name="CheckCircle" size={18} weight="fill" /></span> : null}
                </button>
              ))}</div>
            </div>
          ))}
          {filteredByPurpose.length === 0 ? <div className="ms-muted" style={{ padding: 24, textAlign: 'center' }}>{t('没有匹配的服务')}</div> : null}
        </div>
        <footer>
          <Ph name="Info" size={12} className="ms-off" /><span className="ms-muted" style={{ fontSize: 12 }}>{t('共 {n} 个服务 · 已连接的也可以重新连接或调整用途', { n: all.length })}</span>
          <span className="ms-grow" />
          <button type="button" className="ms-btn ghost" onClick={close}>{t('取消')}</button>
          <button type="button" className="ms-btn primary" disabled={!service} onClick={() => setStep(2)}>{service ? t('下一步：连接 {name}', { name: t(service.label) }) : t('下一步')}<Ph name="CaretRight" size={12} weight="bold" /></button>
        </footer>
      </> : null}

      {step === 2 && service && primary ? <>
        <div className="ms-modal-body">
          <div className="ms-row" style={{ gap: 12, marginBottom: 16 }}>
            <Logo page={service.page} large />
            <span className="ms-grow"><b style={{ fontSize: 15 }}>{t(service.label)}</b>
              <div className="ms-muted">{service.caps.map((cap) => t(cap)).join(' · ')}{service.connected ? ` · ${t('已连接')}` : ''}</div></span>
            {CONSOLE_URL[service.key] ? <a className="ms-btn link" href={CONSOLE_URL[service.key]} target="_blank" rel="noreferrer"><Ph name="ArrowSquareOut" size={12} />{t('打开控制台获取 Key')}</a> : null}
          </div>
          {primary.connection ? <>
            <div className="ms-field"><label>{t('连接方式')}</label>
              <div className="ms-seg"><button type="button" className="on"><Ph name="SignIn" size={14} />{t('账号登录')}</button><button type="button" disabled><Ph name="Key" size={14} />{t('API Key（见对应 API 服务）')}</button></div></div>
            <div className="ms-legacy"><VendorPane page={primary} hint="" ctx={c.ctx} /></div>
          </> : <>
            <div className="ms-field"><label>{t('连接方式')}</label>
              <div className="ms-seg"><button type="button" className="on"><Ph name="Key" size={14} />API Key</button><button type="button" disabled><Ph name="SignIn" size={14} />{t('账号登录（该服务不支持）')}</button></div></div>
            {secrets.map(({ field, page }) => {
              const mask = maskedKey(c.status, field.name);
              return (
                <div className="ms-field" key={field.name}>
                  <label>{multi ? `${t(groupTitleOf(page))} · ${t(field.label)}` : t(field.label)}</label>
                  <div className="ms-input"><Ph name="Lock" size={14} className="ms-off" />
                    <input type={reveal ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={staged(field.name)}
                      placeholder={mask ? t('已设置 {mask} · 留空保持不变', { mask }) : t('粘贴 {name}', { name: t(field.label) })}
                      onChange={(e) => c.ctx.onStage(field, e.target.value.replace(/\s+/g, ''))} aria-label={t(field.label)} />
                    <button type="button" className="ms-btn ghost sm" onClick={() => setReveal(!reveal)} aria-label={reveal ? t('隐藏') : t('显示')}><Ph name={reveal ? 'EyeSlash' : 'Eye'} size={14} /></button>
                  </div>
                  <span className="ms-hint"><Ph name="ShieldCheck" size={12} />{t('只保存在本机，界面只显示末 4 位；粘贴时自动去掉空格与换行。')}</span>
                </div>
              );
            })}
          </>}
          {targets.length ? (
            <div className="ms-field"><label>{t('用于')}</label>
              <div className="ms-col" style={{ gap: 6 }}>{targets.map((target) => {
                const state = purposeState(c.model, target.def);
                const on = target.current || isChecked(target.def.key);
                return (
                  <button type="button" key={target.def.key} className="ms-check" disabled={target.current} onClick={() => setChosen({ ...chosen, [target.def.key]: !isChecked(target.def.key) })}>
                    <span className={`ms-box${on ? ' on' : ''}`}>{on ? <Ph name="Check" size={11} weight="bold" /> : null}</span>
                    <span className="ms-grow"><b>{target.def.key === 'agent' ? t('对话 Agent · 设为主力') : t('设为「{name}」默认', { name: t(target.def.title) })}</b>{' '}
                      <span className="ms-muted">{target.current ? t('已在使用') : state.choice ? t('替换 {name}', { name: t(state.choice.label) }) + (state.affected ? ` · ${t(HEALTH_LABEL[state.health.kind].text)}` : '') : t('当前未设置')}</span></span>
                  </button>
                );
              })}</div>
            </div>
          ) : null}
          {!primary.connection ? (
            <Collapse title={t('高级：接口地址、接口格式、默认模型')} summary={primary.fields.filter((f) => f.kind !== 'secret').map((f) => c.status?.models[f.name] || f.defaultLabel || '').filter(Boolean).join(' · ')}>
              <div style={{ padding: '8px 12px' }}>{primary.fields.filter((f) => f.kind !== 'secret').map((f) => <FieldRow key={f.name} field={f} ctx={c.ctx} />)}</div>
            </Collapse>
          ) : null}
        </div>
        <footer>
          <button type="button" className="ms-btn ghost" onClick={() => { c.discard([...names]); setStep(1); }}><Ph name="ArrowLeft" size={12} />{t('上一步')}</button>
          <span className="ms-grow" />
          <span className="ms-muted" style={{ fontSize: 12 }}>{t('测试通过后自动保存')}</span>
          <button type="button" className="ms-btn primary" disabled={busy} onClick={() => { void run(); }}>{busy ? <Spinner size={13} /> : <Ph name="Lightning" size={13} weight="fill" />}{busy ? t('正在测试…') : t('测试连接')}</button>
        </footer>
      </> : null}

      {step === 3 && service && result ? <>
        <div className="ms-modal-body">
          <div className="ms-row" style={{ gap: 12, marginBottom: 14 }}>
            <Logo page={service.page} large />
            <span className="ms-grow"><b style={{ fontSize: 15 }}>{t(service.label)}</b>
              <div className="ms-muted ms-mono">{secrets.map((s) => maskedKey(c.status, s.field.name)).filter(Boolean).join(' · ') || (primary?.connection ? t('账号登录') : '')}</div></span>
            {result.ok && result.saved ? <span className="ms-toast"><Ph name="CheckCircle" size={16} weight="fill" />{t('连接成功，已自动保存')}</span> : null}
          </div>
          {result.ok ? <>
            <div className="ms-panel">
              <div className="ms-result"><Ph name="CheckCircle" size={18} weight="fill" className="okc" /><span className="ms-grow"><b>{t('连接有效')}</b><div className="ms-muted" style={{ fontSize: 12 }}>{t(result.message)}</div></span></div>
              {result.models?.length ? <div className="ms-result"><Ph name="CheckCircle" size={18} weight="fill" className="okc" /><span className="ms-grow"><b>{t('发现 {n} 个可用模型', { n: result.models.length })}</b><div className="ms-muted ms-mono" style={{ fontSize: 12 }}>{result.models.slice(0, 6).join(' · ')}{result.models.length > 6 ? ' …' : ''}</div></span></div> : null}
              <div className="ms-result"><Ph name="Info" size={18} weight="fill" className="offc" /><span className="ms-grow"><b>{t('模型与高级参数')}</b><div className="ms-muted" style={{ fontSize: 12 }}>{t('可在「已连接的服务」› {name} › 高级参数中修改', { name: t(service.label) })}</div></span></div>
            </div>
            {result.error ? <div className="ms-alert bad" style={{ marginTop: 12 }}><Ph name="XCircle" size={18} weight="fill" /><span className="ms-grow"><b>{t('保存失败')}</b><div className="ms-muted" style={{ fontSize: 12 }}>{result.error}</div></span></div> : null}
            <div className="ms-section-label" style={{ margin: '16px 0 8px' }}>{t('已应用')}</div>
            {result.applied.length ? result.applied.map((p) => (
              <div className="ms-check" key={p} style={{ marginBottom: 6, cursor: 'default' }}><span className="ms-box on"><Ph name="Check" size={11} weight="bold" /></span><span className="ms-grow"><b>{t(p)}</b> <span className="ms-muted">{t('已设为默认')}</span></span></div>
            )) : <div className="ms-muted" style={{ fontSize: 12 }}>{t('未更改任何用途的默认模型；可在「我在用的」卡片里随时「更换」。')}</div>}
          </> : (
            <div className="ms-alert bad"><Ph name="XCircle" size={18} weight="fill" />
              <span className="ms-grow"><b>{t(HEALTH_LABEL[result.kind]?.text ?? '连接失败')}{result.status ? `（HTTP ${result.status}）` : ''}</b>
                <div className="ms-muted" style={{ fontSize: 12 }}>{t(result.message)}</div>
                <div className="ms-muted" style={{ fontSize: 12, marginTop: 4 }}>{t('未保存任何内容。')}</div></span>
              <HealthBadge kind={result.kind} />
            </div>
          )}
        </div>
        <footer>
          <Ph name="Lock" size={12} className="ms-off" /><span className="ms-muted" style={{ fontSize: 12 }}>{result.ok ? t('密钥已写入本机，Agent 下一条消息即可使用') : t('请检查后重新输入')}</span>
          <span className="ms-grow" />
          {result.ok ? <>
            <button type="button" className="ms-btn" onClick={() => { setResult(null); setSelected(undefined); setChosen({}); setStep(1); }}>{t('继续添加')}</button>
            <button type="button" className="ms-btn primary" onClick={() => c.setOverlay(null)}>{t('完成')}</button>
          </> : <button type="button" className="ms-btn primary" onClick={() => setStep(2)}>{t('重新输入')}</button>}
        </footer>
      </> : null}
    </div>
  );
}
