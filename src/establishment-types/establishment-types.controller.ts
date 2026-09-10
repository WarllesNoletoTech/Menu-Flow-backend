import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { JwtGuard } from '../auth/jwt.guard';
import { Role } from '../common/roles';
import { Roles, RolesGuard } from '../common/roles.guard';
import { EstablishmentTypesService } from './establishment-types.service';

class TypeDto { @IsString() @MinLength(1) name!: string; @IsOptional() @IsBoolean() active?: boolean; @IsOptional() @IsInt() @Min(0) sortOrder?: number; }
class UpdateTypeDto { @IsOptional() @IsString() @MinLength(1) name?: string; @IsOptional() @IsBoolean() active?: boolean; @IsOptional() @IsInt() @Min(0) sortOrder?: number; }

@Controller('establishment-types')
@UseGuards(JwtGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class EstablishmentTypesController {
  constructor(private readonly service: EstablishmentTypesService) {}
  @Get() list() { return this.service.adminList(); }
  @Post() create(@Body() body: TypeDto, @Req() request: { user: { sub: string } }) { return this.service.create(body, request.user.sub); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: UpdateTypeDto) { return this.service.update(id, body); }
  @Delete(':id') remove(@Param('id') id: string) { return this.service.remove(id); }
}

@Controller('public/establishment-types')
export class PublicEstablishmentTypesController {
  constructor(private readonly service: EstablishmentTypesService) {}
  @Get() list() { return this.service.publicList(); }
}
