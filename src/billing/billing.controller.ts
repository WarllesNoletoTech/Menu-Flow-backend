import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { JwtGuard } from "../auth/jwt.guard";
import { Role } from "../common/roles";
import { Roles, RolesGuard } from "../common/roles.guard";
import { BillingInvoiceStatus, BillingReportStatus } from "../common/schemas";
import { BillingService } from "./billing.service";
class TierDto {
  @IsInt() @Min(0) minOrders!: number;
  @IsOptional() @IsInt() @Min(0) maxOrders!: number | null;
  @IsInt() @Min(0) amountCents!: number;
}
class PlanDto {
  @IsString() name!: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(28) dueDay?: number;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TierDto)
  tiers!: TierDto[];
}
class GenerateDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period!: string;
}
class StatusDto {
  @IsIn(["PAID", "WAIVED", "CANCELLED"]) status!: BillingInvoiceStatus;
}
class PaymentSettingsDto {
  @IsString() pixReceiverName!: string;
  @IsString() pixKey!: string;
}
class ReportDto {
  @IsMongoId() restaurantId!: string;
  @IsString() periodStart!: string;
  @IsString() periodEnd!: string;
  @IsBoolean() includeMonthlyFee!: boolean;
  @IsOptional() @IsInt() @Min(0) monthlyFeeCents?: number;
}
class ReportStatusDto {
  @IsIn(["PAID"]) status!: BillingReportStatus;
}
@Controller("billing")
@UseGuards(JwtGuard, RolesGuard)
export class BillingController {
  constructor(private billing: BillingService) {}
  @Get("dashboard") @Roles(Role.SUPER_ADMIN) dashboard() {
    return this.billing.dashboard();
  }
  @Get("plans") @Roles(Role.SUPER_ADMIN) plans() {
    return this.billing.listPlans();
  }
  @Post("plans") @Roles(Role.SUPER_ADMIN) create(@Body() b: PlanDto) {
    return this.billing.createPlan(b);
  }
  @Patch("plans/:id") @Roles(Role.SUPER_ADMIN) update(
    @Param("id") id: string,
    @Body() b: Partial<PlanDto>,
  ) {
    return this.billing.updatePlan(id, b as any);
  }
  @Patch("restaurants/:id") @Roles(Role.SUPER_ADMIN) assign(
    @Param("id") id: string,
    @Body()
    b: {
      billingPlanId?: string;
      billingStartAt?: string;
      billingDueDay?: number;
    },
  ) {
    return this.billing.assignRestaurant(id, b);
  }
  @Post("invoices/generate") @Roles(Role.SUPER_ADMIN) generate(
    @Body() b: GenerateDto,
  ) {
    return this.billing.generate(b.period);
  }
  @Get("invoices") @Roles(Role.SUPER_ADMIN) list(
    @Query("page") p = "1",
    @Query("limit") l = "20",
    @Query("status") s?: string,
  ) {
    return this.billing.listInvoices(+p, Math.min(100, +l), s);
  }
  @Get("invoices/:id") @Roles(Role.SUPER_ADMIN) invoice(
    @Param("id") id: string,
  ) {
    return this.billing.invoice(id);
  }
  @Patch("invoices/:id/status") @Roles(Role.SUPER_ADMIN) setStatus(
    @Param("id") id: string,
    @Body() b: StatusDto,
    @Req() r: { user: { sub: string } },
  ) {
    return this.billing.setStatus(id, b.status, r.user.sub);
  }
  @Get("me/dashboard")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.RESTAURANT_ADMIN)
  merchantDashboard(@Req() r: { user: { restaurantId: string } }) {
    return this.billing.merchantDashboard(r.user.restaurantId);
  }
  @Get("me/sales-report")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.RESTAURANT_ADMIN)
  merchantSalesReport(
    @Req() r: { user: { restaurantId: string } },
    @Query("start") start: string,
    @Query("end") end: string,
  ) {
    return this.billing.merchantSalesReport(r.user.restaurantId, start, end);
  }
  @Get("me/sales-report/pdf")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.RESTAURANT_ADMIN)
  async merchantSalesReportPdf(
    @Req() r: { user: { restaurantId: string } },
    @Query("start") start: string,
    @Query("end") end: string,
    @Res() res: any,
  ) {
    const out = await this.billing.merchantSalesReportPdf(r.user.restaurantId, start, end);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${out.filename}"`,
    });
    res.send(out.pdf);
  }

  @Get("me")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.RESTAURANT_ADMIN)
  merchant(
    @Req() r: { user: { restaurantId: string } },
    @Query("period") p: string,
  ) {
    return this.billing.merchant(r.user.restaurantId, p);
  }
  @Get("reports/preview") @Roles(Role.SUPER_ADMIN) preview(
    @Query("restaurantId") id: string,
    @Query("start") start: string,
    @Query("end") end: string,
    @Query("chargeDate") chargeDate?: string,
  ) {
    return this.billing.previewReport(id, start, end, chargeDate);
  }
  @Post("reports") @Roles(Role.SUPER_ADMIN) createReport(
    @Body() b: ReportDto,
    @Req() r: { user: { sub: string } },
  ) {
    return this.billing.generateReport(b, r.user.sub);
  }
  @Get("reports")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.SUPER_ADMIN)
  reports(
    @Query()
    q: {
      restaurantId?: string;
      status?: string;
      start?: string;
      end?: string;
      monthly?: string;
    },
  ) {
    return this.billing.listReports(q);
  }
  @Get("reports/:id") @Roles(Role.SUPER_ADMIN) report(@Param("id") id: string) {
    return this.billing.report(id, undefined, true);
  }
  @Get("reports/:id/pdf")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.SUPER_ADMIN)
  async pdf(@Param("id") id: string, @Res() res: any) {
    const out = await this.billing.reportPdf(id, undefined, true);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${out.filename}"`,
    });
    res.send(out.pdf);
  }
  @Delete("reports/:id") @Roles(Role.SUPER_ADMIN) deleteReport(
    @Param("id") id: string,
    @Req() r: { user: { sub: string } },
  ) {
    return this.billing.deleteReport(id, r.user.sub);
  }
  @Patch("reports/:id/status") @Roles(Role.SUPER_ADMIN) setReportStatus(
    @Param("id") id: string,
    @Body() b: ReportStatusDto,
    @Req() r: { user: { sub: string } },
  ) {
    return this.billing.setReportStatus(id, b.status, r.user.sub);
  }
  @Get("settings/payment")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.SUPER_ADMIN)
  paymentSettings() {
    return this.billing.getPaymentSettings();
  }
  @Put("settings/payment") @Roles(Role.SUPER_ADMIN) updatePaymentSettings(
    @Body() b: PaymentSettingsDto,
    @Req() r: { user: { sub: string } },
  ) {
    return this.billing.updatePaymentSettings(b, r.user.sub);
  }
  @Get("me/reports")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.RESTAURANT_ADMIN)
  myReports(@Req() r: { user: { restaurantId: string } }) {
    return this.billing.listReports({}, r.user.restaurantId);
  }
  @Get("me/reports/unread-count")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.RESTAURANT_ADMIN)
  myUnreadReports(@Req() r: { user: { restaurantId: string } }) {
    return this.billing.merchantUnreadReports(r.user.restaurantId);
  }
  @Patch("me/reports/viewed")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.RESTAURANT_ADMIN)
  markMyReportsViewed(@Req() r: { user: { restaurantId: string } }) {
    return this.billing.markMerchantReportsViewed(r.user.restaurantId);
  }
  @Get("me/reports/:id/pdf")
  @Header("Cache-Control", "no-store, private")
  @Roles(Role.RESTAURANT_ADMIN)
  async myPdf(
    @Param("id") id: string,
    @Req() r: { user: { restaurantId: string } },
    @Res() res: any,
  ) {
    const out = await this.billing.reportPdf(id, r.user.restaurantId);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${out.filename}"`,
    });
    res.send(out.pdf);
  }
}
