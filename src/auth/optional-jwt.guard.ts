import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role } from '../common/roles';
import { User, UserDocument } from '../common/schemas';

@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, @InjectModel(User.name) private readonly users: Model<UserDocument>) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ headers: { authorization?: string }; user?: { sub: string; role: Role } }>();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return true;
    try { const payload = await this.jwt.verifyAsync<{ sub: string; role: Role }>(token); if (payload.role === Role.CUSTOMER && await this.users.exists({ _id: payload.sub, role: Role.CUSTOMER, active: true })) req.user = payload; } catch { /* Guests may continue; invalid tokens never authenticate a purchase. */ }
    return true;
  }
}
