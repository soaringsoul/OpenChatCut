import type { CSSProperties } from 'react';
import { accentOutline, theme, themeAlpha } from '../../theme';
import { ON } from './settingsVendorPane.styles';

const VENDOR_COL_WIDTH = 185;

export function navRowStyle(active: boolean, hovered: boolean): CSSProperties {
  return {
    font: 'inherit', fontSize: 12, display: 'flex', alignItems: 'center', gap: 7,
    width: '100%', padding: '6px 9px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
    border: 'none', borderLeft: `2px solid ${active ? theme.accent : 'transparent'}`,
    background: active || hovered ? theme.panelAlt : 'transparent',
    color: active ? theme.text : theme.textDim,
  };
}

export function dot(on: boolean): CSSProperties {
  return {
    width: 7, height: 7, borderRadius: '50%',
    background: on ? ON : theme.borderLight, flex: '0 0 auto',
  };
}

export const pageShell: CSSProperties = {
  position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: theme.bg,
  zIndex: 1, fontFamily: 'Geist, system-ui, -apple-system, sans-serif',
};
export const pagePanel: CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
  background: theme.panel, color: theme.text, overflow: 'hidden',
};
export const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: themeAlpha.shadow(0.62), display: 'grid', placeItems: 'center',
  zIndex: 200, padding: 24, fontFamily: 'Geist, system-ui, -apple-system, sans-serif',
};
export const panel: CSSProperties = {
  width: 'min(940px, 100%)', height: 'min(640px, 86vh)', display: 'flex', flexDirection: 'column',
  background: theme.panel, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6,
  boxShadow: `0 24px 64px ${themeAlpha.shadow(0.5)}`, overflow: 'hidden',
};
export const head: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '13px 16px 13px 20px', borderBottom: `0.5px solid ${theme.border}`,
};
export const bodyRow: CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
export const tabBar: CSSProperties = {
  flex: '0 0 auto', borderBottom: `0.5px solid ${theme.border}`,
};
export const tabRow: CSSProperties = {
  display: 'flex', gap: 2, padding: '0 14px', overflowX: 'auto',
  borderBottom: `0.5px solid ${theme.border}`,
};
export function categoryTabStyle(active: boolean, hovered: boolean): CSSProperties {
  return {
    font: 'inherit', fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
    flex: '0 0 auto', padding: '9px 10px 8px', cursor: 'pointer', whiteSpace: 'nowrap',
    border: 'none', borderBottom: `2px solid ${active ? theme.accent : 'transparent'}`,
    background: hovered && !active ? theme.panelAlt : 'transparent',
    color: active ? theme.text : theme.textDim,
  };
}
export const subTabRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', minHeight: 36, overflowX: 'auto',
};
export function subTabStyle(active: boolean, hovered: boolean): CSSProperties {
  return {
    font: 'inherit', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
    padding: '4px 10px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `0.5px solid ${active ? theme.accent : 'transparent'}`,
    background: active || hovered ? theme.panelAlt : 'transparent',
    color: active ? theme.text : theme.textDim,
  };
}
export const tabNote: CSSProperties = {
  marginLeft: 'auto', paddingLeft: 12, fontSize: 10.5, color: theme.textDim, whiteSpace: 'nowrap',
};
export const navLabel: CSSProperties = {
  flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
export const vendorCol: CSSProperties = {
  width: VENDOR_COL_WIDTH, flex: '0 0 auto', minWidth: 0, minHeight: 0, overflowY: 'auto',
  display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px',
  borderRight: `0.5px solid ${theme.border}`,
};
export const routeBox: CSSProperties = {
  padding: '0 2px 10px', marginBottom: 6, borderBottom: `0.5px solid ${theme.border}`,
};
export const foot: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 12px 20px',
  borderTop: `0.5px solid ${theme.border}`, background: theme.panel,
};
export const footMsg: CSSProperties = {
  flex: 1, minWidth: 0, textAlign: 'right', fontSize: 11.5,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
export const revealLabel: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
  color: theme.textDim, cursor: 'pointer', userSelect: 'none',
};
export const licenseLink: CSSProperties = {
  color: theme.textDim, fontSize: 11.5, textDecoration: 'underline', textUnderlineOffset: 2,
};
export const iconBtn: CSSProperties = {
  background: 'none', border: 'none', color: theme.textDim,
  cursor: 'pointer', padding: 4, borderRadius: 5, display: 'inline-flex',
};
export const btnGhost: CSSProperties = {
  font: 'inherit', fontSize: 12.5, background: 'transparent', color: theme.text,
  border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '6px 13px', cursor: 'pointer',
};
export const btnPrimary: CSSProperties = {
  font: 'inherit', fontSize: 12.5, fontWeight: 600, ...accentOutline, borderRadius: 4, padding: '6px 16px',
};
export const code: CSSProperties = {
  fontFamily: 'ui-monospace, monospace', fontSize: 10,
  background: theme.panelAlt, padding: '1px 4px', borderRadius: 4,
};
