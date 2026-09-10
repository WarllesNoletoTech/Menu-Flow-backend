import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Coupon, CouponSchema, Customer, CustomerSchema, DeliveryZone, DeliveryZoneSchema, Order, OrderSchema, Payment, PaymentSchema, Product, ProductSchema, Restaurant, RestaurantSchema, RestaurantSettings, RestaurantSettingsSchema } from '../common/schemas';
import { CustomerOrdersController, EmployeeOrdersController, OrdersController } from './orders.controller';
import { OrdersGateway } from './orders.gateway';
import { OrdersService } from './orders.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, MongooseModule.forFeature([
    { name: Order.name, schema: OrderSchema },
    { name: Product.name, schema: ProductSchema },
    { name: Customer.name, schema: CustomerSchema },
    { name: DeliveryZone.name, schema: DeliveryZoneSchema },
    { name: Restaurant.name, schema: RestaurantSchema },
    { name: RestaurantSettings.name, schema: RestaurantSettingsSchema },
    { name: Coupon.name, schema: CouponSchema },
    { name: Payment.name, schema: PaymentSchema },
  ])],
  controllers: [OrdersController, CustomerOrdersController, EmployeeOrdersController],
  providers: [OrdersService, OrdersGateway],
})
export class OrdersModule {}
