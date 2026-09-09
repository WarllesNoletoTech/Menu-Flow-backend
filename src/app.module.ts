import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { UsersModule } from './users/users.module';
import { CustomersModule } from './customers/customers.module';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]), MongooseModule.forRootAsync({ inject: [ConfigService], useFactory: (c: ConfigService) => ({ uri: c.getOrThrow<string>('MONGODB_URI') }) }), AuthModule, RestaurantsModule, CatalogModule, OrdersModule, UsersModule, CustomersModule] })
export class AppModule {}
