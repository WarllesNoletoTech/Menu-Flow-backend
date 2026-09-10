import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsMongoId, IsNumber, IsOptional, IsString, IsUrl, Matches, Max, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { DeliveryCoverageType, EstablishmentType } from '../common/schemas';
import { TenantGuard } from '../common/tenant.guard';
import { RestaurantsService } from './restaurants.service';

const optionalHttpsUrl = () => IsUrl({ protocols: ['https'], require_protocol: true, require_valid_protocol: true }, { message: 'A URL deve ser um link HTTPS válido.' });

class CreateRestaurantDto {
  @IsString() @MinLength(1) name!: string;
  @Matches(/^[a-z0-9-]+$/) slug!: string;
  @IsOptional() @IsString() tradeName?: string;
  @IsOptional() @IsString() cnpj?: string;
  @IsOptional() @ValidateIf((_, value) => value !== '') @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) state?: string;
  @IsOptional() @IsEnum(EstablishmentType) establishmentType?: EstablishmentType;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() whatsapp?: string;
  @IsOptional() @IsString() orderWhatsapp?: string;
  @IsOptional() @IsString() instagram?: string;
  @IsOptional() @ValidateIf((_, value) => value !== '') @optionalHttpsUrl() logoUrl?: string;
  @IsOptional() @ValidateIf((_, value) => value !== '') @optionalHttpsUrl() bannerUrl?: string;
  @IsOptional() @ValidateIf((_, value) => value !== '') @optionalHttpsUrl() mapUrl?: string;
  @IsOptional() @IsString() pickupInstructions?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) restaurantCategories?: string[];
}

class UpdateRestaurantDto extends CreateRestaurantDto {
  @IsOptional() declare name: string;
  @IsOptional() declare slug: string;
  @IsOptional() @IsBoolean() open?: boolean;
  @IsOptional() @IsBoolean() blocked?: boolean;
}

class UpdateSettingsDto { @IsOptional() @IsNumber() @Min(0) minimumOrder?: number; @IsOptional() @IsBoolean() pickupEnabled?: boolean; @IsOptional() @IsBoolean() deliveryEnabled?: boolean; @IsOptional() @IsNumber() @Min(0) preparationMinutes?: number; @IsOptional() @IsBoolean() rappidexEnabled?: boolean; }
class DeliveryZoneDto { @IsOptional() @IsMongoId() id?: string; @IsEnum(DeliveryCoverageType) coverageType!: DeliveryCoverageType; @IsOptional() @IsString() @MinLength(1) name?: string; @IsNumber() @Min(0) fee!: number; @IsOptional() @IsBoolean() active?: boolean; }
class PaymentMethodDto { @IsIn(['PIX', 'CASH', 'CREDIT_CARD', 'DEBIT_CARD']) method!: string; @IsString() @MinLength(1) name!: string; @IsBoolean() active!: boolean; }
class BusinessPeriodDto { @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) openTime!: string; @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) closeTime!: string; }
class BusinessDayDto { @IsInt() @Min(0) @Max(6) dayOfWeek!: number; @IsBoolean() isOpen!: boolean; @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => BusinessPeriodDto) periods!: BusinessPeriodDto[]; }
class BusinessHoursDto { @IsArray() @ArrayMinSize(7) @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => BusinessDayDto) days!: BusinessDayDto[]; }
class OwnerDto { @IsString() @MinLength(1) name!: string; @IsEmail() email!: string; @IsOptional() @IsString() phone?: string; @IsString() @MinLength(8) password!: string; }
class EmployeeDto extends OwnerDto {}
class UpdateStoreUserDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MinLength(8) password?: string;
}
class EstablishmentWithOwnerDto { @ValidateNested() @Type(() => CreateRestaurantDto) establishment!: CreateRestaurantDto; @ValidateNested() @Type(() => OwnerDto) owner!: OwnerDto; }
class OwnerUpdateDto extends UpdateStoreUserDto { @IsString() userId!: string; }
class UpdateWithOwnerDto { @ValidateNested() @Type(() => UpdateRestaurantDto) establishment!: UpdateRestaurantDto; @IsOptional() @ValidateNested() @Type(() => OwnerUpdateDto) owner?: OwnerUpdateDto; }

