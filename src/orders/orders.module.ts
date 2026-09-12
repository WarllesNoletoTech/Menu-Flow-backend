import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Category, CategorySchema, Coupon, CouponSchema, Customer, CustomerSchema, DeliveryZone, DeliveryZoneSchema, Order, OrderSchema, Payment, PaymentSchema, Product, ProductSchema, Restaurant, RestaurantSchema, RestaurantSettings, RestaurantSettingsSchema } from '../common/schemas';
import { AdminOrdersController, CustomerOrdersController, EmployeeOrdersController, OrdersController, PublicOrderController } from './orders.controller';
import { OrdersGateway } from './orders.gateway';
import { OrdersService } from './orders.service';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { OrdersRealtimeModule } from './orders-realtime.module';

@Module({
  imports: [AuthModule, IntegrationsModule, OrdersRealtimeModule, MongooseModule.forFeature([
    { name: Order.name, schema: OrderSchema },
    { name: Category.name, schema: CategorySchema },
    { name: Product.name, schema: ProductSchema },
    { name: Customer.name, schema: CustomerSchema },
    { name: DeliveryZone.name, schema: DeliveryZoneSchema },
    { name: Restaurant.name, schema: RestaurantSchema },
    { name: RestaurantSettings.name, schema: RestaurantSettingsSchema },
    { name: Coupon.name, schema: CouponSchema },
    { name: Payment.name, schema: PaymentSchema },
  ])],
  controllers: [OrdersController, AdminOrdersController, CustomerOrdersController, PublicOrderController, EmployeeOrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
