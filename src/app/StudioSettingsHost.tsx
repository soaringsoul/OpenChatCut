import { lazy, Suspense, useEffect, useState } from 'react';
import { notifyStudioWorkspace } from './studioWorkspace';

const Settings = lazy(() => import('../components/settings/SettingsDialog').then((module) => ({ default: module.SettingsDialog })));

export function StudioSettingsHost() {
  const [route, setRoute] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => setRoute((event as CustomEvent<{ route?: string }>).detail?.route || 'llm');
    window.addEventListener('studio-open-model-settings', open);
    return () => window.removeEventListener('studio-open-model-settings', open);
  }, []);
  return route !== null ? <Suspense fallback={null}><Settings presentation="page" initialVendor={route} onClose={() => { setRoute(null); notifyStudioWorkspace('model-settings-closed'); }} /></Suspense> : null;
}
