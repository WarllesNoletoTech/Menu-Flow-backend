import { Body, Controller, Get, Headers, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { PrinterActor, PrinterService } from './printer.service';

class PrinterSettingsDto {
  @IsOptional() @IsBoolean() printerEnabled?: boolean;
  @IsOptional() @IsBoolean() printerAutoKitchen?: boolean;
  @IsOptional() @IsBoolean() printerAutoBill?: boolean;
  @IsOptional() @IsIn([58, 80]) printerPaperWidth?: 58 | 80;
}
class ClaimDto {
  @IsString() @MaxLength(160) deviceId!: string;
  @IsOptional() @IsString() @MaxLength(160) deviceName?: string;
  @IsOptional() @IsArray() @IsIn(['KITCHEN', 'CASHIER', 'BAR'], { each: true }) roles?: Array<'KITCHEN' | 'CASHIER' | 'BAR'>;
}
class AckDto {
  @IsString() @MaxLength(160) deviceId!: string;
  @IsBoolean() success!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) error?: string;
}
type RequestWithActor = { user: PrinterActor };

@Controller('printer')
@UseGuards(JwtGuard, RolesGuard)
@Roles(Role.RESTAURANT_ADMIN, Role.EMPLOYEE)
export class PrinterController {
  constructor(private readonly printer: PrinterService) {}
  @Get('settings') settings(@Req() req: RequestWithActor) { return this.printer.getSettings(req.user); }
  @Patch('settings') update(@Req() req: RequestWithActor, @Body() body: PrinterSettingsDto) { return this.printer.updateSettings(req.user, body); }
  @Post('token') token(@Req() req: RequestWithActor) { return this.printer.rotateToken(req.user); }
  @Post('jobs/order/:orderId') order(@Req() req: RequestWithActor, @Param('orderId') orderId: string) { return this.printer.queueOrderForActor(req.user, orderId); }
  @Post('jobs/bill/:sessionId') bill(@Req() req: RequestWithActor, @Param('sessionId') sessionId: string) { return this.printer.queueBillForActor(req.user, sessionId); }
  @Get('jobs/recent') recent(@Req() req: RequestWithActor) { return this.printer.recent(req.user); }
}

@Controller('printer/agent')
export class PrinterAgentController {
  constructor(private readonly printer: PrinterService) {}
  @Post('claim') claim(@Headers('x-menuflow-printer-token') token: string | undefined, @Body() body: ClaimDto) { return this.printer.claim(token, body); }
  @Patch('jobs/:jobId') acknowledge(@Headers('x-menuflow-printer-token') token: string | undefined, @Param('jobId') jobId: string, @Body() body: AckDto) { return this.printer.acknowledge(token, jobId, body); }
}
