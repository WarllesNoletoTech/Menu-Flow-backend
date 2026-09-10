import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { EstablishmentTypeDefinition, EstablishmentTypeDefinitionSchema, Restaurant, RestaurantSchema } from '../common/schemas';
import { EstablishmentTypesController, PublicEstablishmentTypesController } from './establishment-types.controller';
import { EstablishmentTypesService } from './establishment-types.service';

@Module({ imports: [AuthModule, MongooseModule.forFeature([{ name: EstablishmentTypeDefinition.name, schema: EstablishmentTypeDefinitionSchema }, { name: Restaurant.name, schema: RestaurantSchema }])], controllers: [EstablishmentTypesController, PublicEstablishmentTypesController], providers: [EstablishmentTypesService], exports: [EstablishmentTypesService] })
export class EstablishmentTypesModule {}
