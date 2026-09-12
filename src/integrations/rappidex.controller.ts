import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsDateString, IsOptional, IsString } from 'class-validator';
import { RappidexIntegrationGuard } from './rappidex.guard';
import { RappidexIntegrationService } from './rappidex.service';

class RappidexStatusEventDto {
  @IsString()
  orderId!: string;

  @IsString()
  deliveryId!: string;

  @IsString()
  status!: string;

  @IsOptional()
  @IsString()
  statusLabel?: string;

  @IsOptional()
  @IsString()
  eventId?: string;

  @IsOptional()
  @IsDateString()
  updatedAt?: string;

  @IsOptional()
  @IsString()
  motoboyName?: string;

  @IsOptional()
  @IsString()
  motoboyPhone?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller('integrations/rappidex')
@UseGuards(RappidexIntegrationGuard)
export class RappidexIntegrationController {
  constructor(private readonly rappidex: RappidexIntegrationService) {}

  @Post('status')
  status(@Body() body: RappidexStatusEventDto) {
    return this.rappidex.applyStatusUpdate(body);
  }
}
