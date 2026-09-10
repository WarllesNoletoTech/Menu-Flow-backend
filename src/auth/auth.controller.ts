import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtGuard } from './jwt.guard';

class CredentialsDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
}
class BootstrapDto extends CredentialsDto { @IsString() name!: string; }
class CustomerRegistrationDto extends BootstrapDto { @IsString() phone!: string; }
class UpdateMeDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('bootstrap')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  bootstrap(@Body() body: BootstrapDto) {
    return this.auth.bootstrap(body.name, body.email, body.password);
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() body: CredentialsDto) {
    return this.auth.login(body.email, body.password);
  }

  @Post('customer/register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  registerCustomer(@Body() body: CustomerRegistrationDto) {
    return this.auth.registerCustomer(body.name, body.email, body.password, body.phone);
  }

  @Get('me')
  @UseGuards(JwtGuard)
  me(@Req() request: { user: { sub: string } }) {
    return this.auth.profile(request.user.sub);
  }

  @Patch('me')
  @UseGuards(JwtGuard)
  updateMe(@Req() request: { user: { sub: string } }, @Body() body: UpdateMeDto) {
    return this.auth.updateProfile(request.user.sub, body);
  }
}
