import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { CashActor, CashRegisterService } from './cash-register.service';

class OpenCashDto {
  @IsInt() @Min(0) openingAmountCents!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class CashMovementDto {
  @IsInt() @Min(1) amountCents!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class CloseCashDto {
  @IsOptional() @IsInt() @Min(0) declaredCashCents?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
type RequestWithActor = { user: CashActor };

@Controller('cash-register')
@UseGuards(JwtGuard, RolesGuard)
@Roles(Role.RESTAURANT_ADMIN, Role.EMPLOYEE)
export class CashRegisterController {
  constructor(private readonly cash: CashRegisterService) {}

  @Get('current') current(@Req() req: RequestWithActor) { return this.cash.current(req.user); }
  @Post('open') open(@Req() req: RequestWithActor, @Body() body: OpenCashDto) { return this.cash.open(req.user, body); }
  @Post('supply') supply(@Req() req: RequestWithActor, @Body() body: CashMovementDto) { return this.cash.supply(req.user, body); }
  @Post('withdrawal') withdrawal(@Req() req: RequestWithActor, @Body() body: CashMovementDto) { return this.cash.withdrawal(req.user, body); }
  @Post('close') close(@Req() req: RequestWithActor, @Body() body: CloseCashDto) { return this.cash.close(req.user, body); }
  @Post('print') print(@Req() req: RequestWithActor) { return this.cash.printCurrent(req.user); }
  @Post('movements/:movementId/print') printMovement(@Req() req: RequestWithActor, @Param('movementId') movementId: string) { return this.cash.printMovement(req.user, movementId); }
}
