// Small building blocks shared by the model-settings overview, drawers and popovers.
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n/locale';
import { PHOSPHOR, type PhosphorName } from './modelSettingsIcons';
import { VendorIcon } from './vendorIcons';
import type { SettingsVendorPage } from './settingsSchema';
import { HEALTH_LABEL, type Health } from './modelSettingsModel';

export function Ph({ name, size = 16, weight = 'regular', className = '' }: {
  name: PhosphorName; size?: number; weight?: 'regular' | 'bold' | 'fill'; className?: string;
}) {
  // Static path data generated from @phosphor-icons (MIT); never user input.
  return (
    <svg className={`ms-ic ${className}`} width={size} height={size} viewBox="0 0 256 256" fill="currentColor"
      aria-hidden dangerouslySetInnerHTML={{ __html: PHOSPHOR[`${name}:${weight}`] ?? '' }} />
  );
}

export function HealthBadge({ kind, label }: { kind: Health; label?: string }) {
  const t = useT();
  const view = HEALTH_LABEL[kind];
  return <span className={`ms-badge ${view.tone}`}><Ph name={view.icon} size={12} weight="bold" />{label ?? t(view.text)}</span>;
}

export function HealthDot({ kind }: { kind: Health }) {
  return <span className={`ms-dot ${HEALTH_LABEL[kind].tone}`} />;
}

export function Logo({ page, large = false }: { page?: SettingsVendorPage; large?: boolean }) {
  return (
    <span className={`ms-logo${large ? ' lg' : ''}`}>
      {page ? <VendorIcon vendor={page.vendor} size={large ? 22 : 15} /> : <Ph name="Plus" size={large ? 18 : 13} />}
    </span>
  );
}

export function Collapse({ title, summary, children, defaultOpen = false }: {
  title: string; summary?: string; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" className={`ms-collapse${open ? ' open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Ph name={open ? 'CaretDown' : 'CaretRight'} size={12} />
        <span>{title}</span>
        {summary ? <span className="ms-sum">{summary}</span> : null}
      </button>
      {open ? <div className="ms-collapse-body">{children}</div> : null}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Ph name="CircleNotch" size={size} weight="bold" className="ms-spin" />;
}
