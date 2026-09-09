import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEmail, IsEnum, IsNumber, IsOptional, IsString, Matches, Min, MinLength, ValidateNested } from 'class-validator';
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
class OwnerDto { @IsString() @MinLength(1) name!: string; @IsEmail() email!: string; @IsOptional() @IsString() phone?: string; @IsString() @MinLength(8) password!: string; }
class EstablishmentWithOwnerDto { @ValidateNested() @Type(() => CreateRestaurantDto) establishment!: CreateRestaurantDto; @ValidateNested() @Type(() => OwnerDto) owner!: OwnerDto; }

@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}
  @Get() @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) list(): Promise<Array<Record<string, unknown>>> { return this.restaurants.list(); }
  @Get(':slug') find(@Param('slug') slug: string) { return this.restaurants.bySlug(slug); }
  @Post() @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) create(@Body() body: CreateRestaurantDto) { return this.restaurants.create(body); }
  @Post('with-admin') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) createWithOwner(@Body() body: EstablishmentWithOwnerDto) { return this.restaurants.createWithOwner(body.establishment as Required<Pick<CreateRestaurantDto, 'name' | 'slug' | 'city' | 'state' | 'establishmentType'>> & CreateRestaurantDto, body.owner); }
  @Post(':restaurantId/owners') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) addOwner(@Param('restaurantId') id: string, @Body() body: OwnerDto) { return this.restaurants.addOwner(id, body); }
  @Get(':restaurantId/users') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) users(@Param('restaurantId') id: string) { return this.restaurants.usersForRestaurant(id); }
  @Patch(':restaurantId') @Roles(Role.SUPER_ADMIN, Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard) update(@Param('restaurantId') id: string, @Body() body: UpdateRestaurantDto, @Req() request: { user: { role: Role } }) { return this.restaurants.update(id, body, request.user.role); }
  @Patch(':restaurantId/settings') @Roles(Role.SUPER_ADMIN, Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard) updateSettings(@Param('restaurantId') id: string, @Body() body: UpdateSettingsDto) { return this.restaurants.updateSettings(id, body); }
}
