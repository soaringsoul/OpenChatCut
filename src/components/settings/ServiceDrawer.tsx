// 服务详情抽屉（健康状态 + 错误原因与处理动作 + 在用于 + 模型 + 高级参数折叠），
// 以及「更多设置」通用抽屉与「全部密钥」抽屉。高级参数区直接渲染原有厂商配置面板，
// 字段、登录卡片、测试连接、模型能力编辑等行为与经典视图完全一致。
import { useState } from 'react';
import { useT } from '../../i18n/locale';
import { Ph, HealthBadge, Logo, Spinner, Collapse } from './ModelSettingsParts';
import {
  ALL_PAGES, BAD_HEALTH, CONSOLE_URL, HEALTH_LABEL, fallbackChoice, isCredentialPage, maskedKey, pageModel,
  pagesFor, relativeTime, allSecretFields, serviceCaps, serviceConnected, serviceHealth, serviceLabel, servicePage, type PurposeState,
} from './modelSettingsModel';
import { findGroup, type SettingsVendorPage } from './settingsSchema';
import { VendorPane } from './settingsVendorPane';
import type { MsController } from './modelSettingsController';
import { checkPageFor } from './modelSettingsChecks';

function SaveFooter({ c, onClose, left }: { c: MsController; onClose: () => void; left?: React.ReactNode }) {
  const t = useT();
  return (
    <footer>
      {left}
      <span className="ms-grow" />
      {c.message ? <span className={`ms-msg ${c.message.tone}`}>{c.message.text}</span> : null}
      {c.dirty ? <button type="button" className="ms-btn ghost" onClick={() => c.discard()}>{t('放弃改动')}</button> : null}
      <button type="button" className="ms-btn" onClick={onClose}>{c.dirty ? t('稍后保存') : t('关闭')}</button>
      <button type="button" className="ms-btn primary" disabled={!c.dirty || c.saving} onClick={() => { void c.save(); }}>{c.saving ? <Spinner size={13} /> : null}{c.saving ? t('保存中…') : t('保存')}</button>
    </footer>
  );
}

function sourceLabel(c: MsController, name: string): string {
  const source = c.status?.keys[name]?.source;
  return source === 'env' ? '.env.local / 环境变量' : source === 'runtime' ? '工作室 profile · settings.env' : '';
}

function pageGroupTitle(page: SettingsVendorPage): string {
  const key = page.key.split('/')[0];
  if (key === 'llm') return '对话 Agent';
  const group = findGroup(key);
  return group.key === key ? group.title : page.title;
}

