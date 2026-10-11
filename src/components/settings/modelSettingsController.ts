// Shared contract between SettingsDialog (state owner) and the overview components.
import type { FieldCtx } from './settingsVendorPane';
import type { KeyStatusResponse, SettingsVendorPage } from './settingsSchema';
import type { HealthKind, HealthMap, ModelCtx } from './modelSettingsModel';

export interface CheckResult {
  readonly ok: boolean; readonly kind: HealthKind; readonly message: string;
  readonly status?: number; readonly latencyMs?: number; readonly models?: readonly string[]; readonly provider?: string;
}

export type Overlay =
  | { readonly type: 'add'; readonly service?: string; readonly purpose?: string }
  | { readonly type: 'service'; readonly key: string }
  | { readonly type: 'pages'; readonly title: string; readonly pages: readonly SettingsVendorPage[]; readonly icon?: string }
  | { readonly type: 'keys' }
  | { readonly type: 'switch'; readonly purpose: string; readonly x: number; readonly y: number };

export interface MsMessage { readonly text: string; readonly tone: 'ok' | 'bad' | 'warn' }

export interface MsController {
  readonly status: KeyStatusResponse | null;
  readonly ctx: FieldCtx;
  readonly model: ModelCtx;
  readonly health: HealthMap;
  readonly refreshHealth: () => Promise<void>;
  /** Real minimal call for a settings page (POST /api/keys/check). */
  readonly check: (pageKey: string, overrides?: Record<string, string>) => Promise<CheckResult>;
  /** Save a patch immediately (same POST /api/keys path and revision guard as the 保存 button). Returns an error text or null. */
  readonly applyPatch: (patch: Record<string, string>) => Promise<string | null>;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly save: () => Promise<void>;
  readonly discard: (names?: readonly string[]) => void;
  readonly message: MsMessage | null;
  readonly overlay: Overlay | null;
  readonly setOverlay: (overlay: Overlay | null) => void;
  readonly openMcpGuide: () => void;
  /** Existing 显示明文 switch: only affects what is typed in this session. */
  readonly setReveal: (on: boolean) => void;
}
