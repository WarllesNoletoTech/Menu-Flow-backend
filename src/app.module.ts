import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { UsersModule } from './users/users.module';
import { CustomersModule } from './customers/customers.module';
import { LocationsModule } from './locations/locations.module';
import { BillingModule } from './billing/billing.module';
import { EstablishmentTypesModule } from './establishment-types/establishment-types.module';
import { HomeBannersModule } from './home-banners/home-banners.module';

function validateEnvironment(environment: Record<string, unknown>) {
  for (const variable of ['MONGODB_URI', 'JWT_SECRET']) {
    if (typeof environment[variable] !== 'string' || environment[variable].trim() === '') {
      throw new Error(`${variable} must be configured before starting the API.`);
    }
  }

  if (environment.NODE_ENV === 'production' && (typeof environment.FRONTEND_URL !== 'string' || environment.FRONTEND_URL.trim() === '')) {
    throw new Error('FRONTEND_URL must be configured in production to restrict CORS.');
  }

  return environment;
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }), ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]), MongooseModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ uri: config.getOrThrow<string>('MONGODB_URI'), serverSelectionTimeoutMS: 10000, retryAttempts: 5, retryDelay: 1000 }) }), AuthModule, EstablishmentTypesModule, HomeBannersModule, RestaurantsModule, CatalogModule, OrdersModule, UsersModule, CustomersModule, LocationsModule, BillingModule],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
