import { Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { theme } from '../../theme';
import { t, useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { VendorIcon } from './vendorIcons';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from '../../agent/capabilities';
import { applyAgentModelStatus } from '../../agent/model-selection';
import {
  TRANSCRIPTION_DIARIZATION_KEY,
  TRANSCRIPTION_LANGUAGE_KEY,
  setPreferredTranscriptionProvider,
} from '../../transcript/provider';
import { isTranscriptionProviderId } from '../../transcript/types';
import { isAsrModelTier } from '../../../shared/asr-models';
import { setAutoTranscribeIngest } from '../../transcript/provider';
import { FieldRow, ON, VendorPane, WARN, type FieldCtx } from './settingsVendorPane';
import { useCodexSettings } from './useCodexSettings';
import { useClaudeCodeSettings } from './useClaudeCodeSettings';
import type { CodexAgentStatus } from '../../../shared/codex-agent';
import type { CopilotAgentStatus } from '../../../shared/copilot-agent';
import type { ClaudeCodeAgentStatus } from '../../../shared/claude-code-agent';
import { useCopilotSettings } from './useCopilotSettings';
import { stageFieldValue } from './codexReasoning';
import { SettingsVersionControl } from './SettingsVersionControl';
import {
  CURRENT_APP_VERSION,
  formatDisplayVersion,
  getUpstreamUpdateState,
  hasDesktopUpdateSupport,
  subscribeUpstreamUpdate,
} from '../../ui/upstreamUpdate';
import {
  resolveUpstreamUpdateAction,
  runUpstreamUpdateCommand,
} from '../../ui/upstreamUpdateAction';
import {
  SETTINGS_CATEGORIES, buildPatch, categoryGroupStats, findGroup, groupConfigured,
  modelValue, omitKey, savedMessage, vendorConfigured,
  type KeyStatusResponse, type SettingsCategory, type SettingsField, type SettingsGroup,
  type SettingsVendorPage, type StagedValues as Values,
} from './settingsSchema';
import {
  bodyRow, btnGhost, btnPrimary, categoryTabStyle, code, dot, foot, footMsg,
  head, iconBtn, licenseLink, navLabel, navRowStyle, overlay as overlayStyle, pagePanel, pageShell, panel, revealLabel,
  routeBox, subTabRow, subTabStyle, tabBar, tabNote, tabRow, vendorCol,
} from './SettingsDialog.styles';

import { ModelSettingsView } from './ModelSettingsView';
import type { CheckResult, MsController, Overlay } from './modelSettingsController';
import { isCredentialPage, type HealthMap, type ModelCtx } from './modelSettingsModel';
import { loadMcpGuideDialog } from './mcpGuideLoader';

const McpGuideDialog = lazy(() => loadMcpGuideDialog().then((m) => ({ default: m.McpGuideDialog })));

// Global settings: top tabs = category, sub-tabs = capability (with status indicator);
// left column = list of providers under the current capability (generating four capabilities with a "default provider" route select at the top);
// right = Select the provider's configuration page (header = icon + name + configuration status, body = fields).
// The key value only flows to the dev server via POST /api/keys (stored in memory + .env.local, already gitignore),
// Server-side injection; GET only returns Boolean for secret, never backfills. The model/routing field is a non-secret configuration and the current value is
// Echoed through GET's models channel.
// values semantics: field name appearing in values = temporary changes; '' = explicit temporary clearing (sent when saving,
// The backend treats the empty string as deleting the key and deletes the row from .env.local, which means "return to default" for the model field). Temporary baseline:
// Model field = current value on the server, the rest = '' (the echoed value is not temporarily stored, only the actual changes are entered into the values);
// values are shared globally by field name and the switching tree nodes are not cleared (MINIMAX_* instant synchronization across capability pages).
// The right column (vendor configuration page + field rendering + test connection) is in settingsVendorPane.tsx.
const CLOSE_CONFIRM_MS = 2000;

// ── hooks ─────────────────────────────────────────────────────────────────

function useKeyStatus(): {
  status: KeyStatusResponse | null;
  setStatus: (s: KeyStatusResponse) => void;
  loadError: string | null;
} {
  const [status, setStatus] = useState<KeyStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/keys')
      .then((r) => r.json() as Promise<KeyStatusResponse>)
      .then((d) => { if (alive) setStatus(d); })
      .catch(() => { if (alive) setLoadError(t('无法读取配置（dev 服务未就绪？）')); });
    return () => { alive = false; };
  }, []);
  return { status, setStatus, loadError };
}

