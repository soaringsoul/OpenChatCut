import { useEffect } from 'react';

export function studioWorkspaceOrigin(): string | null {
  if (window.parent === window) return null;
  try {
    const origin = new URL(document.referrer).origin;
    const configured = new URL(import.meta.env.VITE_STUDIO_BASE_URL || 'http://127.0.0.1:8120');
    const allowed = [configured.origin];
    if (['127.0.0.1', 'localhost'].includes(configured.hostname)) {
      configured.hostname = configured.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      allowed.push(configured.origin);
    }
    if (allowed.includes(origin)) return origin;
    // A dev-server reload can use the iframe itself as its referrer.
    const requested = new URLSearchParams(location.search).get('studioOrigin');
    return origin === location.origin && requested && allowed.includes(requested) ? requested : null;
  } catch { return null; }
}

const embedded = studioWorkspaceOrigin() !== null;
let pairingId = embedded ? '' : sessionStorage.getItem('dtb.studio.opencut.pairingId') || '';
let leaveGuard: (() => Promise<boolean>) | null = null;

export function currentStudioPairing(): string { return pairingId; }
export function setStudioPairing(id: string): void {
  pairingId = id;
  if (!embedded) sessionStorage.setItem('dtb.studio.opencut.pairingId', id);
  window.dispatchEvent(new Event('studio-connection'));
}

export function registerStudioLeaveGuard(guard: () => Promise<boolean>): () => void {
  leaveGuard = guard;
  return () => { if (leaveGuard === guard) leaveGuard = null; };
}

export function openPublicModelSettings(vendor?: string): boolean {
  if (!studioWorkspaceOrigin()) return false;
  if (!location.hash.startsWith('#/settings')) sessionStorage.setItem('dtb.studio.returnHash', location.hash || '#/');
  const suffix = vendor ? `/${vendor.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/')}` : '';
  window.location.hash = `#/settings${suffix}`;
  return true;
}

export function closePublicModelSettings(notify = true): boolean {
  if (!studioWorkspaceOrigin()) return false;
  const back = sessionStorage.getItem('dtb.studio.returnHash') || '#/';
  sessionStorage.removeItem('dtb.studio.returnHash');
  if (location.hash.startsWith('#/settings')) window.location.hash = back.startsWith('#/settings') ? '#/' : back;
  if (notify) notifyStudioWorkspace('model-settings-closed');
  return true;
}

export function notifyStudioWorkspace(action: string, payload: unknown = {}): void {
  const origin = studioWorkspaceOrigin();
  if (origin) window.parent.postMessage({ type: 'dtb-studio', version: 1, kind: 'event', action, payload }, origin);
}

export function useStudioWorkspace(openProject: (id: string) => Promise<void>): void {
  useEffect(() => {
    const origin = studioWorkspaceOrigin();
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== window.parent || event.origin !== origin || !message || message.type !== 'dtb-studio' || message.version !== 1 || message.kind !== 'request') return;
      void (async () => {
        switch (message.action) {
          case 'hello': notifyStudioWorkspace('ready'); break;
          case 'set-connection': setStudioPairing(typeof message.payload?.pairingId === 'string' ? message.payload.pairingId : ''); break;
          case 'open-model-settings': openPublicModelSettings(typeof message.payload?.route === 'string' ? message.payload.route : undefined); break;
          case 'close-model-settings': closePublicModelSettings(message.payload?.notify !== false); break;
          case 'open-project': {
            const id = message.payload?.projectId;
            if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('工程身份无效');
            if (leaveGuard && !(await leaveGuard())) throw new Error('当前工程尚未保存，请先完成保存再切换');
            await openProject(id); break;
          }
          default: throw new Error('不支持此工作室操作');
        }
        window.parent.postMessage({ type: 'dtb-studio', version: 1, kind: 'response', id: message.id, payload: {} }, origin);
      })().catch((error: unknown) => window.parent.postMessage({ type: 'dtb-studio', version: 1, kind: 'response', id: message.id, error: error instanceof Error ? error.message : '操作失败' }, origin));
    };
    window.addEventListener('message', onMessage);
    const updated = () => notifyStudioWorkspace('model-settings-updated');
    window.addEventListener('studio-models-updated', updated);
    notifyStudioWorkspace('ready');
    return () => { window.removeEventListener('message', onMessage); window.removeEventListener('studio-models-updated', updated); };
  }, [openProject]);
}
