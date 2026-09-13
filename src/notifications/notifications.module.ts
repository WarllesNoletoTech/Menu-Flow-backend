import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NotificationPreference, NotificationPreferenceSchema,
  PushSubscriptionRecord, PushSubscriptionRecordSchema,
  PushVapidConfig, PushVapidConfigSchema,
  Restaurant, RestaurantSchema,
  User, UserSchema,
} from '../common/schemas';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
@Module({
  imports:[MongooseModule.forFeature([
    {name:NotificationPreference.name,schema:NotificationPreferenceSchema},
    {name:PushSubscriptionRecord.name,schema:PushSubscriptionRecordSchema},
    {name:PushVapidConfig.name,schema:PushVapidConfigSchema},
    {name:Restaurant.name,schema:RestaurantSchema},
    {name:User.name,schema:UserSchema},
  ])],
  controllers:[NotificationsController],providers:[NotificationsService],exports:[NotificationsService]
})
export class NotificationsModule {}