@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}
  @Get() @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) list() { return this.restaurants.list(); }
  @Get('owner-integrity/diagnostic') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) ownerIntegrityDiagnostic() { return this.restaurants.ownerIntegrityDiagnostic(); }
  @Get('me') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  mine(@Req() request: { user: { restaurantId: string } }): Promise<Record<string, unknown>> { return this.restaurants.ownerDetail(request.user.restaurantId); }
  @Get('my-context') @Roles(Role.RESTAURANT_ADMIN, Role.EMPLOYEE) @UseGuards(JwtGuard, RolesGuard)
  myContext(@Req() request: { user: { restaurantId: string } }) { return this.restaurants.memberContext(request.user.restaurantId); }
  @Patch('me') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  updateMine(@Req() request: { user: { restaurantId: string } }, @Body() body: UpdateRestaurantDto) { return this.restaurants.update(request.user.restaurantId, body, Role.RESTAURANT_ADMIN); }
  @Patch('me/settings') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  updateMySettings(@Req() request: { user: { restaurantId: string } }, @Body() body: UpdateSettingsDto) { return this.restaurants.updateSettings(request.user.restaurantId, body); }
  @Get('me/operations') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  myOperations(@Req() request: { user: { restaurantId: string } }) { return this.restaurants.operationalSettings(request.user.restaurantId); }
  @Post('me/delivery-zones') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  saveMyDeliveryZone(@Req() request: { user: { restaurantId: string } }, @Body() body: DeliveryZoneDto) { return this.restaurants.saveDeliveryZone(request.user.restaurantId, body); }
  @Patch('me/payment-methods') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  saveMyPaymentMethod(@Req() request: { user: { restaurantId: string } }, @Body() body: PaymentMethodDto) { return this.restaurants.savePaymentMethod(request.user.restaurantId, body); }
  @Get('me/business-hours') @Header('Cache-Control', 'no-store, private') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  myBusinessHours(@Req() request: { user: { restaurantId: string } }) { return this.restaurants.businessHours(request.user.restaurantId); }
  @Patch('me/business-hours') @Header('Cache-Control', 'no-store, private') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  updateMyBusinessHours(@Req() request: { user: { sub: string; restaurantId: string } }, @Body() body: BusinessHoursDto) { return this.restaurants.updateBusinessHours(request.user.restaurantId, body.days, request.user.sub, false); }
  @Get('me/users') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  myUsers(@Req() request: { user: { restaurantId: string } }) { return this.restaurants.employeesForRestaurant(request.user.restaurantId); }
  @Post('me/users') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  addMyEmployee(@Req() request: { user: { restaurantId: string } }, @Body() body: EmployeeDto) { return this.restaurants.addEmployee(request.user.restaurantId, body); }
  @Patch('me/users/:userId') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  updateMyEmployee(@Req() request: { user: { restaurantId: string } }, @Param('userId') userId: string, @Body() body: UpdateStoreUserDto) { return this.restaurants.updateEmployee(request.user.restaurantId, userId, body); }
  @Delete('me/users/:userId') @Roles(Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, RolesGuard)
  deleteMyEmployee(@Req() request: { user: { restaurantId: string } }, @Param('userId') userId: string) { return this.restaurants.deleteEmployee(request.user.restaurantId, userId); }
  @Post() @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) create(@Body() body: CreateRestaurantDto) { return this.restaurants.create(body); }
  @Post('with-admin') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) createWithOwner(@Body() body: EstablishmentWithOwnerDto) { return this.restaurants.createWithOwner(body.establishment as Required<Pick<CreateRestaurantDto, 'name' | 'slug' | 'city' | 'state' | 'establishmentType'>> & CreateRestaurantDto, body.owner); }
  @Get(':restaurantId/admin-detail') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) adminDetail(@Param('restaurantId') id: string) { return this.restaurants.adminDetail(id); }
  @Get(':restaurantId/business-hours') @Header('Cache-Control', 'no-store, private') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) businessHours(@Param('restaurantId') id: string) { return this.restaurants.businessHours(id); }
  @Patch(':restaurantId/business-hours') @Header('Cache-Control', 'no-store, private') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) updateBusinessHours(@Param('restaurantId') id: string, @Req() request: { user: { sub: string } }, @Body() body: BusinessHoursDto) { return this.restaurants.updateBusinessHours(id, body.days, request.user.sub, true); }
  @Patch(':restaurantId/with-owner') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) updateWithOwner(@Param('restaurantId') id: string, @Body() body: UpdateWithOwnerDto) { return this.restaurants.updateWithOwner(id, body.establishment, body.owner); }
  @Post(':restaurantId/owners') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) addOwner(@Param('restaurantId') id: string, @Body() body: OwnerDto) { return this.restaurants.addOwner(id, body); }
  @Post(':restaurantId/employees') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) addEmployee(@Param('restaurantId') id: string, @Body() body: EmployeeDto) { return this.restaurants.addEmployee(id, body); }
  @Get(':restaurantId/users') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) users(@Param('restaurantId') id: string) { return this.restaurants.usersForRestaurant(id); }
  @Patch(':restaurantId/users/:userId') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) updateUser(@Param('restaurantId') restaurantId: string, @Param('userId') userId: string, @Body() body: UpdateStoreUserDto) { return this.restaurants.updateStoreUser(restaurantId, userId, body); }
  @Delete(':restaurantId/employees/:userId') @Roles(Role.SUPER_ADMIN) @UseGuards(JwtGuard, RolesGuard) deleteEmployee(@Param('restaurantId') restaurantId: string, @Param('userId') userId: string) { return this.restaurants.deleteEmployee(restaurantId, userId); }
  @Patch(':restaurantId') @Roles(Role.SUPER_ADMIN, Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard) update(@Param('restaurantId') id: string, @Body() body: UpdateRestaurantDto, @Req() request: { user: { role: Role } }) { return this.restaurants.update(id, body, request.user.role); }
  @Patch(':restaurantId/settings') @Roles(Role.SUPER_ADMIN, Role.RESTAURANT_ADMIN) @UseGuards(JwtGuard, TenantGuard, RolesGuard) updateSettings(@Param('restaurantId') id: string, @Body() body: UpdateSettingsDto) { return this.restaurants.updateSettings(id, body); }
  @Get(':slug') @Header('Cache-Control', 'no-store') find(@Param('slug') slug: string): Promise<Record<string, unknown>> { return this.restaurants.bySlug(slug); }
}
