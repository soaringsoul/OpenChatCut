export function studioSourceLabel(props: unknown): string | null {
  if (!props || typeof props !== 'object') return null;
  const source = (props as { studioSource?: { title?: unknown; ref?: { assetVersionId?: unknown } } }).studioSource;
  const version = source?.ref?.assetVersionId;
  if (typeof version !== 'string' || !version) return null;
  const title = typeof source?.title === 'string' && source.title ? source.title : version;
  return `${title} · ${version}`;
}
