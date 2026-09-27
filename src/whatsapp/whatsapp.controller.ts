import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { WhatsappService } from './whatsapp.service';
import { validSignature } from './whatsapp.logic';
class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(700) greeting?: string;
  @IsOptional() @IsString() @MaxLength(700) deliveryText?: string;
  @IsOptional() @IsString() @MaxLength(700) handoffText?: string;
}
class ConnectionDto {
  @IsString() @Matches(/^\d{5,30}$/) phoneNumberId!: string;
  @IsString() @MinLength(20) @MaxLength(4096) accessToken!: string;
}
class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(4000) text!: string;
  @IsUUID('4') requestId!: string;
}
class ModeDto { @IsBoolean() human!: boolean; }
type ActorRequest = { user: { restaurantId: string } };
@Controller('whatsapp')
@UseGuards(JwtGuard, RolesGuard)
@Roles(Role.RESTAURANT_ADMIN)
export class WhatsappController {
  constructor(private readonly service: WhatsappService) {}
  @Get('settings') @Header('Cache-Control', 'no-store, private') settings(@Req() r: ActorRequest) { return this.service.getSettings(r.user.restaurantId); }
  @Patch('settings') update(@Req() r: ActorRequest, @Body() dto: SettingsDto) { return this.service.updateSettings(r.user.restaurantId, dto); }
  @Get('conversations') @Header('Cache-Control', 'no-store, private') inbox(@Req() r: ActorRequest) { return this.service.inbox(r.user.restaurantId); }
  @Get('conversations/:id') @Header('Cache-Control', 'no-store, private') history(@Req() r: ActorRequest, @Param('id') id: string) { return this.service.history(r.user.restaurantId, id); }
  @Patch('conversations/:id') mode(@Req() r: ActorRequest, @Param('id') id: string, @Body() dto: ModeDto) { return this.service.mode(r.user.restaurantId, id, dto.human); }
  @Post('conversations/:id/messages') reply(@Req() r: ActorRequest, @Param('id') id: string, @Body() dto: ReplyDto) { return this.service.reply(r.user.restaurantId, id, dto.text, dto.requestId); }
  @Get('admin/stores') @Header('Cache-Control', 'no-store, private') @Roles(Role.SUPER_ADMIN) stores() { return this.service.adminStores(); }
  @Post('admin/stores/:id/connection') @Roles(Role.SUPER_ADMIN) connect(@Param('id') id: string, @Body() dto: ConnectionDto) { return this.service.connect(id, dto); }
  @Delete('admin/stores/:id/connection') @Roles(Role.SUPER_ADMIN) disconnect(@Param('id') id: string) { return this.service.disconnect(id); }
}
@Controller('whatsapp/webhook')
@SkipThrottle()
export class WhatsappWebhookController {
  constructor(private readonly service: WhatsappService) {}
  @Get() @Header('Content-Type', 'text/plain') verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    if (mode !== 'subscribe' || !process.env.WHATSAPP_VERIFY_TOKEN || token !== process.env.WHATSAPP_VERIFY_TOKEN || typeof challenge !== 'string') throw new UnauthorizedException();
    return challenge;
  }
  @Post() @HttpCode(200) async receive(@Req() req: { rawBody?: Buffer }, @Headers('x-hub-signature-256') signature: string, @Body() payload: Record<string, unknown>) {
    if (!validSignature(req.rawBody, signature, process.env.WHATSAPP_APP_SECRET || '')) throw new UnauthorizedException();
    await this.service.receive(payload); return { received: true };
  }
}
