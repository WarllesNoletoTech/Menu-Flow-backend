import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema, Restaurant, RestaurantSchema } from '../common/schemas';
import { OrdersRealtimeModule } from '../orders/orders-realtime.module';
import { RappidexIntegrationController } from './rappidex.controller';
import { RappidexIntegrationGuard } from './rappidex.guard';
import { RappidexIntegrationService } from './rappidex.service';

@Module({
  imports: [
    OrdersRealtimeModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Restaurant.name, schema: RestaurantSchema },
    ]),
  ],
  controllers: [RappidexIntegrationController],
  providers: [RappidexIntegrationService, RappidexIntegrationGuard],
  exports: [RappidexIntegrationService],
})
export class IntegrationsModule {}
