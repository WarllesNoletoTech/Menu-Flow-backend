import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'; import { JwtService } from '@nestjs/jwt'; import { InjectModel } from '@nestjs/mongoose'; import { Model } from 'mongoose'; import { Role } from '../common/roles'; import { User, UserDocument } from '../common/schemas';
type JwtPayload = { sub: string; role: Role; restaurantId?: string };
@Injectable() export class JwtGuard implements CanActivate { constructor(private readonly jwt: JwtService, @InjectModel(User.name) private readonly users: Model<UserDocument>) {} async canActivate(context: ExecutionContext) { const req = context.switchToHttp().getRequest<{ headers: { authorization?: string }; user?: JwtPayload }>(); const token = req.headers.authorization?.replace(/^Bearer\s+/i, ''); if (!token) throw new UnauthorizedException(); try {
  const payload = await this.jwt.verifyAsync<JwtPayload>(token);
  const user = await this.users.findOne({ _id: payload.sub, active: true, role: payload.role, $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] }).select('restaurantId role active').lean();
  if (!user) throw new UnauthorizedException();
  const membershipRole = payload.role === Role.RESTAURANT_ADMIN || payload.role === Role.EMPLOYEE;
  const databaseRestaurantId = user.restaurantId?.toString();
  if (membershipRole ? !databaseRestaurantId || !payload.restaurantId || databaseRestaurantId !== payload.restaurantId : databaseRestaurantId !== undefined || payload.restaurantId !== undefined) throw new UnauthorizedException();
  req.user = { sub: payload.sub, role: payload.role, ...(databaseRestaurantId ? { restaurantId: databaseRestaurantId } : {}) }; return true;
 } catch { throw new UnauthorizedException(); } } }
