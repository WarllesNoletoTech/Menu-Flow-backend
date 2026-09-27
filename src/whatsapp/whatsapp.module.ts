import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { Restaurant, RestaurantSchema, RestaurantSettings, RestaurantSettingsSchema } from '../common/schemas';
import { WhatsappConnection, WhatsappConnectionSchema, WhatsappConversation, WhatsappConversationSchema, WhatsappMessage, WhatsappMessageSchema } from './whatsapp.schemas';
import { WhatsappController, WhatsappWebhookController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
@Module({ imports: [AuthModule, MongooseModule.forFeature([
  { name: Restaurant.name, schema: RestaurantSchema }, { name: RestaurantSettings.name, schema: RestaurantSettingsSchema },
  { name: WhatsappConnection.name, schema: WhatsappConnectionSchema }, { name: WhatsappConversation.name, schema: WhatsappConversationSchema }, { name: WhatsappMessage.name, schema: WhatsappMessageSchema },
])], controllers: [WhatsappController, WhatsappWebhookController], providers: [WhatsappService] })
export class WhatsappModule {}
