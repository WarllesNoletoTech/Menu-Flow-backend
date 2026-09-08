import { Body, Controller, Post, UseGuards } from '@nestjs/common';
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
