import { Body, Controller, Post } from '@nestjs/common';
import { IsObject, IsString } from 'class-validator';
import { NotificationsService } from './notifications.service';

class RenewPushSubscriptionDto {
  @IsString() oldEndpoint!: string;
  @IsString() oldAuth!: string;
  @IsObject() subscription!: {
    endpoint: string;
    expirationTime?: number | null;
    keys: { p256dh: string; auth: string };
  };
}

@Controller('notifications/push')
export class NotificationsPushController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('subscriptions/renew')
  renew(@Body() body: RenewPushSubscriptionDto) {
    return this.notifications.renewSubscription(body.oldEndpoint, body.oldAuth, body.subscription);
  }
}
