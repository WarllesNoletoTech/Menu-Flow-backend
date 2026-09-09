import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../common/schemas';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({ imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])], controllers: [CustomersController], providers: [CustomersService] })
export class CustomersModule {}