/** Keep runtime transcription preferences in sync with server-saved settings. */
function syncTranscriptionPreferences(models: Record<string, string>): void {
  try {
    localStorage.setItem(TRANSCRIPTION_LANGUAGE_KEY, models.TRANSCRIPTION_LANGUAGE?.trim() || 'zh');
    localStorage.setItem(
      TRANSCRIPTION_DIARIZATION_KEY,
      models.TRANSCRIPTION_DIARIZATION === '0' ? '0' : '1',
    );
  } catch {
    // Best-effort; runtime language and diarization defaults remain in effect.
  }
  const provider = models.PREFERRED_TRANSCRIPTION_PROVIDER;
  setPreferredTranscriptionProvider(isTranscriptionProviderId(provider) ? provider : 'assemblyai');
  const ingest = models.AUTO_TRANSCRIBE_INGEST;
  if (ingest === 'off' || ingest === 'local' || ingest === 'all') setAutoTranscribeIngest(ingest);
}

/** Keep the runtime ASR model tier in sync with the saved setting ('' → auto). */
function syncLocalAsrModel(saved: string | undefined): void {
  try {
    // Validate against the catalog, never a hand-written list: a tier missing
    // here is discarded silently and the previous selection stays in force.
    if (isAsrModelTier(saved ?? '')) localStorage.setItem('cc.asrModel', saved ?? '');
  } catch {
    // Best-effort; the auto tier stays in effect.
  }
}

function useSaveKeys(values: Values, onSaved: (next: KeyStatusResponse) => void, revision?: string): {
  save: () => Promise<void>; saving: boolean; msg: string | null; error: string | null;
} {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const patch = buildPatch(values);
    if (Object.keys(patch).length === 0) { setMsg(t('没有改动')); return; }
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) }, body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as Partial<KeyStatusResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error || t('保存失败 ({n})', { n: res.status }));
      onSaved(body as KeyStatusResponse);
      // A storage-folder change is copied immediately but only used on the next
      // launch, so saying "saved" alone would look like nothing happened.
      setMsg(body.restartRequired ? t('已保存 · 重启应用后新的工程存储目录才会生效') : savedMessage());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return { save, saving, msg, error };
}

/** Anti-accidental closing: When there are unsaved changes, Mask/Esc will only warn you for the first time, and it will be truly closed when triggered again within 2 seconds. */
function useCloseGuard(dirty: boolean, onClose: () => void): { requestClose: () => void; warn: string | null } {
  const [warn, setWarn] = useState<string | null>(null);
  const armedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const requestClose = (): void => {
    if (!dirty || Date.now() - armedAt.current < CLOSE_CONFIRM_MS) { onClose(); return; }
    armedAt.current = Date.now();
    setWarn(t('有未保存改动，再按一次关闭将丢弃'));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setWarn(null); armedAt.current = 0; }, CLOSE_CONFIRM_MS);
  };
  return { requestClose, warn };
}

