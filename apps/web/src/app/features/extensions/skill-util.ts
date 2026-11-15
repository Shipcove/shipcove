/** UTF-8 valide sans octet nul : fichier texte, éditable. */
export function isTextFile(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Téléchargement de l'archive .zip d'un skill (cookies de session). */
export async function downloadSkillZip(base: string, id: string, name: string, version?: number): Promise<void> {
  const res = await fetch(`${base}/skills/${id}/export${version ? `?version=${version}` : ''}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}${version ? `-v${version}` : ''}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
