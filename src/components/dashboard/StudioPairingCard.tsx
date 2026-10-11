import { useEffect, useState } from 'react';
import { currentStudioPairing, notifyStudioWorkspace, setStudioPairing, studioWorkspaceOrigin } from '../../app/studioWorkspace';
import { accentOutline, theme } from '../../theme';
import { useT } from '../../i18n/locale';

export function StudioPairingCard() {
  const t = useT();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(() => Boolean(currentStudioPairing()));
  useEffect(() => {
    const update = () => setConnected(Boolean(currentStudioPairing()));
    window.addEventListener('studio-connection', update);
    return () => window.removeEventListener('studio-connection', update);
  }, []);
  if (studioWorkspaceOrigin()) return <section style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, padding: '13px 14px', border: `0.5px solid ${theme.border}`, borderRadius: 6, background: theme.panelAlt }}>
    <span style={{ flex: 1, fontSize: 12, color: theme.textDim }}>{t(connected ? '已连接工作室素材库，可以挑选素材送入工程。' : '登录工作室素材库后即可连接，已有工程可以继续剪辑。')}</span>
    <button type="button" onClick={() => notifyStudioWorkspace('pick-assets')} style={{ border: `0.5px solid ${theme.border}`, borderRadius: 5, background: theme.bg, color: theme.text, padding: '7px 12px', fontSize: 12 }}>{t('从素材库挑选')}</button>
  </section>;
  return (
    <section style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 20, padding: '13px 14px', border: `0.5px solid ${theme.border}`, borderRadius: 6, background: theme.panelAlt }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: 'block', color: theme.textStrong, fontSize: 13.5 }}>{t('连接资产端')}</strong>
        <span style={{ display: 'block', marginTop: 3, color: theme.textDim, fontSize: 11.5, lineHeight: 1.5 }}>
          {t('在资产端生成配对码，粘贴到这里。确认后就可以把素材送进工程素材池。')}
        </span>
      </span>
      <input
        value={code}
        aria-label={t('资产端配对码')}
        placeholder={t('资产端配对码')}
        onChange={(event) => setCode(event.target.value)}
        style={{ width: 180, height: 32, boxSizing: 'border-box', border: `0.5px solid ${theme.border}`, borderRadius: 5, background: theme.bg, color: theme.text, padding: '0 8px', fontSize: 12 }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void confirm(code, setBusy, setMessage, t('配对失败'), t('已连接资产端'))}
        style={{ flex: '0 0 auto', ...accentOutline, borderRadius: 5, padding: '7px 12px', fontSize: 12, fontWeight: 650, cursor: 'pointer' }}
      >
        {busy ? t('正在连接') : t('确认配对')}
      </button>
      {message ? <span role="status" style={{ color: theme.textDim, fontSize: 12 }}>{message}</span> : null}
    </section>
  );
}

async function confirm(code: string, setBusy: (busy: boolean) => void, setMessage: (message: string) => void, failure: string, success: string): Promise<void> {
  if (!code.trim()) {
    setMessage(failure);
    return;
  }
  setBusy(true);
  setMessage('');
  try {
    const response = await fetch('/api/studio-bridge/pairings/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const body = await response.json() as { data?: { pairingId?: string }; error?: { message?: string } };
    if (response.ok && body.data?.pairingId) setStudioPairing(body.data.pairingId);
    setMessage(response.ok ? success : body.error?.message || failure);
  } catch {
    setMessage(failure);
  } finally {
    setBusy(false);
  }
}
