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

function validateEnvironment(environment: Record<string, unknown>) {
  for (const variable of ['MONGODB_URI', 'JWT_SECRET']) {
    if (typeof environment[variable] !== 'string' || environment[variable].trim() === '') {
      throw new Error(`${variable} must be configured before starting the API.`);
    }
  }

  return environment;
}

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }), ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]), MongooseModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ uri: config.getOrThrow<string>('MONGODB_URI'), serverSelectionTimeoutMS: 10000 }) }), AuthModule, RestaurantsModule, CatalogModule, OrdersModule, UsersModule, CustomersModule] })
export class AppModule {}
