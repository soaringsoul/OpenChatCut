// Single source of truth for user-facing file naming, shared by both hosts on
// purpose: the browser decides the name the user sees in the export dialog and
// the server writes that name to disk. Two copies of this rule would drift the
// moment either side gained a character class the other lacked.
const FORBIDDEN_FILE_NAME_CHARS = /[/\\:*?"<>|]+/g;

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint < 32 ? '_' : character;
  }).join('');
}

function entryBaseName(name: string): string {
  const trimmed = name.trim();
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

/**
 * Finder writes AppleDouble sidecars (`._clip.mp4`) and `.DS_Store` next to
 * real media on exFAT/FAT volumes. Those names still end in `.mp4`, so a
 * naive extension check imports them and compatibility processing fails.
 */
export function isIgnoredImportName(name: string): boolean {
  const base = entryBaseName(name);
  if (!base) return false;
  if (base === '.' || base === '..') return true;
  const lower = base.toLowerCase();
  return base.startsWith('.')
    || lower === 'thumbs.db'
    || lower === 'desktop.ini';
}

export function isIgnoredImportDirectoryName(name: string): boolean {
  const base = entryBaseName(name);
  return base === '__MACOSX' || isIgnoredImportName(base);
}

/** Preserve Unicode while replacing characters forbidden by common filesystems. */
export function sanitizeFileName(value: string, fallback: string): string {
  return replaceControlCharacters(value)
    .replace(FORBIDDEN_FILE_NAME_CHARS, '_')
    .trim() || fallback;
}
