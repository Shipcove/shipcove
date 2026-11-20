import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import type { SecretProvider } from '@cap/secrets';
import { ENV, type BaseEnv } from '../config/config.js';
import { SECRETS } from '../tokens.js';

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/**
 * Accès au stockage objet compatible S3 (Garage en référence).
 * Les identifiants sont lus dans Vault (`S3_CREDENTIALS_REF`), jamais dans l'environnement.
 */
@Injectable()
export class ObjectStorage {
  private readonly logger = new Logger('ObjectStorage');
  private clientPromise: Promise<S3Client> | null = null;

  constructor(
    @Inject(ENV) private readonly env: BaseEnv,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
  ) {}

  get workspaceBucket(): string {
    return this.env.S3_BUCKET;
  }
  get attachmentsBucket(): string {
    return this.env.S3_ATTACHMENTS_BUCKET;
  }

  async client(): Promise<S3Client> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const creds = await this.secrets.read(this.env.S3_CREDENTIALS_REF);
        if (!creds.accessKeyId || !creds.secretAccessKey) {
          throw new StorageUnavailableError('Identifiants S3 absents de Vault');
        }
        return new S3Client({
          endpoint: this.env.S3_ENDPOINT,
          region: this.env.S3_REGION,
          forcePathStyle: this.env.S3_FORCE_PATH_STYLE,
          credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
          maxAttempts: 4,
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        });
      })().catch((err) => {
        this.clientPromise = null;
        throw err;
      });
    }
    return this.clientPromise;
  }

  async put(bucket: string, key: string, body: PutObjectCommandInput['Body'], opts: { contentType?: string; contentLength?: number; sha256Base64?: string } = {}) {
    const c = await this.client();
    try {
      await c.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
          ContentLength: opts.contentLength,
          ChecksumSHA256: opts.sha256Base64,
        }),
      );
    } catch (err) {
      throw new StorageUnavailableError(`S3 put ${key}: ${(err as Error).message}`);
    }
  }

  async getBuffer(bucket: string, key: string): Promise<Buffer | null> {
    const c = await this.client();
    try {
      const res = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await res.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw new StorageUnavailableError(`S3 get ${key}: ${(err as Error).message}`);
    }
  }

  async head(bucket: string, key: string): Promise<{ size: number } | null> {
    const c = await this.client();
    try {
      const res = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      throw new StorageUnavailableError(`S3 head ${key}: ${(err as Error).message}`);
    }
  }

  async list(bucket: string, prefix: string): Promise<Array<{ key: string; size: number; lastModified?: Date }>> {
    const c = await this.client();
    const out: Array<{ key: string; size: number; lastModified?: Date }> = [];
    let token: string | undefined;
    do {
      const res = await c.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) out.push({ key: o.Key!, size: Number(o.Size ?? 0), ...(o.LastModified ? { lastModified: o.LastModified } : {}) });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async deleteMany(bucket: string, keys: string[]): Promise<void> {
    const c = await this.client();
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await c.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const c = await this.client();
      await c.send(new HeadBucketCommand({ Bucket: this.env.S3_BUCKET }));
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
