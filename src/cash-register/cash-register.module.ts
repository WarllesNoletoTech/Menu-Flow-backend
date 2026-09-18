import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CashMovement, CashMovementSchema, CashRegisterShift, CashRegisterShiftSchema, Restaurant, RestaurantSchema, User, UserSchema } from '../common/schemas';
import { PrinterModule } from '../printer/printer.module';
import { CashRegisterController } from './cash-register.controller';
import { CashRegisterService } from './cash-register.service';

@Module({
  imports: [
    PrinterModule,
    MongooseModule.forFeature([
      { name: CashRegisterShift.name, schema: CashRegisterShiftSchema },
      { name: CashMovement.name, schema: CashMovementSchema },
      { name: Restaurant.name, schema: RestaurantSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [CashRegisterController],
  providers: [CashRegisterService],
  exports: [CashRegisterService],
})
export class CashRegisterModule {}
