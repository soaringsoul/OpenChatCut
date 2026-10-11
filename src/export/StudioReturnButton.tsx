import { useState } from 'react';
import type { ProjectDoc } from '../editor/types';
import { useT } from '../i18n/locale';
import { currentStudioPairing, notifyStudioWorkspace, setStudioPairing, studioWorkspaceOrigin } from '../app/studioWorkspace';

export function StudioReturnButton({ project, projectId }: { project: ProjectDoc; projectId: string }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sources = project.assets.flatMap((asset) => {
    const source = asset.props?.studioSource;
    return source && typeof source === 'object' ? [source] : [];
  });
  return (
    <form className="cc-export-studio-return" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const file = form.elements.namedItem('file');
      if (!(file instanceof HTMLInputElement) || !file.files?.[0]) {
        setMessage(t('请选择已经完成的成片或字幕'));
        return;
      }
      const mode = form.elements.namedItem('mode');
      const target = form.elements.namedItem('target');
      void returnExport({
        file: file.files[0],
        projectId,
        mode: mode instanceof HTMLSelectElement && mode.value === 'new-version' ? 'new-version' : 'new-asset',
        targetAssetId: target instanceof HTMLInputElement ? target.value : '',
        sources,
        setBusy,
        setMessage,
        failure: t('回库失败'),
        disconnected: t('还没有连接资产端'),
        success: t('已回库'),
      });
    }}>
      <select name="mode" defaultValue="new-asset">
        <option value="new-asset">{t('回库为新素材')}</option>
        <option value="new-version">{t('回库为新版本')}</option>
      </select>
      {!studioWorkspaceOrigin() && <><input name="code" value={code} placeholder={t('资产端配对码')} onChange={(event) => setCode(event.target.value)} /><button type="button" onClick={() => void confirmCode(code, setMessage, t('配对失败'), t('已连接资产端'))}>{t('确认配对')}</button></>}
      <input name="target" placeholder={t('已有素材 ID')} />
      <input name="file" type="file" accept="video/*,audio/*,.srt,.vtt,.txt" />
      <span>{t('选择已完成的导出文件，单文件暂支持 48 MB 以内。')}</span>
      <button type="submit" disabled={busy}>{busy ? t('正在回库') : t('回库到资产端')}</button>
      {message ? <span role="status">{message}</span> : null}
    </form>
  );
}

async function confirmCode(code: string, setMessage: (message: string) => void, failure: string, success: string): Promise<void> {
  if (!code.trim()) {
    setMessage(failure);
    return;
  }
  const response = await fetch('/api/studio-bridge/pairings/confirm', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const body = await response.json() as { data?: { pairingId?: string }; error?: { message?: string } };
  if (response.ok && body.data?.pairingId) setStudioPairing(body.data.pairingId);
  setMessage(response.ok ? success : body.error?.message || failure);
}

async function returnExport(input: {
  file: File;
  projectId: string;
  mode: 'new-asset' | 'new-version';
  targetAssetId: string;
  sources: unknown[];
  setBusy: (busy: boolean) => void;
  setMessage: (message: string) => void;
  failure: string;
  disconnected: string;
  success: string;
}): Promise<void> {
  input.setBusy(true);
  input.setMessage('');
  try {
    if (!currentStudioPairing()) { input.setMessage(input.disconnected); return; }
    if (input.file.size > 48 * 1024 * 1024) { input.setMessage('当前回库支持 48 MB 以内的文件'); return; }
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    if (bytes.byteLength === 0) {
      input.setMessage(input.failure);
      return;
    }
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const response = await fetch('/api/studio-bridge/exports/return', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: input.projectId,
        pairingId: currentStudioPairing(),
        fileName: input.file.name,
        mode: input.mode,
        targetAssetId: input.targetAssetId,
        outputType: input.file.type.startsWith('audio/') ? 'audio' : /\.(srt|vtt|txt)$/i.test(input.file.name) ? 'subtitle' : 'video',
        sources: input.sources,
        fileBase64: btoa(binary),
      }),
    });
    const body = await response.json() as { data?: { assetId?: string }; error?: { code?: string; message?: string } };
    if (!response.ok || body.error || !body.data?.assetId) {
      input.setMessage(body.error?.code === 'pairing_required' ? input.disconnected : body.error?.message || input.failure);
      return;
    }
    input.setMessage(`${input.success} ${body.data?.assetId ?? ''}`.trim());
    notifyStudioWorkspace('export-returned', { assetId: body.data?.assetId });
  } catch {
    input.setMessage(input.failure);
  } finally {
    input.setBusy(false);
  }
}
