import 'reflect-metadata';
import { webcrypto, randomBytes, createPrivateKey, X509Certificate } from 'node:crypto';

type CryptoKeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };
import tls from 'node:tls';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { sql } from 'drizzle-orm';
import type { Database } from '@cap/database';
import type { SecretProvider } from '@cap/secrets';
import { DB, SECRETS } from '@cap/server-core';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const CA_PATH = 'infra/forge-ca';
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const LEAF_DAYS = 7;
const DAY = 86_400_000;

const pem = (der: ArrayBuffer, label: string) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

const serial = () => {
  const b = randomBytes(16);
  b[0] &= 0x7f; // entier positif
  return b.toString('hex');
};

/**
 * Autorité de certification propre à l'installation, utilisée UNIQUEMENT pour intercepter le trafic
 * des sandboxes vers les forges Git (ADR 0013). Sa clé privée est dans Vault (gateway seule) ; son
 * certificat public est servi aux workers, qui l'installent dans le magasin de confiance des sandboxes.
 */
@Injectable()
export class ForgeCaService implements OnModuleInit {
  private readonly logger = new Logger('ForgeCA');
  private caCert!: x509.X509Certificate;
  private caKey!: CryptoKey;
  private leafKeys!: CryptoKeyPair;
  private leafKeyPem!: string;
  private caCertPem!: string;
  private readonly contexts = new Map<string, { ctx: tls.SecureContext; expires: number }>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    const { cert, key } = await this.loadOrCreate();
    this.caCertPem = cert;
    this.caCert = new x509.X509Certificate(cert);
    const der = createPrivateKey(key).export({ format: 'der', type: 'pkcs8' });
    this.caKey = await webcrypto.subtle.importKey('pkcs8', der, ALG, false, ['sign']);
    this.leafKeys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
    this.leafKeyPem = pem(await webcrypto.subtle.exportKey('pkcs8', this.leafKeys.privateKey), 'PRIVATE KEY');
    this.logger.log(`Autorité des forges chargée (empreinte ${new X509Certificate(cert).fingerprint256.slice(0, 23)}…)`);
  }

  get certificatePem(): string {
    return this.caCertPem;
  }

  private async loadOrCreate(): Promise<{ cert: string; key: string }> {
    const ref = this.secrets.reference(CA_PATH);
    const existing = await this.secrets.read(ref).catch(() => null);
    if (existing?.['cert'] && existing['key']) return { cert: existing['cert'], key: existing['key'] };
    // Plusieurs gateways peuvent démarrer ensemble : une seule génère l'autorité.
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cap:forge-ca'))`);
      const again = await this.secrets.read(ref).catch(() => null);
      if (again?.['cert'] && again['key']) return { cert: again['cert'], key: again['key'] };
      const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
      const now = Date.now();
      const ca = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: serial(),
        name: 'CN=Coding Agent Platform - forges (sandboxes)',
        notBefore: new Date(now - DAY),
        notAfter: new Date(now + 10 * 365 * DAY),
        signingAlgorithm: ALG,
        keys,
        extensions: [
          new x509.BasicConstraintsExtension(true, 0, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
          await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        ],
      });
      const created = { cert: ca.toString('pem') + '\n', key: pem(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY') };
      await this.secrets.write(CA_PATH, created);
      this.logger.log('Autorité des forges générée et enregistrée dans Vault');
      return created;
    });
  }

  /** Contexte TLS d'un certificat feuille pour `host` (mis en cache, renouvelé avant expiration). */
  async contextFor(host: string): Promise<tls.SecureContext> {
    const h = host.toLowerCase();
    const cached = this.contexts.get(h);
    if (cached && cached.expires > Date.now() + DAY) return cached.ctx;
    const now = Date.now();
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: `CN=${h}`,
      issuer: this.caCert.subject,
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(now + LEAF_DAYS * DAY),
      signingAlgorithm: ALG,
      signingKey: this.caKey,
      publicKey: this.leafKeys.publicKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: h }]),
        await x509.AuthorityKeyIdentifierExtension.create(this.caCert),
      ],
    });
    const ctx = tls.createSecureContext({ key: this.leafKeyPem, cert: leaf.toString('pem') + '\n' + this.caCertPem, minVersion: 'TLSv1.2' });
    this.contexts.set(h, { ctx, expires: now + LEAF_DAYS * DAY });
    return ctx;
  }
}
