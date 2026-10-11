
import { useT } from './i18n/locale';
import { lazy, Suspense, useCallback } from 'react';
import { navigateTo } from './app/appShell';
import { listProjects } from './persist/projectStore';
import { closePublicModelSettings, useStudioWorkspace } from './app/studioWorkspace';
import { StudioSettingsHost } from './app/StudioSettingsHost';
import { AppSplash, DashboardRoute, EditorRoute } from './app/AppViews';

const ModelSettingsPage = lazy(() => import('./components/settings/SettingsDialog').then((module) => ({ default: module.SettingsDialog })));
import {
  useAgentBackendSync,
  useAppRoute,
  useProjects,
} from './app/appShell';
import { useInferenceWarmup } from './hooks/useInferenceWarmup';
import { useUiScaleShortcuts } from './hooks/useUiScaleShortcuts';

export default function App() {
  const t = useT();
  const route = useAppRoute();
  useAgentBackendSync();
  // No warmup where the editor can't open (insecure context, see editorAccess).
  useInferenceWarmup(route.name === 'editor' && window.isSecureContext);
  useUiScaleShortcuts();
  const { projects, refresh } = useProjects();
  const openStudioProject = useCallback(async (id: string) => {
    const latest = await listProjects();
    if (!latest.some((project) => project.id === id && !project.deletedAt)) throw new Error('工程暂时无法读取，请稍后重试');
    await refresh();
    navigateTo(`#/editor/${id}`);
  }, [refresh]);
  useStudioWorkspace(openStudioProject);

  if (!projects) return <AppSplash text={t('加载中…')} />;
  if (route.name === 'settings') {
    return <Suspense fallback={<AppSplash text={t('加载中…')} />}><ModelSettingsPage presentation="page" initialVendor={route.vendor} onClose={() => { if (!closePublicModelSettings()) navigateTo('#/'); }} /></Suspense>;
  }
  if (route.name === 'editor') {
    return <><EditorRoute route={route} projects={projects} refresh={refresh} /><StudioSettingsHost /></>;
  }
  return <><DashboardRoute projects={projects} refresh={refresh} /><StudioSettingsHost /></>;
}