export function ServiceDrawer({ c, serviceKey, states }: { c: MsController; serviceKey: string; states: readonly PurposeState[] }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'bad' | 'warn' } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const page = servicePage(serviceKey);
  const pages = pagesFor(serviceKey);
  const connected = serviceConnected(c.model, serviceKey);
  const health = serviceHealth(c.model, serviceKey, connected);
  const usedBy = states.filter((s) => s.choice?.service === serviceKey && s.choice.configured);
  const affected = usedBy.filter((s) => BAD_HEALTH.has(s.health.kind));
  const swaps = affected.map((s) => ({ s, f: fallbackChoice(s) })).filter((x) => x.f && x.s.routeName);
  const credential = pages.filter(isCredentialPage);
  const secretFields = [...new Map(credential.flatMap((p) => p.fields.filter((f) => f.kind === 'secret')).map((f) => [f.name, f])).values()];
  const login = credential.find((p) => p.connection);
  const label = serviceLabel(serviceKey, page?.title);
  const view = HEALTH_LABEL[health.kind];
  const close = (): void => c.setOverlay(null);

  const retest = async (): Promise<void> => {
    const target = checkPageFor(c.model, serviceKey);
    if (!target) return;
    setBusy('test'); setNote(null);
    const result = await c.check(target.key);
    await c.refreshHealth();
    setBusy(null);
    setNote({ text: t(result.message), tone: result.ok ? 'ok' : 'bad' });
  };
  const swap = async (): Promise<void> => {
    const patch: Record<string, string> = {};
    for (const { s, f } of swaps) patch[s.routeName!] = f!.value;
    setBusy('swap');
    const error = await c.applyPatch(patch);
    setBusy(null);
    setNote(error ? { text: error, tone: 'bad' } : { text: t('已把 {n} 个用途换成其他模型', { n: swaps.length }), tone: 'ok' });
  };
  const disconnect = async (): Promise<void> => {
    if (!confirmDisconnect) { setConfirmDisconnect(true); return; }
    const patch = Object.fromEntries(secretFields.filter((f) => c.status?.keys[f.name]?.configured).map((f) => [f.name, '']));
    setBusy('disconnect');
    const error = Object.keys(patch).length ? await c.applyPatch(patch) : null;
    setBusy(null); setConfirmDisconnect(false);
    setNote(error ? { text: error, tone: 'bad' } : { text: t('已清除该服务的密钥'), tone: 'ok' });
  };

  const action = (): React.ReactNode => {
    const url = CONSOLE_URL[serviceKey];
    if (health.kind === 'balance' && url) return <a className="ms-btn sm primary" href={url} target="_blank" rel="noreferrer"><Ph name="ArrowSquareOut" size={12} weight="bold" />{t('去 {name} 充值', { name: t(label) })}</a>;
    if (health.kind === 'quota' && url) return <a className="ms-btn sm primary" href={url} target="_blank" rel="noreferrer"><Ph name="ArrowSquareOut" size={12} weight="bold" />{t('查看额度 / 开通计费')}</a>;
    if (health.kind === 'invalid' && url) return <a className="ms-btn sm primary" href={url} target="_blank" rel="noreferrer"><Ph name="Key" size={12} weight="bold" />{t('获取新密钥')}</a>;
    if (health.kind === 'network') return <button type="button" className="ms-btn sm primary" onClick={() => c.setOverlay({ type: 'pages', title: t('网络代理'), pages: ALL_PAGES.filter((p) => p.key === 'agent/proxy') })}><Ph name="Globe" size={12} weight="bold" />{t('设置网络代理')}</button>;
    return null;
  };

  return (
    <aside className="ms-drawer" role="dialog" aria-label={t(label)}>
      <header>
        <Logo page={page} large />
        <span className="ms-grow"><b style={{ fontSize: 15 }}>{t(label)}</b>
          <div className="ms-row" style={{ marginTop: 4 }}><HealthBadge kind={health.kind} /><span className="ms-muted" style={{ fontSize: 12 }}>{serviceCaps(serviceKey).map((cap) => t(cap)).join(' · ')}</span></div></span>
        <button type="button" className="ms-btn ghost sm" onClick={close} aria-label={t('关闭')}><Ph name="X" size={14} /></button>
      </header>
      <div className="ms-drawer-body">
        {BAD_HEALTH.has(health.kind) ? (
          <div className={`ms-alert${view.tone === 'bad' ? ' bad' : ''}`}><Ph name={view.icon} size={18} weight="fill" />
            <span className="ms-grow"><b>{t(view.text)}</b>
              <div className="ms-muted" style={{ fontSize: 12 }}>{t(health.message)}{health.at ? ` · ${t(relativeTime(health.at))}` : ''}</div>
              {usedBy.length ? <div className="ms-muted" style={{ fontSize: 12 }}>{t('影响：{list}', { list: usedBy.map((s) => t(s.def.title)).join('、') })}</div> : null}
              <div className="ms-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                {action()}
                <button type="button" className="ms-btn sm" disabled={busy !== null} onClick={() => { void retest(); }}>{busy === 'test' ? <Spinner size={12} /> : <Ph name="ArrowsClockwise" size={12} />}{t('重新测试')}</button>
                {swaps.length ? <button type="button" className="ms-btn sm ghost" disabled={busy !== null} onClick={() => { void swap(); }}>{t('把这 {n} 个用途换成其他模型', { n: swaps.length })}</button> : null}
              </div></span></div>
        ) : connected ? (
          <div className={`ms-alert${health.kind === 'ok' ? '' : ' info'}`} style={health.kind === 'ok' ? { background: 'var(--ms-ok-bg)' } : undefined}>
            <Ph name={health.kind === 'ok' ? 'CheckCircle' : 'Info'} size={18} weight="fill" className={health.kind === 'ok' ? 'ms-ok-ink' : ''} />
            <span className="ms-grow"><b>{health.kind === 'ok' ? t('可用') : t('尚未检测')}</b>
              <div className="ms-muted" style={{ fontSize: 12 }}>{health.kind === 'ok' ? `${t('最近一次真实调用成功')}${health.at ? ` · ${t(relativeTime(health.at))}` : ''}` : t('点「测试连接」做一次真实的最小调用（约 1 个 token）。')}</div></span>
            <button type="button" className="ms-btn sm" disabled={busy !== null} onClick={() => { void retest(); }}>{busy === 'test' ? <Spinner size={12} /> : <Ph name="Lightning" size={12} />}{t('测试连接')}</button>
          </div>
        ) : (
          <div className="ms-alert info"><Ph name="Info" size={18} weight="fill" /><span className="ms-grow"><b>{t('尚未连接')}</b><div className="ms-muted" style={{ fontSize: 12 }}>{t('在下方「连接与参数」填写密钥或登录后保存。')}</div></span>
            <button type="button" className="ms-btn sm primary" onClick={() => c.setOverlay({ type: 'add', service: serviceKey })}>{t('连接')}</button></div>
        )}
        {note ? <div className={`ms-msg ${note.tone}`}>{note.text}</div> : null}

        <dl className="ms-kv">
          <dt>{t('连接方式')}</dt>
          <dd>{login ? t('账号登录（凭据由官方 CLI 管理）') : secretFields.length ? secretFields.map((f) => (
            <span key={f.name} style={{ display: 'block' }}>{secretFields.length > 1 ? `${t(f.label)} · ` : 'API Key · '}<span className="ms-mono">{maskedKey(c.status, f.name) || t('未设置')}</span></span>
          )) : t('复用其他服务的密钥')}</dd>
          {secretFields.some((f) => c.status?.keys[f.name]?.configured) ? <><dt>{t('保存位置')}</dt><dd className="ms-muted">{[...new Set(secretFields.map((f) => sourceLabel(c, f.name)).filter(Boolean))].map((s) => t(s)).join(' · ')}</dd></> : null}
          <dt>{t('在用于')}</dt><dd>{usedBy.length ? usedBy.map((s) => t(s.def.title)).join(' · ') : <span className="ms-muted">{t('未在使用')}</span>}</dd>
          <dt>{t('最近检测')}</dt><dd className="ms-muted">{health.at ? `${t(health.message)} · ${t(relativeTime(health.at))}` : t('暂无记录')}</dd>
        </dl>

        <div><div className="ms-section-label" style={{ marginBottom: 4 }}>{t('模型')}</div>
          <div className="ms-models">{pages.filter((p) => pageModel(c.model, p)).map((p) => {
            const use = usedBy.find((s) => s.choice?.page?.key === p.key);
            return (
              <div className="ms-model" key={p.key}>
                <span className="ms-mono ms-grow ms-ellipsis">{pageModel(c.model, p)}</span>
                <span className="ms-muted">{t(pageGroupTitle(p))}{use ? '' : ` · ${t('未在使用')}`}</span>
                {use ? <HealthBadge kind={use.health.kind} /> : null}
              </div>
            );
          })}</div>
        </div>

        <div className="ms-col" style={{ gap: 6 }}>
          <div className="ms-section-label">{t('连接与参数（多数情况无需修改）')}</div>
          {pages.map((p) => (
            <Collapse key={p.key} title={`${t(pageGroupTitle(p))} · ${t(p.title)}`} defaultOpen={Boolean(p.connection) || (!connected && isCredentialPage(p))}
              summary={[pageModel(c.model, p), ...p.fields.filter((f) => f.kind === 'secret').map((f) => maskedKey(c.status, f.name))].filter(Boolean).join(' · ')}>
              <VendorPane page={p} hint="" ctx={c.ctx} />
            </Collapse>
          ))}
        </div>
      </div>
      <SaveFooter c={c} onClose={close} left={secretFields.some((f) => c.status?.keys[f.name]?.configured)
        ? <button type="button" className="ms-btn ghost danger" disabled={busy !== null} onClick={() => { void disconnect(); }}><Ph name="Trash" size={13} />{confirmDisconnect ? t('再点一次确认断开') : t('断开此服务')}</button>
        : null} />
    </aside>
  );
}