function useEscape(handler: () => void): void {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useHover(): [boolean, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [hovered, setHovered] = useState(false);
  return [hovered, { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }];
}

/** The left tree capability is selected + the middle column provider is selected; when changing capabilities, the middle column is reset to the first provider with the capability. */
function useTreeSelection(initialVendor?: string): {
  group: SettingsGroup; page: SettingsVendorPage;
  selectGroup: (key: string) => void; selectVendor: (key: string) => void;
  openPage: (vendorKey: string) => void;
} {
  const seeded = seedSelection(initialVendor);
  const [groupKey, setGroupKey] = useState<string>(seeded.group.key);
  const [vendorKey, setVendorKey] = useState<string>(seeded.vendor.key);
  const group = findGroup(groupKey);
  const page = group.vendors.find((v) => v.key === vendorKey) ?? group.vendors[0];
  const selectGroup = (key: string): void => {
    const nextGroup = findGroup(key);
    setGroupKey(key);
    setVendorKey(nextGroup.vendors[0].key);
  };
  // Jump to a page in any group, resolved the same way as initialVendor.
  const openPage = (vendorKey: string): void => {
    const target = seedSelection(vendorKey);
    setGroupKey(target.group.key);
    setVendorKey(target.vendor.key);
  };
  return { group, page, selectGroup, selectVendor: setVendorKey, openPage };
}

/** Open on a specific vendor page when the caller routed here (e.g. the chat's missing-model-pack button). */
function seedSelection(initialVendor?: string): { group: SettingsGroup; vendor: SettingsVendorPage } {
  for (const category of SETTINGS_CATEGORIES) {
    for (const group of category.groups) {
      const vendor = group.vendors.find((v) => v.key === initialVendor);
      if (vendor) return { group, vendor };
      if (group.key === initialVendor && group.vendors[0]) return { group, vendor: group.vendors[0] };
    }
  }
  const first = SETTINGS_CATEGORIES[0].groups[0];
  return { group: first, vendor: first.vendors[0] };
}

// ── Main component ───────────────────────────────────────────────────────────

/** After successful saving, let the agent side immediately perceive: caps / key Boolean / model routing / LLM interface and model. */
function applySavedToAgent(next: KeyStatusResponse): void {
  applyLiveCaps(next.caps);
  applyLiveKeyStatus(next.keys);
  if (next.models) applyLiveModels(next.models);
  if (next.models) applyAgentModelStatus(next.keys, next.models);
}


function useFieldContext(
  status: KeyStatusResponse | null,
  values: Values,
  setValues: React.Dispatch<React.SetStateAction<Values>>,
  reveal: boolean,
  refreshStatus: () => Promise<void>,
  copilotEnabled: boolean,
  openPage: (route: string) => void,
): FieldCtx {
  const [modelOptions, setModelOptions] = useState<Record<string, readonly string[]>>({});
  const [autoClearedEffort, setAutoClearedEffort] = useState<string | null>(null);
  const codex = useCodexSettings(
    modelValue(status, 'CODEX_MODEL'),
    modelValue(status, 'CODEX_REASONING_EFFORT'),
  );
  const copilot = useCopilotSettings(copilotEnabled);
  const claudeCode = useClaudeCodeSettings(modelValue(status, 'CLAUDE_CODE_MODEL'));
  const onStage = (field: SettingsField, raw: string): void => {
    const staged = stageFieldValue(values, field, raw, status, codex.models, autoClearedEffort);
    setValues(staged.values);
    setAutoClearedEffort(staged.autoClearedEffort);
  };
  useEffect(() => {
    if (!('CODEX_MODEL' in values) && !('CODEX_REASONING_EFFORT' in values)) {
      setAutoClearedEffort(null);
    }
  }, [values]);
  const onToggleClear = (field: SettingsField): void => {
    if (field.name === 'CODEX_MODEL' || field.name === 'CLAUDE_CODE_MODEL') {
      onStage(field, values[field.name] === '' ? modelValue(status, field.name) : '');
      return;
    }
    setValues((previous) => previous[field.name] === ''
      ? omitKey(previous, field.name)
      : { ...previous, [field.name]: '' });
  };
  return {
    status, values, reveal, onStage, onToggleClear, modelOptions, codex, copilot, claudeCode,
    refreshStatus, openPage,
    onModelsDiscovered: (name, models) => {
      setModelOptions((previous) => ({ ...previous, [name]: [...new Set(models)] }));
    },
  };
}

export function SettingsDialog({ onClose, initialVendor, presentation = 'dialog' }: { onClose: () => void; initialVendor?: string; presentation?: 'dialog' | 'page' }) {
  const t = useT();
  const updateState = useSyncExternalStore(
    subscribeUpstreamUpdate,
    getUpstreamUpdateState,
    getUpstreamUpdateState,
  );
  const { status, setStatus, loadError } = useKeyStatus();
  const [values, setValues] = useState<Values>({});
  const { group, page, selectGroup, selectVendor, openPage } = useTreeSelection(initialVendor);
  const [reveal, setReveal] = useState(false);
  const [classic, setClassic] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(() => initialOverlay(initialVendor));
  const [mcpOpen, setMcpOpen] = useState(false);
  const { health, refreshHealth } = useProviderHealth();
  const [scheme, toggleScheme] = useSettingsScheme();
  const refreshStatus = async (): Promise<void> => {
    try {
      const response = await fetch('/api/keys');
      const next = (await response.json()) as KeyStatusResponse;
      setStatus(next);
      applySavedToAgent(next);
    } catch {
      // Keep the stale snapshot; the next save or dialog open refreshes it.
    }
  };
  // Note actions / missing-model routes open the page in the classic tree, or as a drawer on the overview.
  const routePage = (route: string): void => {
    if (classic) { openPage(route); return; }
    const target = seedSelection(route);
    setOverlay({ type: 'pages', title: t(target.vendor.title), pages: [target.vendor] });
  };
  const ctx = useFieldContext(status, values, setValues, reveal, refreshStatus,
    classic ? page.connection === 'copilot' : overlayWants(overlay, 'copilot'), routePage);
  useEffect(() => {
    if (!status?.models) return;
    syncTranscriptionPreferences(status.models);
    syncLocalAsrModel(status.models.LOCAL_ASR_MODEL);
  }, [status]);
  const onSaved = (next: KeyStatusResponse): void => {
    setStatus(next);
    // Desktop: the main process owns the zoom factor; re-apply after the
    // saved UI_SCALE changed so the change is visible immediately.
    void window.openChatCutDesktop?.windowAction('apply-ui-scale');
    applySavedToAgent(next);
    window.dispatchEvent(new Event('studio-models-updated'));
  };
  const { save, saving, msg, error } = useSaveKeys(values, (next) => {
    onSaved(next);
    // The status effect synchronizes all transcription runtime preferences.
    setValues({});
  }, status?.revision);
  const dirty = Object.keys(values).length > 0;
  const { requestClose, warn } = useCloseGuard(dirty, onClose);
  useEscape(() => {
    if (mcpOpen) return;
    if (!classic && overlay) { if (!dirty || overlay.type === 'switch') setOverlay(null); else requestClose(); return; }
    requestClose();
  });

  const fullPage = presentation === 'page';
  const updateAction = resolveUpstreamUpdateAction(updateState, hasDesktopUpdateSupport());

  const codexStatus = ctx.codex.status;
  const copilotStatus = ctx.copilot.status;
  const claudeCodeStatus = ctx.claudeCode.status;

  const shownError = error ?? loadError;
  const message = shownError ? { text: shownError, color: WARN }
    : warn ? { text: warn, color: theme.gold }
      : msg ? { text: msg, color: ON } : null;
  const versionControl = (
    <SettingsVersionControl
      versionLabel={t('当前版本号：{version}', { version: formatDisplayVersion(CURRENT_APP_VERSION) })}
      actionLabel={updateAction.label}
      disabled={updateAction.disabled}
      onAction={() => { runUpstreamUpdateCommand(updateAction.command); }}
    />
  );
  const mcpGuide = mcpOpen ? <Suspense fallback={null}><McpGuideDialog onClose={() => setMcpOpen(false)} /></Suspense> : null;

  if (!classic) {
    const model: ModelCtx = {
      status, codexStatus, copilotStatus, claudeCodeStatus, codexModels: ctx.codex.models, health,
    };
    const controller: MsController = {
      status, ctx, model, health, refreshHealth,
      check: async (pageKey, overrides = {}) => {
        try {
          const response = await fetch('/api/keys/check', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: pageKey, overrides }),
          });
          const body = await response.json() as CheckResult & { error?: string };
          if (!response.ok) return { ok: false, kind: 'error', message: body.error || t('检测失败 ({n})', { n: response.status }) };
          return body;
        } catch (err) {
          return { ok: false, kind: 'network', message: err instanceof Error ? err.message : String(err) };
        } finally {
          void refreshHealth();
        }
      },
      applyPatch: async (patch) => {
        try {
          const response = await fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(status?.revision ? { 'If-Match': status.revision } : {}) },
            body: JSON.stringify(patch),
          });
          const body = await response.json().catch(() => ({})) as Partial<KeyStatusResponse> & { error?: string };
          if (!response.ok) return body.error || t('保存失败 ({n})', { n: response.status });
          onSaved(body as KeyStatusResponse);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
      dirty, saving, save,
      discard: (names) => setValues((previous) => names
        ? Object.fromEntries(Object.entries(previous).filter(([k]) => !names.includes(k)))
        : {}),
      message: shownError ? { text: shownError, tone: 'bad' } : warn ? { text: warn, tone: 'warn' } : msg ? { text: msg, tone: 'ok' } : null,
      overlay, setOverlay, openMcpGuide: () => setMcpOpen(true), setReveal,
    };
    return (
      <>
        {!fullPage ? <div className="ms-backdrop" onMouseDown={requestClose} /> : null}
        <div className={`ms ms-root${fullPage ? '' : ' ms-dialog'}${scheme === 'dark' ? ' ms-dark' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
          <ModelSettingsView c={controller} fullPage={fullPage} versionSlot={versionControl} scheme={scheme}
            onToggleScheme={toggleScheme} onClose={requestClose} onClassic={() => { setOverlay(null); setClassic(true); }} />
        </div>
        {mcpGuide}
      </>
    );
  }

  return (
    <div style={fullPage ? pageShell : overlayStyle} onMouseDown={fullPage ? undefined : requestClose}>
      <div style={fullPage ? pagePanel : panel} onMouseDown={(e) => e.stopPropagation()}>
        <header style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={() => setClassic(false)} title={t('返回总览')} style={{ ...btnGhost, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span aria-hidden>‹</span>{t('返回总览')}
            </button>
            <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="sliders" size={15} /></span>
            <b style={{ fontSize: 14 }}>{t(fullPage ? '模型设置' : '设置 · API 密钥')}</b>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {versionControl}
            <button type="button" onClick={requestClose} title={t('关闭')} style={iconBtn}><Icon name="x" size={15} /></button>
          </div>
        </header>
        <CapabilityTabs status={status} codexStatus={codexStatus} copilotStatus={copilotStatus}
          claudeCodeStatus={claudeCodeStatus}
          activeGroup={group.key} onSelect={selectGroup} />
        <div style={bodyRow}>
          <VendorList group={group} activeVendor={page.key} onSelectVendor={selectVendor} ctx={ctx} />
          <VendorPane page={page} hint={group.hint} ctx={ctx} />
        </div>
        <FooterBar reveal={reveal} onReveal={setReveal} message={message}
          dirty={dirty} saving={saving} onClose={requestClose} closeLabel={fullPage ? '返回' : '关闭'} onSave={() => { void save(); }} />
      </div>
      {mcpGuide}
    </div>
  );
}

/** Routed opens (missing model pack, note actions) land on that page as a drawer. Group keys stay on the overview. */
function initialOverlay(initialVendor?: string): Overlay | null {
  if (!initialVendor || !initialVendor.includes('/')) return null;
  const target = seedSelection(initialVendor);
  if (target.vendor.key !== initialVendor && target.group.key !== initialVendor) return null;
  const key = target.vendor.key.split('/')[1];
  if (isCredentialPage(target.vendor) && key) return { type: 'service', key };
  return { type: 'pages', title: target.vendor.title, pages: [target.vendor] };
}

function overlayWants(overlay: Overlay | null, connection: string): boolean {
  if (!overlay) return false;
  if (overlay.type === 'service') return overlay.key === connection;
  if (overlay.type === 'add') return overlay.service === connection;
  if (overlay.type === 'pages') return overlay.pages.some((p) => p.connection === connection);
  return false;
}

function useProviderHealth(): { health: HealthMap; refreshHealth: () => Promise<void> } {
  const [health, setHealth] = useState<HealthMap>({});
  const refreshHealth = async (): Promise<void> => {
    try {
      const response = await fetch('/api/keys/health');
      if (!response.ok) return;
      const body = await response.json() as { providers?: HealthMap };
      setHealth(body.providers ?? {});
    } catch {
      // Health is advisory; the overview falls back to "未检测".
    }
  };
  useEffect(() => { void refreshHealth(); }, []);
  return { health, refreshHealth };
}

const SCHEME_KEY = 'cc.modelSettingsScheme';
/** Follows the editor skin (light / dark) unless the user flipped it here. */
function useSettingsScheme(): ['light' | 'dark', () => void] {
  const skin = (): 'light' | 'dark' => {
    try {
      const stored = localStorage.getItem(SCHEME_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
      return getComputedStyle(document.documentElement).getPropertyValue('--cc-color-scheme').trim() === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  };
  const [scheme, setScheme] = useState<'light' | 'dark'>(skin);
  const toggle = (): void => {
    const next = scheme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(SCHEME_KEY, next); } catch { /* session only */ }
    setScheme(next);
  };
  return [scheme, toggle];
}

// ── Top tabs (category tabs → capability sub-tabs) ──────────────────────────────────────

function CapabilityTabs({
  status, codexStatus, copilotStatus, claudeCodeStatus, activeGroup, onSelect,
}: {
  status: KeyStatusResponse | null; codexStatus: CodexAgentStatus | null;
  copilotStatus: CopilotAgentStatus | null;
  claudeCodeStatus: ClaudeCodeAgentStatus | null;
  activeGroup: string; onSelect: (key: string) => void;
}) {
  const t = useT();
  const activeCategory = SETTINGS_CATEGORIES.find((cat) => cat.groups.some((g) => g.key === activeGroup))
    ?? SETTINGS_CATEGORIES[0];
  return (
    <nav style={tabBar}>
      <div role="tablist" style={tabRow}>
        {SETTINGS_CATEGORIES.map((cat) => (
          <CategoryTab key={cat.key} category={cat} status={status} codexStatus={codexStatus}
            copilotStatus={copilotStatus} claudeCodeStatus={claudeCodeStatus}
            active={cat.key === activeCategory.key} onSelect={() => onSelect(cat.groups[0].key)} />
        ))}
      </div>
      <div style={subTabRow}>
        {activeCategory.groups.length > 1 && activeCategory.groups.map((g) => (
          <SubTab key={g.key} title={g.title}
            on={groupConfigured(status, g, codexStatus, copilotStatus, claudeCodeStatus)}
            active={g.key === activeGroup} onSelect={() => onSelect(g.key)} />
        ))}
        <span style={tabNote}>
          {t('密钥仅存本机')} <code style={code}>.env.local</code>{t('（已 gitignore），经服务端注入，')}<b>{t('不进浏览器。')}</b>
        </span>
      </div>
    </nav>
  );
}

function CategoryTab({
  category, status, codexStatus, copilotStatus, claudeCodeStatus, active, onSelect,
}: {
  category: SettingsCategory; status: KeyStatusResponse | null; codexStatus: CodexAgentStatus | null;
  copilotStatus: CopilotAgentStatus | null; claudeCodeStatus: ClaudeCodeAgentStatus | null;
  active: boolean; onSelect: () => void;
}) {
  const t = useT();
  const [hovered, hoverProps] = useHover();
  const { done, total } = categoryGroupStats(status, category, codexStatus, copilotStatus, claudeCodeStatus);
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onSelect} {...hoverProps}
      style={categoryTabStyle(active, hovered)}>
      <Icon name={category.icon} size={13} />
      <span>{t(category.title)}</span>
      <span style={{ fontSize: 10, fontWeight: 400, color: done === total && total > 0 ? ON : theme.textDim }}>
        {done}/{total}
      </span>
    </button>
  );
}

function SubTab({ title, on, active, onSelect }: {
  title: string; on: boolean; active: boolean; onSelect: () => void;
}) {
  const t = useT();
  const [hovered, hoverProps] = useHover();
  return (
    <button type="button" onClick={onSelect} {...hoverProps} style={subTabStyle(active, hovered)}>
      <span style={dot(on)} />
      <span>{t(title)}</span>
    </button>
  );
}

// ── Middle column (route select + provider list) ────────────────────────────────────────

function VendorList({ group, activeVendor, onSelectVendor, ctx }: {
  group: SettingsGroup; activeVendor: string; onSelectVendor: (key: string) => void; ctx: FieldCtx;
}) {
  return (
    <div style={vendorCol}>
      {group.route && <div style={routeBox}><FieldRow field={group.route} ctx={ctx} /></div>}
      {group.vendors.map((p) => (
        <VendorRow key={p.key} page={p}
          on={vendorConfigured(ctx.status, p, ctx.codex.status, ctx.copilot.status, ctx.claudeCode.status)}
          active={p.key === activeVendor} onSelect={() => onSelectVendor(p.key)} />
      ))}
    </div>
  );
}

function VendorRow({ page, on, active, onSelect }: {
  page: SettingsVendorPage; on: boolean; active: boolean; onSelect: () => void;
}) {
  const t = useT();
  const [hovered, hoverProps] = useHover();
  return (
    <button type="button" onClick={onSelect} {...hoverProps} style={navRowStyle(active, hovered)}>
      {page.icon ? <Icon name={page.icon} size={15} /> : <VendorIcon vendor={page.vendor} size={15} />}
      <span style={navLabel}>{t(page.title)}</span>
      <span style={dot(on)} />
    </button>
  );
}

interface FooterBarProps {
  reveal: boolean; onReveal: (v: boolean) => void; message: { text: string; color: string } | null;
  dirty: boolean; saving: boolean; onClose: () => void; closeLabel?: string; onSave: () => void;
}

function FooterBar({ reveal, onReveal, message, dirty, saving, onClose, closeLabel = '关闭', onSave }: FooterBarProps) {
  const t = useT();
  const disabled = saving || !dirty;
  return (
    <footer style={foot}>
      <label style={revealLabel}>
        <input type="checkbox" checked={reveal} onChange={(e) => onReveal(e.target.checked)} />
        {t('显示明文')}
      </label>
      <a href="/fonts/LICENSES.md" target="_blank" rel="noopener noreferrer" style={licenseLink}>
        {t('第三方字体许可')}
      </a>
      <div style={{ ...footMsg, color: message?.color ?? ON }}>{message?.text ?? ''}</div>
      <button type="button" onClick={onClose} style={btnGhost}>{t(closeLabel)}</button>
      <button type="button" onClick={onSave} disabled={disabled}
        style={{ ...btnPrimary, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
        {saving ? t('保存中…') : t('保存')}
      </button>
    </footer>
  );
}
