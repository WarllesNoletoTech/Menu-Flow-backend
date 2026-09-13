import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NotificationPreference, NotificationPreferenceSchema,
  Restaurant, RestaurantSchema,
  User, UserSchema,
} from '../common/schemas';
import { NotificationsController } from './notifications.controller';
import { NotificationsPushController } from './notifications-push.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports:[MongooseModule.forFeature([
    {name:NotificationPreference.name,schema:NotificationPreferenceSchema},
    {name:Restaurant.name,schema:RestaurantSchema},
    {name:User.name,schema:UserSchema},
  ])],
  controllers:[NotificationsController,NotificationsPushController],
  providers:[NotificationsService],
  exports:[NotificationsService],
})
export class NotificationsModule {}
