import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { CustomersService } from './customers.service';
class AddressDto { @IsString() label!: string; @IsString() street!: string; @IsString() number!: string; @IsString() neighborhood!: string; @IsString() city!: string; @IsString() state!: string; @IsString() zipCode!: string; @IsOptional() @IsString() complement?: string; @IsOptional() @IsBoolean() primary?: boolean; }
class UpdateProfileDto { @IsOptional() @IsString() name?: string; @IsOptional() @IsString() phone?: string; }
@Controller('customer') @UseGuards(JwtGuard, RolesGuard) @Roles(Role.CUSTOMER)
export class CustomersController { constructor(private readonly customers: CustomersService) {} @Get('me') me(@Req() req: { user: { sub: string } }) { return this.customers.profile(req.user.sub); } @Patch('me') update(@Req() req: { user: { sub: string } }, @Body() body: UpdateProfileDto) { return this.customers.updateProfile(req.user.sub, body); } @Post('addresses') add(@Req() req: { user: { sub: string } }, @Body() body: AddressDto) { return this.customers.addAddress(req.user.sub, body); } @Patch('addresses/:addressId') edit(@Req() req: { user: { sub: string } }, @Param('addressId') addressId: string, @Body() body: Partial<AddressDto>) { return this.customers.updateAddress(req.user.sub, addressId, body); } @Delete('addresses/:addressId') remove(@Req() req: { user: { sub: string } }, @Param('addressId') addressId: string) { return this.customers.removeAddress(req.user.sub, addressId); } }
