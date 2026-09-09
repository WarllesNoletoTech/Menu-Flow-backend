import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { Restaurant, RestaurantSchema, User, UserSchema } from '../common/schemas';
import { EmployeesController, UsersController } from './users.controller';
@Module({ imports: [AuthModule, MongooseModule.forFeature([{ name: User.name, schema: UserSchema }, { name: Restaurant.name, schema: RestaurantSchema }])], controllers: [UsersController, EmployeesController] })
export class UsersModule {}
