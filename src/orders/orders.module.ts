import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Coupon, CouponSchema, Customer, CustomerSchema, DeliveryZone, DeliveryZoneSchema, Order, OrderSchema, Product, ProductSchema, Restaurant, RestaurantSchema, RestaurantSettings, RestaurantSettingsSchema } from '../common/schemas';
import { OrdersController } from './orders.controller';
import { OrdersGateway } from './orders.gateway';
import { OrdersService } from './orders.service';

@Module({
  imports: [MongooseModule.forFeature([
    { name: Order.name, schema: OrderSchema },
    { name: Product.name, schema: ProductSchema },
    { name: Customer.name, schema: CustomerSchema },
    { name: DeliveryZone.name, schema: DeliveryZoneSchema },
    { name: Restaurant.name, schema: RestaurantSchema },
    { name: RestaurantSettings.name, schema: RestaurantSettingsSchema },
    { name: Coupon.name, schema: CouponSchema },
  ])],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersGateway],
})
export class OrdersModule {}
