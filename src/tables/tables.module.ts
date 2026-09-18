import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema, RestaurantSettings, RestaurantSettingsSchema, RestaurantTable, RestaurantTableSchema, TableEvent, TableEventSchema, TableSession, TableSessionSchema, User, UserSchema } from '../common/schemas';
import { OrdersModule } from '../orders/orders.module';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

@Module({
  imports: [
    OrdersModule,
    MongooseModule.forFeature([
      { name: RestaurantTable.name, schema: RestaurantTableSchema },
      { name: TableSession.name, schema: TableSessionSchema },
      { name: TableEvent.name, schema: TableEventSchema },
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
      { name: RestaurantSettings.name, schema: RestaurantSettingsSchema },
    ]),
  ],
  controllers: [TablesController],
  providers: [TablesService],
})
export class TablesModule {}
