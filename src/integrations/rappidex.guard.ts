import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class RappidexIntegrationGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configured = String(this.config.get<string>('RAPPIDEX_INTEGRATION_SECRET') || '').trim();
    const request = context.switchToHttp().getRequest();
    const authorization = String(request.headers.authorization || '').trim();
    const bearer = authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : '';
    const fallback = String(request.headers['x-rappidex-secret'] || '').trim();
    const received = bearer || fallback;

    if (!configured || !received) {
      throw new UnauthorizedException('Integração Rappidex não autorizada.');
    }

    const expectedBuffer = Buffer.from(configured);
    const receivedBuffer = Buffer.from(received);
    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      throw new UnauthorizedException('Integração Rappidex não autorizada.');
    }

    return true;
  }
}