export function PagesDrawer({ c, title, pages }: { c: MsController; title: string; pages: readonly SettingsVendorPage[] }) {
  const t = useT();
  return (
    <aside className="ms-drawer" role="dialog" aria-label={title}>
      <header>
        <span className="ms-grow"><b style={{ fontSize: 15 }}>{title}</b></span>
        <button type="button" className="ms-btn ghost sm" onClick={() => c.setOverlay(null)} aria-label={t('关闭')}><Ph name="X" size={14} /></button>
      </header>
      <div className="ms-drawer-body">
        {pages.map((page) => (
          <div key={page.key} className="ms-col" style={{ gap: 6 }}>
            {pages.length > 1 ? <div className="ms-section-label">{t(page.title)}</div> : null}
            <div className="ms-legacy"><VendorPane page={page} hint="" ctx={c.ctx} /></div>
          </div>
        ))}
      </div>
      <SaveFooter c={c} onClose={() => c.setOverlay(null)} />
    </aside>
  );
}

export function KeysDrawer({ c }: { c: MsController }) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [onlySet, setOnlySet] = useState(true);
  const fields = allSecretFields().filter((f) => !onlySet || c.status?.keys[f.name]?.configured || f.name in c.ctx.values);
  return (
    <aside className="ms-drawer" role="dialog" aria-label={t('全部密钥')}>
      <header>
        <span className="ms-logo lg"><Ph name="Key" size={18} /></span>
        <span className="ms-grow"><b style={{ fontSize: 15 }}>{t('全部密钥')}</b>
          <div className="ms-muted" style={{ fontSize: 12, marginTop: 2 }}>{t('密钥只存本机，经服务端注入，不进浏览器；这里只显示末 4 位。')}</div></span>
        <button type="button" className="ms-btn ghost sm" onClick={() => c.setOverlay(null)} aria-label={t('关闭')}><Ph name="X" size={14} /></button>
      </header>
      <div className="ms-drawer-body">
        <div className="ms-row">
          <div className="ms-seg" style={{ width: 220 }}>
            <button type="button" className={onlySet ? 'on' : ''} onClick={() => setOnlySet(true)}>{t('已设置')}</button>
            <button type="button" className={!onlySet ? 'on' : ''} onClick={() => setOnlySet(false)}>{t('全部')}</button>
          </div>
          <span className="ms-grow" />
          <label className="ms-row ms-muted" style={{ fontSize: 12 }}><input type="checkbox" checked={c.ctx.reveal} onChange={(e) => c.setReveal(e.target.checked)} />{t('显示明文（仅本次输入）')}</label>
        </div>
        <table className="ms-keys"><tbody>
          {fields.map((f) => {
            const staged = c.ctx.values[f.name];
            const mask = maskedKey(c.status, f.name);
            return (
              <tr key={f.name}>
                <td style={{ width: 28 }}><Logo page={f.page} /></td>
                <td><b style={{ fontWeight: 600 }}>{t(f.page.title)}</b><div className="ms-muted ms-mono" style={{ fontSize: 11 }}>{f.name}</div></td>
                <td style={{ width: 210 }}>
                  {editing === f.name ? (
                    <div className="ms-input" style={{ height: 30 }}>
                      <input type={c.ctx.reveal ? 'text' : 'password'} autoFocus autoComplete="off" value={staged ?? ''} placeholder={mask ? t('留空保持不变') : t('粘贴以启用')}
                        onChange={(e) => c.ctx.onStage(f, e.target.value.replace(/\s+/g, ''))} aria-label={f.name} />
                    </div>
                  ) : staged === '' ? <span className="ms-msg warn">{t('将清除 · 保存后生效')}</span>
                    : staged ? <span className="ms-msg ok">{t('已修改 · 保存后生效')}</span>
                      : <span className="ms-mono">{mask || <span className="ms-off">{t('未设置')}</span>}</span>}
                  <div className="ms-off" style={{ fontSize: 11 }}>{t(sourceLabel(c, f.name))}</div>
                </td>
                <td style={{ width: 120, textAlign: 'right' }}>
                  <button type="button" className="ms-btn sm ghost" onClick={() => setEditing(editing === f.name ? null : f.name)}>{editing === f.name ? t('完成') : mask ? t('更换') : t('填写')}</button>
                  {mask ? <button type="button" className="ms-btn sm ghost danger" onClick={() => c.ctx.onToggleClear(f)}>{staged === '' ? t('撤销') : t('清除')}</button> : null}
                </td>
              </tr>
            );
          })}
        </tbody></table>
      </div>
      <SaveFooter c={c} onClose={() => c.setOverlay(null)} />
    </aside>
  );
}
