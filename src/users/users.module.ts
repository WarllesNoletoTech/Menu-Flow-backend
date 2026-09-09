import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmployeesController, UsersController } from './users.controller';
@Module({ imports: [AuthModule], controllers: [UsersController, EmployeesController] })
export class UsersModule {}
