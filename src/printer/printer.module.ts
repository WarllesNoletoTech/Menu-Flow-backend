import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema, PrintJob, PrintJobSchema, Restaurant, RestaurantSchema, RestaurantSettings, RestaurantSettingsSchema, RestaurantTable, RestaurantTableSchema, TableSession, TableSessionSchema, User, UserSchema } from '../common/schemas';
import { PrinterAgentController, PrinterController } from './printer.controller';
import { PrinterService } from './printer.service';

@Module({
  imports: [MongooseModule.forFeature([
    { name: PrintJob.name, schema: PrintJobSchema },
    { name: RestaurantSettings.name, schema: RestaurantSettingsSchema },
    { name: Restaurant.name, schema: RestaurantSchema },
    { name: Order.name, schema: OrderSchema },
    { name: TableSession.name, schema: TableSessionSchema },
    { name: RestaurantTable.name, schema: RestaurantTableSchema },
    { name: User.name, schema: UserSchema },
  ])],
  controllers: [PrinterController, PrinterAgentController],
  providers: [PrinterService],
  exports: [PrinterService],
})
export class PrinterModule {}
