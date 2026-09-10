import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, Validate, ValidateIf } from 'class-validator';
import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { HomeBannersService } from './home-banners.service';

export function isSafeHttpsUrl(value: string) { try { const url = new URL(value); return url.protocol === 'https:'; } catch { return false; } }
export function isSafeTargetUrl(value: string) { return value.startsWith('/') ? !value.startsWith('//') && !/[\\\r\n]/.test(value) : isSafeHttpsUrl(value); }
@ValidatorConstraint({ name: 'safeImageUrl' }) class SafeImageUrl implements ValidatorConstraintInterface { validate(value: unknown) { return typeof value === 'string' && isSafeHttpsUrl(value); } defaultMessage() { return 'Informe uma URL segura iniciada por https://.'; } }
@ValidatorConstraint({ name: 'safeTargetUrl' }) class SafeTargetUrl implements ValidatorConstraintInterface { validate(value: unknown) { return typeof value === 'string' && isSafeTargetUrl(value); } defaultMessage() { return 'Informe um caminho interno ou uma URL segura iniciada por https://.'; } }

export class CreateHomeBannerDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsString() @Validate(SafeImageUrl) desktopImageUrl!: string;
  @IsString() @Validate(SafeImageUrl) mobileImageUrl!: string;
  @IsOptional() @ValidateIf((_, value) => value !== '') @IsString() @Validate(SafeTargetUrl) targetUrl?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
export class UpdateHomeBannerDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @Validate(SafeImageUrl) desktopImageUrl?: string;
  @IsOptional() @IsString() @Validate(SafeImageUrl) mobileImageUrl?: string;
  @IsOptional() @ValidateIf((_, value) => value !== '') @IsString() @Validate(SafeTargetUrl) targetUrl?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
@Controller('admin/home-banners') @UseGuards(JwtGuard, RolesGuard) @Roles(Role.SUPER_ADMIN)
export class HomeBannersController {
  constructor(private readonly service: HomeBannersService) {}
  @Get() list(): Promise<Array<Record<string, unknown>>> { return this.service.adminList(); }
  @Post() create(@Body() body: CreateHomeBannerDto, @Req() request: { user: { sub: string } }) { return this.service.create(body, request.user.sub); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: UpdateHomeBannerDto, @Req() request: { user: { sub: string } }) { return this.service.update(id, body, request.user.sub); }
  @Delete(':id') remove(@Param('id') id: string, @Req() request: { user: { sub: string } }) { return this.service.remove(id, request.user.sub); }
}
@Controller('public/home-banners') export class PublicHomeBannersController { constructor(private readonly service: HomeBannersService) {} @Get() list() { return this.service.publicList(); } }
