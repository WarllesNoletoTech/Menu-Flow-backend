import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, Validate, ValidateIf, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { BannerUploadFile } from './banner-storage.service';
import { HomeBannersService } from './home-banners.service';

export function isSafeHttpsUrl(value: string) { try { return new URL(value.trim()).protocol === 'https:'; } catch { return false; } }
export function isSafeTargetUrl(value: string) { const target = value.trim(); return target.startsWith('/') ? !target.startsWith('//') && !/[\\\r\n]/.test(target) : isSafeHttpsUrl(target); }
@ValidatorConstraint({ name: 'safeTargetUrl' }) class SafeTargetUrl implements ValidatorConstraintInterface { validate(value: unknown) { return typeof value === 'string' && isSafeTargetUrl(value); } defaultMessage() { return 'Informe um caminho interno ou uma URL segura iniciada por https://.'; } }
const toBoolean = ({ value }: { value: unknown }) => value === true || value === 'true';
const toInteger = ({ value }: { value: unknown }) => typeof value === 'string' ? Number(value) : value;

export class CreateHomeBannerDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @ValidateIf((_, value) => value !== '') @IsString() @MaxLength(2048) @Validate(SafeTargetUrl) targetUrl?: string;
  @IsOptional() @Transform(toBoolean) @IsBoolean() active?: boolean;
  @IsOptional() @Transform(toInteger) @IsInt() @Min(0) sortOrder?: number;
}
export class UpdateHomeBannerDto extends CreateHomeBannerDto {
  @IsOptional() declare name: string;
}
export type BannerFiles = { desktopImage?: BannerUploadFile[]; mobileImage?: BannerUploadFile[] };
const uploadOptions = {
  storage: undefined,
  limits: { fileSize: 5 * 1024 * 1024, files: 2 },
  fileFilter: (_request: unknown, file: BannerUploadFile, callback: (error: Error | null, accept: boolean) => void) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return callback(new BadRequestException('Formato de arquivo não permitido.'), false);
    callback(null, true);
  },
};
const bannerFiles = FileFieldsInterceptor([{ name: 'desktopImage', maxCount: 1 }, { name: 'mobileImage', maxCount: 1 }], uploadOptions);

@Controller('admin/home-banners') @UseGuards(JwtGuard, RolesGuard) @Roles(Role.SUPER_ADMIN)
export class HomeBannersController {
  constructor(private readonly service: HomeBannersService) {}
  @Get() list(): Promise<Array<Record<string, unknown>>> { return this.service.adminList(); }
  @Post() @UseInterceptors(bannerFiles) create(@Body() body: CreateHomeBannerDto, @UploadedFiles() files: BannerFiles, @Req() request: { user: { sub: string } }) { return this.service.create(body, files ?? {}, request.user.sub); }
  @Patch(':id') @UseInterceptors(bannerFiles) update(@Param('id') id: string, @Body() body: UpdateHomeBannerDto, @UploadedFiles() files: BannerFiles, @Req() request: { user: { sub: string } }) { return this.service.update(id, body, files ?? {}, request.user.sub); }
  @Delete(':id') remove(@Param('id') id: string, @Req() request: { user: { sub: string } }) { return this.service.remove(id, request.user.sub); }
}
@Controller('public/home-banners') export class PublicHomeBannersController { constructor(private readonly service: HomeBannersService) {} @Get() list() { return this.service.publicList(); } }
