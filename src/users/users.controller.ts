import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from '../auth/auth.service';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { EstablishmentType, Restaurant, User } from '../common/schemas';

class CreateUserDto {
  @IsString() name!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsEnum(Role) role!: Role;
  @IsOptional() @IsMongoId() restaurantId?: string;
}
@Controller('users')
@UseGuards(JwtGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class UsersController {
  constructor(private readonly auth: AuthService, @InjectModel(User.name) private readonly users: Model<User>, @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>) {}
  @Get() async list(@Query('search') search?: string, @Query('role') role?: Role, @Query('status') status?: string) {
    const filter: Record<string, unknown> = {};
    if (search?.trim()) filter.$or = [{ name: { $regex: search.trim(), $options: 'i' } }, { email: { $regex: search.trim(), $options: 'i' } }];
    if (role && Object.values(Role).includes(role)) filter.role = role;
    if (status === 'active' || status === 'inactive') filter.active = status === 'active';
    const users = await this.users.find(filter).select('name email phone role active restaurantId').populate('restaurantId', 'name tradeName').sort({ createdAt: -1 }).lean();
    return users.map((user) => ({ id: user._id.toString(), name: user.name, email: user.email, phone: user.phone, role: user.role, active: user.active, establishment: user.restaurantId && typeof user.restaurantId === 'object' ? ((user.restaurantId as unknown as { tradeName?: string; name: string }).tradeName || (user.restaurantId as unknown as { name: string }).name) : null }));
  }
  @Get('dashboard') async dashboard() {
    const [total, active, blocked, byType] = await Promise.all([this.restaurants.countDocuments(), this.restaurants.countDocuments({ blocked: false }), this.restaurants.countDocuments({ blocked: true }), this.restaurants.aggregate<{ _id: EstablishmentType; count: number }>([{ $group: { _id: '$establishmentType', count: { $sum: 1 } } }])]);
    const types = Object.fromEntries(Object.values(EstablishmentType).map((type) => [type, byType.find((item) => item._id === type)?.count ?? 0]));
    return { total, active, blocked, types };
  }
  @Post() create(@Body() body: CreateUserDto) { if (body.role === Role.SUPER_ADMIN) throw new BadRequestException('Administradores exigem uma operação de segurança específica.'); return this.auth.create(body.name, body.email, body.password, body.role, body.restaurantId); }
}

@Controller('employees')
@UseGuards(JwtGuard, RolesGuard)
@Roles(Role.RESTAURANT_ADMIN)
export class EmployeesController {
  constructor(private readonly auth: AuthService) {}
  @Post() create(@Body() body: Omit<CreateUserDto, 'role' | 'restaurantId'>, @Req() request: { user: { restaurantId: string } }) {
    return this.auth.create(body.name, body.email, body.password, Role.EMPLOYEE, request.user.restaurantId);
  }
}
