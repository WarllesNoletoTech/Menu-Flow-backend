import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from 'crypto';

export type NativePushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

export type VapidDetails = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

export class WebPushHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(`Web Push respondeu HTTP ${statusCode}`);
    this.name = 'WebPushHttpError';
  }
}

const base64url = (value: Buffer) => value.toString('base64url');
const decodeBase64url = (value: string) => Buffer.from(value, 'base64url');
const hmacSha256 = (key: Buffer, data: Buffer) =>
  createHmac('sha256', key).update(data).digest();

export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: base64url(ecdh.getPublicKey()),
    privateKey: base64url(ecdh.getPrivateKey()),
  };
}

export function encryptWebPushPayload(
  payload: Buffer,
  userPublicKey: string,
  authSecret: string,
  options?: { salt?: Buffer; serverPrivateKey?: Buffer; recordSize?: number },
) {
  const uaPublic = decodeBase64url(userPublicKey);
  const auth = decodeBase64url(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04)
    throw new Error('Chave pública de assinatura push inválida.');
  if (auth.length < 16) throw new Error('Segredo de autenticação push inválido.');

  const server = createECDH('prime256v1');
  if (options?.serverPrivateKey) server.setPrivateKey(options.serverPrivateKey);
  else server.generateKeys();
  const asPublic = server.getPublicKey();
  const sharedSecret = server.computeSecret(uaPublic);
  const salt = options?.salt ?? randomBytes(16);
  const recordSize = options?.recordSize ?? 4096;

  const prkKey = hmacSha256(auth, sharedSecret);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info', 'ascii'),
    Buffer.from([0]),
    uaPublic,
    asPublic,
  ]);
  const ikm = hmacSha256(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmacSha256(salt, ikm);
  const cek = hmacSha256(
    prk,
    Buffer.concat([
      Buffer.from('Content-Encoding: aes128gcm', 'ascii'),
      Buffer.from([0, 1]),
    ]),
  ).subarray(0, 16);
  const nonce = hmacSha256(
    prk,
    Buffer.concat([
      Buffer.from('Content-Encoding: nonce', 'ascii'),
      Buffer.from([0, 1]),
    ]),
  ).subarray(0, 12);

  const plaintext = Buffer.concat([payload, Buffer.from([0x02])]);
  if (recordSize <= plaintext.length + 16)
    throw new Error('Payload de notificação excede o tamanho permitido.');

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(recordSize, 0);
  const header = Buffer.concat([
    salt,
    rs,
    Buffer.from([asPublic.length]),
    asPublic,
  ]);
  return Buffer.concat([header, ciphertext]);
}

export function createVapidJwt(endpoint: string, details: VapidDetails) {
  const publicKey = decodeBase64url(details.publicKey);
  const privateKey = decodeBase64url(details.privateKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04 || privateKey.length !== 32)
    throw new Error('Chaves VAPID inválidas.');

  const x = publicKey.subarray(1, 33);
  const y = publicKey.subarray(33, 65);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(x),
    y: base64url(y),
    d: base64url(privateKey),
  };
  const key = createPrivateKey({ key: jwk as any, format: 'jwk' });
  const encodedHeader = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const endpointUrl = new URL(endpoint);
  const encodedPayload = base64url(Buffer.from(JSON.stringify({
    aud: endpointUrl.origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: details.subject,
  })));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

export async function sendWebPush(
  subscription: NativePushSubscription,
  payload: string,
  vapid: VapidDetails,
) {
  const body = encryptWebPushPayload(
    Buffer.from(payload, 'utf8'),
    subscription.keys.p256dh,
    subscription.keys.auth,
  );
  const jwt = createVapidJwt(subscription.endpoint, vapid);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '120',
      Urgency: 'high',
    },
    body: body as unknown as BodyInit,
  });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    throw new WebPushHttpError(response.status, responseBody.slice(0, 500));
  }
  return response.status;
}
