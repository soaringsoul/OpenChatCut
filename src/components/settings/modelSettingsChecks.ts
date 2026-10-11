import { isCredentialPage, pageConfigured, pagesFor, type ModelCtx } from './modelSettingsModel';
import type { SettingsVendorPage } from './settingsSchema';

/** Which settings page "测试连接" should exercise for a service: the configured agent page
 *  first (1-token completion), then any configured credential page (vendor probe). */
export function checkPageFor(model: ModelCtx, serviceKey: string): SettingsVendorPage | undefined {
  const pages = pagesFor(serviceKey).filter(isCredentialPage);
  const configured = pages.filter((p) => pageConfigured(model, p));
  return configured.find((p) => p.key.startsWith('llm/')) ?? configured[0] ?? pages.find((p) => p.key.startsWith('llm/')) ?? pages[0];
}
