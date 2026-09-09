import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsEmail, IsEnum, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { EstablishmentType } from '../common/schemas';
import { TenantGuard } from '../common/tenant.guard';
import { RestaurantsService } from './restaurants.service';

class CreateRestaurantDto {
  @IsString() name!: string; @Matches(/^[a-z0-9-]+$/) slug!: string; @IsOptional() @IsString() tradeName?: string;
  @IsOptional() @IsString() cnpj?: string; @IsOptional() @IsEmail() email?: string; @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() description?: string; @IsOptional() @IsString() city?: string; @IsOptional() @Matches(/^[A-Z]{2}$/) state?: string;
  @IsOptional() @IsEnum(EstablishmentType) establishmentType?: EstablishmentType; @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() whatsapp?: string; @IsOptional() @IsString() instagram?: string; @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() @IsString() bannerUrl?: string; @IsOptional() @IsArray() @IsString({ each: true }) restaurantCategories?: string[];
}
class UpdateRestaurantDto extends CreateRestaurantDto { @IsOptional() declare name: string; @IsOptional() declare slug: string; @IsOptional() @IsBoolean() open?: boolean; @IsOptional() @IsBoolean() blocked?: boolean; }
class UpdateSettingsDto { @IsOptional() @IsNumber() @Min(0) minimumOrder?: number; @IsOptional() @IsNumber() @Min(0) preparationMinutes?: number; @IsOptional() @IsBoolean() rappidexEnabled?: boolean; }

@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}
  @Get() @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) list() { return this.restaurants.list(); }
  @Get(':slug') find(@Param('slug') slug: string) { return this.restaurants.bySlug(slug); }
  @Post() @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) create(@Body() body: CreateRestaurantDto) { return this.restaurants.create(body); }
  @Patch(':restaurantId') @Roles(Role.SUPER_ADMIN, Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard) update(@Param('restaurantId') id: string, @Body() body: UpdateRestaurantDto, @Req() request: { user: { role: Role } }) { return this.restaurants.update(id, body, request.user.role); }
  @Patch(':restaurantId/settings') @Roles(Role.SUPER_ADMIN, Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard) updateSettings(@Param('restaurantId') id: string, @Body() body: UpdateSettingsDto) { return this.restaurants.updateSettings(id, body); }
}
