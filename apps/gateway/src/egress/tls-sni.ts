/**
 * Lecture du nom de serveur (SNI) dans le premier message TLS d'un client (ClientHello).
 *
 * Le proxy d'egress tunnelise un `CONNECT hôte:443` vers l'adresse validée de l'hôte autorisé.
 * Sans contrôle, un client pourrait ensuite parler TLS à un autre site hébergé sur la même adresse
 * (CDN mutualisé) : on exige donc que le SNI soit l'hôte annoncé dans le `CONNECT`.
 */
export type SniResult = { kind: 'sni'; name: string } | { kind: 'incomplete' } | { kind: 'not-tls' } | { kind: 'no-sni' };

/** Taille maximale lue avant de conclure (un ClientHello tient largement dans 16 Kio). */
export const MAX_CLIENT_HELLO = 16 * 1024 + 5;

export function readSni(buf: Buffer): SniResult {
  if (buf.length < 1) return { kind: 'incomplete' };
  if (buf[0] !== 0x16) return { kind: 'not-tls' }; // enregistrement « handshake »
  if (buf.length < 5) return { kind: 'incomplete' };
  const recordLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLen) return buf.length >= MAX_CLIENT_HELLO ? { kind: 'not-tls' } : { kind: 'incomplete' };
  const hs = buf.subarray(5, 5 + recordLen);
  try {
    if (hs[0] !== 0x01) return { kind: 'not-tls' }; // ClientHello
    const hsLen = hs.readUIntBE(1, 3);
    const body = hs.subarray(4, 4 + hsLen);
    let p = 2 + 32; // version + aléa
    p += 1 + body[p]; // session id
    p += 2 + body.readUInt16BE(p); // suites de chiffrement
    p += 1 + body[p]; // méthodes de compression
    if (p + 2 > body.length) return { kind: 'no-sni' };
    const extEnd = p + 2 + body.readUInt16BE(p);
    p += 2;
    while (p + 4 <= extEnd) {
      const type = body.readUInt16BE(p);
      const len = body.readUInt16BE(p + 2);
      const ext = body.subarray(p + 4, p + 4 + len);
      if (type === 0x0000) {
        // server_name : liste, on retient le nom d'hôte (type 0).
        let q = 2;
        while (q + 3 <= ext.length) {
          const nameType = ext[q];
          const nameLen = ext.readUInt16BE(q + 1);
          const name = ext.subarray(q + 3, q + 3 + nameLen).toString('ascii');
          if (nameType === 0 && name) return { kind: 'sni', name: name.toLowerCase().replace(/\.$/, '') };
          q += 3 + nameLen;
        }
        return { kind: 'no-sni' };
      }
      p += 4 + len;
    }
    return { kind: 'no-sni' };
  } catch {
    return { kind: 'not-tls' };
  }
}
