import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

export type BannerImage = { url: string; publicId: string };
export type BannerUploadFile = { buffer: Buffer; mimetype: string; size: number; originalname: string };

@Injectable()
export class BannerStorageService {
  constructor(private readonly config: ConfigService) {}

  async upload(file: BannerUploadFile, placement: 'desktop' | 'mobile'): Promise<BannerImage> {
    const { cloudName, apiKey, apiSecret } = this.credentials();
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'menu-flow/home-banners';
    const publicId = `${placement}-${crypto.randomUUID()}`;
    const signature = this.sign(`folder=${folder}&public_id=${publicId}&timestamp=${timestamp}`, apiSecret);
    const body = new FormData();
    body.set('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), publicId);
    body.set('api_key', apiKey);
    body.set('timestamp', String(timestamp));
    body.set('folder', folder);
    body.set('public_id', publicId);
    body.set('signature', signature);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, { method: 'POST', body });
    const result = await response.json() as { secure_url?: string; public_id?: string; error?: { message?: string } };
    if (!response.ok || !result.secure_url || !result.public_id) throw new BadGatewayException('Não foi possível enviar a imagem.');
    return { url: result.secure_url, publicId: result.public_id };
  }

  async remove(publicId?: string | null): Promise<void> {
    if (!publicId) return;
    const { cloudName, apiKey, apiSecret } = this.credentials();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.sign(`public_id=${publicId}&timestamp=${timestamp}`, apiSecret);
    const body = new URLSearchParams({ public_id: publicId, timestamp: String(timestamp), api_key: apiKey, signature });
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`, { method: 'POST', body });
    if (!response.ok) throw new BadGatewayException('Não foi possível remover a imagem.');
  }

  private credentials() {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME')?.trim();
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY')?.trim();
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET')?.trim();
    if (!cloudName || !apiKey || !apiSecret) throw new ServiceUnavailableException('O armazenamento de imagens não está configurado.');
    return { cloudName, apiKey, apiSecret };
  }

  private sign(parameters: string, secret: string) { return createHash('sha1').update(`${parameters}${secret}`).digest('hex'); }
}
