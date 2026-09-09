import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from '../auth/auth.service';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';

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
  constructor(private readonly auth: AuthService) {}
  @Post() create(@Body() body: CreateUserDto) { return this.auth.create(body.name, body.email, body.password, body.role, body.restaurantId); }
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
