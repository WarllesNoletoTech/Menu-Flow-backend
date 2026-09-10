import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuthModule } from "../auth/auth.module";
import {
  AuditLog,
  AuditLogSchema,
  BillingCounter,
  BillingCounterSchema,
  BillingInvoice,
  BillingInvoiceSchema,
  BillingPlan,
  BillingPlanSchema,
  BillingReport,
  BillingReportSchema,
  PlatformBillingSettings,
  PlatformBillingSettingsSchema,
  ServiceReportItem,
  ServiceReportItemSchema,
  Order,
  OrderSchema,
  Restaurant,
  RestaurantSchema,
  User,
  UserSchema,
} from "../common/schemas";
import { OrderMetricsService } from "../orders/order-metrics.service";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: BillingPlan.name, schema: BillingPlanSchema },
      { name: BillingInvoice.name, schema: BillingInvoiceSchema },
      { name: BillingReport.name, schema: BillingReportSchema },
      { name: ServiceReportItem.name, schema: ServiceReportItemSchema },
      {
        name: PlatformBillingSettings.name,
        schema: PlatformBillingSettingsSchema,
      },
      { name: BillingCounter.name, schema: BillingCounterSchema },
      { name: Restaurant.name, schema: RestaurantSchema },
      { name: Order.name, schema: OrderSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [BillingController],
  providers: [BillingService, OrderMetricsService],
})
export class BillingModule {}
