import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { AuditLog, AuditLogSchema, DeliveryZone, DeliveryZoneSchema, EstablishmentTypeDefinition, EstablishmentTypeDefinitionSchema, Payment, PaymentSchema, Restaurant, RestaurantSchema, RestaurantSettings, RestaurantSettingsSchema } from '../common/schemas';
import { LocationsModule } from '../locations/locations.module';
import { PublicRestaurantsController } from './public-restaurants.controller';
import { RestaurantsController } from './restaurants.controller';
import { RestaurantsService } from './restaurants.service';

@Module({
  imports: [AuthModule, LocationsModule, MongooseModule.forFeature([
    { name: Restaurant.name, schema: RestaurantSchema },
    { name: EstablishmentTypeDefinition.name, schema: EstablishmentTypeDefinitionSchema },
    { name: RestaurantSettings.name, schema: RestaurantSettingsSchema },
    { name: AuditLog.name, schema: AuditLogSchema },
    { name: DeliveryZone.name, schema: DeliveryZoneSchema },
    { name: Payment.name, schema: PaymentSchema },
  ])],
  controllers: [RestaurantsController, PublicRestaurantsController],
  providers: [RestaurantsService],
  exports: [RestaurantsService],
})
export class RestaurantsModule {}
