// 「更换」弹层：为一个用途选择模型。可用 / 暂不可用（带原因）分组，Codex 列出账号可用模型与推理强度，
// 并给出可用的备用建议。选择即保存（同一条 POST /api/keys 路径）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/locale';
import { Ph, HealthBadge, Logo, Spinner } from './ModelSettingsParts';
import { BAD_HEALTH, effortLabel, fallbackChoice, serviceLabel, servicePage, type Choice, type PurposeState } from './modelSettingsModel';
import type { MsController } from './modelSettingsController';

export function ModelSwitchPopover({ c, state, x, y }: { c: MsController; state: PurposeState; x: number; y: number }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Keep the whole popover on screen: lift it when the anchor sits near the bottom edge.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.top = `${y}px`;
    const overflow = box.getBoundingClientRect().bottom - (window.innerHeight - 12);
    if (overflow > 0) box.style.top = `${Math.max(8, y - overflow)}px`;
  }, [x, y, query]);
  const codex = c.ctx.codex;
  const isAgent = state.def.key === 'agent';
  const codexConnected = Boolean(codex.status?.account?.type === 'chatgpt');
  useEffect(() => {
    if (isAgent && codexConnected && codex.models.length === 0 && !codex.modelBusy) void codex.discoverModels();
  }, [isAgent, codexConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLowerCase();
  const match = (ch: Choice) => !q || `${ch.label} ${ch.model} ${ch.service}`.toLowerCase().includes(q);
  const usable = state.choices.filter((ch) => ch.configured && !BAD_HEALTH.has(ch.health.kind) && match(ch));
  const blocked = state.choices.filter((ch) => (!ch.configured || BAD_HEALTH.has(ch.health.kind)) && match(ch));
  const fallback = fallbackChoice(state);
  const savedModel = c.status?.models.CODEX_MODEL ?? '';
  const savedEffort = c.status?.models.CODEX_REASONING_EFFORT ?? '';
  const currentCodex = codex.models.find((m) => m.id === savedModel) ?? codex.models.find((m) => m.isDefault);

  const apply = async (key: string, patch: Record<string, string>): Promise<void> => {
    setBusy(key); setError(null);
    const failure = await c.applyPatch(patch);
    setBusy(null);
    if (failure) setError(failure); else c.setOverlay(null);
  };
  const pick = (ch: Choice): void => {
    if (!state.routeName) return;
    if (!ch.configured) { c.setOverlay({ type: 'add', service: ch.service, purpose: state.def.key }); return; }
    if (ch.value === state.current) { c.setOverlay(null); return; }
    void apply(ch.value, { [state.routeName]: ch.value });
  };
  const pickCodexModel = (id: string): void => {
    const target = codex.models.find((m) => m.id === id);
    const patch: Record<string, string> = { CODEX_MODEL: target?.isDefault && !savedModel ? '' : id };
    if (state.routeName && state.current !== 'codex') patch[state.routeName] = 'codex';
    if (savedEffort && target && !target.supportedReasoningEfforts.some((e) => e.reasoningEffort === savedEffort)) patch.CODEX_REASONING_EFFORT = '';
    void apply(`codex:${id}`, patch);
  };

  const row = (ch: Choice) => {
    const cur = ch.value === state.current;
    const dim = !ch.configured || BAD_HEALTH.has(ch.health.kind);
    const reason = !ch.configured ? t('未连接 · 点击去连接') : BAD_HEALTH.has(ch.health.kind) ? t(ch.health.message) : '';
    const page = ch.page ?? servicePage(ch.service);
    if (isAgent && ch.value === 'codex' && codexConnected && codex.models.length > 0) {
      return codex.models.filter((m) => !q || m.id.toLowerCase().includes(q) || 'codex'.includes(q)).map((m) => {
        const on = state.current === 'codex' && (currentCodex?.id === m.id);
        return (
          <button type="button" key={`codex:${m.id}`} className={`ms-opt${on ? ' cur' : ''}`} onClick={() => pickCodexModel(m.id)}>
            <Logo page={page} />
            <span className="ms-grow"><b>{m.label || m.id}</b><span className="ms-mono">{t('OpenAI · Codex')}{m.isDefault ? ` · ${t('账号默认')}` : ''}{on ? ` · ${t('当前')}` : ''}</span></span>
            {BAD_HEALTH.has(ch.health.kind) ? <HealthBadge kind={ch.health.kind} /> : null}
            {busy === `codex:${m.id}` ? <Spinner /> : on ? <Ph name="Check" size={14} weight="bold" className="ms-ok-ink" /> : null}
          </button>
        );
      });
    }
    return (
      <button type="button" key={ch.value} className={`ms-opt${cur ? ' cur' : ''}${dim ? ' dim' : ''}`} onClick={() => pick(ch)} title={reason}>
        <Logo page={page} />
        <span className="ms-grow" style={{ minWidth: 0 }}>
          <b className="ms-ellipsis">{isAgent ? (ch.model || t(ch.label)) : t(ch.label)}</b>
          <span className="ms-mono ms-ellipsis" style={{ display: 'block' }}>
            {isAgent ? t(serviceLabel(ch.service, ch.label)) : ch.model}{cur ? ` · ${t('当前')}` : ''}{reason ? ` · ${reason}` : ''}
          </span>
        </span>
        {ch.configured ? <HealthBadge kind={ch.health.kind} /> : <HealthBadge kind="none" />}
        {busy === ch.value ? <Spinner /> : cur ? <Ph name="Check" size={14} weight="bold" /> : null}
      </button>
    );
  };

  const efforts = isAgent && state.current === 'codex' ? currentCodex?.supportedReasoningEfforts ?? [] : [];
  return (
    <div ref={boxRef} className="ms-popover" style={{ left: x, top: y }} role="dialog" aria-label={t('为「{name}」选择模型', { name: t(state.def.title) })}>
      <div className="ms-ph">
        <div className="ms-row"><b className="ms-grow">{t('为「{name}」选择模型', { name: t(state.def.title) })}</b>
          <button type="button" className="ms-btn ghost sm" onClick={() => c.setOverlay(null)} aria-label={t('关闭')}><Ph name="X" size={12} /></button></div>
        <label className="ms-search" style={{ height: 30 }}><Ph name="MagnifyingGlass" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索服务或模型')} autoFocus /></label>
      </div>
      {usable.length ? <div className="ms-opt-group">{t('可用')}</div> : null}
      {usable.map(row)}
      {isAgent && codex.modelBusy ? <div className="ms-opt ms-muted"><Spinner />{t('正在读取 Codex 可用模型…')}</div> : null}
      {blocked.length ? <div className="ms-opt-group">{t('暂不可用')}</div> : null}
      {blocked.map(row)}
      {state.routeName ? (
        <button type="button" className={`ms-opt${state.current === '' ? ' cur' : ''}`} onClick={() => { if (state.current !== '') void apply('none', { [state.routeName!]: '' }); }}>
          <span className="ms-logo"><Ph name="Question" size={13} /></span>
          <span className="ms-grow"><b>{isAgent ? t('不指定 · 任务中选择模型') : t('不指定 · 每次询问')}</b></span>
          {busy === 'none' ? <Spinner /> : state.current === '' ? <Ph name="Check" size={14} weight="bold" /> : null}
        </button>
      ) : null}
      <div className="ms-pop-foot">
        {efforts.length ? (
          <div className="ms-row"><span className="ms-muted ms-grow" style={{ fontSize: 12 }}>{t('推理强度')}</span>
            <div className="ms-seg" style={{ minWidth: 220 }}>
              <button type="button" className={savedEffort === '' ? 'on' : ''} onClick={() => { if (savedEffort) void apply('effort', { CODEX_REASONING_EFFORT: '' }); }}>{t('默认')}</button>
              {efforts.map((e) => <button type="button" key={e.reasoningEffort} title={e.description} className={savedEffort === e.reasoningEffort ? 'on' : ''}
                onClick={() => { if (savedEffort !== e.reasoningEffort) void apply('effort', { CODEX_REASONING_EFFORT: e.reasoningEffort }); }}>{effortLabel(e.reasoningEffort, t)}</button>)}
            </div></div>
        ) : null}
        <div className="ms-row" style={{ fontSize: 12 }}>
          <span className="ms-muted ms-grow">{t('备用建议')}</span>
          {fallback ? <>
            <span className="ms-ellipsis">{t(serviceLabel(fallback.service, fallback.label))}{fallback.model ? ` · ${fallback.model}` : ''}</span>
            <button type="button" className="ms-btn link sm" onClick={() => pick(fallback)}>{t('改用')}</button>
          </> : <span className="ms-muted">{t('暂无其他可用模型')}</span>}
        </div>
        <div className="ms-off" style={{ fontSize: 11 }}>{t('失败时自动切换到备用暂未支持；当前模型不可用时请手动改用。')}</div>
        {error ? <div className="ms-msg bad">{error}</div> : null}
      </div>
      <div className="ms-pop-foot" style={{ paddingTop: 8, paddingBottom: 8 }}>
        <button type="button" className="ms-btn link" onClick={() => c.setOverlay({ type: 'add', purpose: state.def.key })}><Ph name="Plus" size={12} weight="bold" />{t('连接更多模型服务')}</button>
      </div>
    </div>
  );
}
