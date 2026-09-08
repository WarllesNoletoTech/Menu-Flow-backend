import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Role } from './roles';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ user?: { restaurantId?: string; role: Role }; params: { restaurantId?: string } }>();
    const { user } = request;
    if (!user) return false;
    if (user.role === Role.SUPER_ADMIN) return true;
    if (request.params.restaurantId && request.params.restaurantId !== user.restaurantId) throw new ForbiddenException('Tenant access denied');
    return Boolean(user.restaurantId);
  }
}
