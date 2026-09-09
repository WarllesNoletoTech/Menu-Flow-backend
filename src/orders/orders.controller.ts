import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsMongoId, IsNumber, IsObject, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { TenantGuard } from '../common/tenant.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { CheckoutInput, OrdersService } from './orders.service';

class CheckoutItemDto {
  @IsMongoId() productId!: string;
  @IsNumber() @Min(1) quantity!: number;
  @IsOptional() @IsArray() @IsString({ each: true }) addonNames?: string[];
  @IsOptional() @IsString() observation?: string;
}
class CreateOrderDto {
  @IsString() customerName!: string;
  @IsString() phone!: string;
  @IsIn(['DELIVERY', 'PICKUP']) fulfillment!: 'DELIVERY' | 'PICKUP';
  @IsIn(['PIX', 'CASH', 'CREDIT_CARD', 'DEBIT_CARD']) paymentMethod!: string;
  @IsOptional() @IsObject() address?: Record<string, string>;
  @IsOptional() @IsNumber() @Min(0) changeFor?: number;
  @IsOptional() @IsString() couponCode?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CheckoutItemDto) items!: CheckoutItemDto[];
}
class UpdateOrderStatusDto { @IsIn(['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED']) status!: string; }
@Controller('restaurants/:restaurantId/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}
  @Post() @UseGuards(OptionalJwtGuard) create(@Param('restaurantId') id: string, @Body() body: CreateOrderDto, @Req() request: { user?: { sub: string; role: Role } }) { return this.orders.create(id, body as CheckoutInput, request.user?.role === Role.CUSTOMER ? request.user.sub : undefined); }
  @Get() @UseGuards(JwtGuard, TenantGuard) list(@Param('restaurantId') id: string) { return this.orders.list(id); }
  @Patch(':orderId/status') @UseGuards(JwtGuard, TenantGuard) updateStatus(@Param('restaurantId') restaurantId: string, @Param('orderId') orderId: string, @Body() body: UpdateOrderStatusDto) { return this.orders.updateStatus(restaurantId, orderId, body.status); }
}
@Controller('customer/orders') @UseGuards(JwtGuard, RolesGuard) @Roles(Role.CUSTOMER)
export class CustomerOrdersController { constructor(private readonly orders: OrdersService) {} @Get() list(@Req() request: { user: { sub: string } }) { return this.orders.forCustomer(request.user.sub); } }
