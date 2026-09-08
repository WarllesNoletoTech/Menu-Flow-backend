import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from './roles';
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
@Injectable() export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!allowed) return true;
    const user = context.switchToHttp().getRequest<{ user?: { role: Role } }>().user;
    if (!user || !allowed.includes(user.role)) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}
