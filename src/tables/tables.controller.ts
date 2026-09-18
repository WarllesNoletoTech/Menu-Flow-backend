import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { TablesService, TableActor } from './tables.service';

class TableAddonSelectionDto { @IsMongoId() groupId!: string; @IsMongoId() addonId!: string; }
class TableOrderItemDto {
  @IsMongoId() productId!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TableAddonSelectionDto) addons?: TableAddonSelectionDto[];
  @IsOptional() @IsString() @MaxLength(500) observation?: string;
}
class BulkTableDto {
  @IsInt() @Min(1) @Max(999) from!: number;
  @IsInt() @Min(1) @Max(999) to!: number;
  @IsOptional() @IsString() @MaxLength(30) prefix?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) capacity?: number;
}
class UpdateTableDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) capacity?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
class OpenTableDto {
  @IsOptional() @IsString() @MaxLength(120) customerName?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) peopleCount?: number;
  @IsOptional() @IsMongoId() waiterId?: string;
}
class CreateTableOrderDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => TableOrderItemDto) items!: TableOrderItemDto[];
}
class PaymentDto {
  @IsInt() @Min(1) amountCents!: number;
  @IsIn(['PIX', 'CASH', 'CREDIT_CARD', 'DEBIT_CARD']) method!: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
class DiscountDto { @IsInt() @Min(0) discountCents!: number; }
class CancelTableOrderDto { @IsOptional() @IsString() @MaxLength(500) reason?: string; }
class TransferDto { @IsMongoId() fromTableId!: string; @IsMongoId() toTableId!: string; }
class MergeDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsMongoId({ each: true }) tableIds!: string[]; }
class WaiterDto { @IsMongoId() waiterId!: string; }

type RequestWithActor = { user: TableActor };

@Controller('table-service')
@UseGuards(JwtGuard, RolesGuard)
@Roles(Role.RESTAURANT_ADMIN, Role.EMPLOYEE)
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @Get('context') context(@Req() req: RequestWithActor) { return this.tables.context(req.user); }
  @Get('waiters') waiters(@Req() req: RequestWithActor) { return this.tables.waiters(req.user); }
  @Post('tables/bulk') bulk(@Req() req: RequestWithActor, @Body() body: BulkTableDto) { return this.tables.bulkCreate(req.user, body); }
  @Patch('tables/:tableId') updateTable(@Req() req: RequestWithActor, @Param('tableId') tableId: string, @Body() body: UpdateTableDto) { return this.tables.updateTable(req.user, tableId, body); }
  @Post('tables/:tableId/open') open(@Req() req: RequestWithActor, @Param('tableId') tableId: string, @Body() body: OpenTableDto) { return this.tables.open(req.user, tableId, body); }
  @Get('sessions/:sessionId') session(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string) { return this.tables.session(req.user, sessionId); }
  @Get('sessions/:sessionId/events') events(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string) { return this.tables.events(req.user, sessionId); }
  @Post('sessions/:sessionId/orders') order(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Body() body: CreateTableOrderDto) { return this.tables.addOrder(req.user, sessionId, body.items); }
  @Patch('sessions/:sessionId/orders/:orderId/ready') readyOrder(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Param('orderId') orderId: string) { return this.tables.markOrderReady(req.user, sessionId, orderId); }
  @Patch('sessions/:sessionId/orders/:orderId/delivered') deliverOrder(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Param('orderId') orderId: string) { return this.tables.deliverOrder(req.user, sessionId, orderId); }
  @Patch('sessions/:sessionId/orders/:orderId/cancel') cancelOrder(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Param('orderId') orderId: string, @Body() body: CancelTableOrderDto) { return this.tables.cancelOrder(req.user, sessionId, orderId, body.reason); }
  @Patch('sessions/:sessionId/request-bill') requestBill(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string) { return this.tables.requestBill(req.user, sessionId); }
  @Post('sessions/:sessionId/payments') payment(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Body() body: PaymentDto) { return this.tables.addPayment(req.user, sessionId, body); }
  @Patch('sessions/:sessionId/discount') discount(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Body() body: DiscountDto) { return this.tables.setDiscount(req.user, sessionId, body.discountCents); }
  @Patch('sessions/:sessionId/waiter') waiter(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Body() body: WaiterDto) { return this.tables.changeWaiter(req.user, sessionId, body.waiterId); }
  @Post('sessions/:sessionId/transfer') transfer(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Body() body: TransferDto) { return this.tables.transfer(req.user, sessionId, body.fromTableId, body.toTableId); }
  @Post('sessions/:sessionId/merge') merge(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string, @Body() body: MergeDto) { return this.tables.merge(req.user, sessionId, body.tableIds); }
  @Patch('sessions/:sessionId/close') close(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string) { return this.tables.close(req.user, sessionId); }
}
