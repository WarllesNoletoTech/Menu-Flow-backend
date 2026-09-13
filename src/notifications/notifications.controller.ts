import { Body, Controller, Delete, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNumber, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { NotificationsService } from './notifications.service';

class PreferencesDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() newOrder?: boolean;
  @IsOptional() @IsBoolean() orderCancelled?: boolean;
  @IsOptional() @IsBoolean() orderStatus?: boolean;
}
class PushSubscriptionDto {
  @IsString() endpoint!: string;
  @IsOptional() @IsNumber() expirationTime?: number | null;
  @IsObject() keys!: { p256dh: string; auth: string };
  @IsOptional() @IsString() @MaxLength(128) deviceId?: string;
}
class RemoveSubscriptionDto { @IsString() endpoint!: string; }

@Controller('notifications')
@UseGuards(JwtGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.RESTAURANT_ADMIN)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get('preferences') preferences(@Req() req:{user:{sub:string}}){return this.notifications.getPreferences(req.user.sub)}
  @Patch('preferences') update(@Req() req:{user:{sub:string}},@Body() body:PreferencesDto){return this.notifications.updatePreferences(req.user.sub,body)}
  @Post('subscriptions') subscribe(@Req() req:{user:{sub:string};headers:{'user-agent'?:string}},@Body() body:PushSubscriptionDto){return this.notifications.saveSubscription(req.user.sub,body,req.headers['user-agent'])}
  @Delete('subscriptions') unsubscribe(@Req() req:{user:{sub:string}},@Body() body:RemoveSubscriptionDto){return this.notifications.removeSubscription(req.user.sub,body.endpoint)}
  @Post('test') test(@Req() req:{user:{sub:string}}){return this.notifications.sendTest(req.user.sub)}
}
