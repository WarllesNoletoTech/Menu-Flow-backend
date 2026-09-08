import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../common/schemas';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtGuard } from './jwt.guard';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    JwtModule.registerAsync({ global: true, imports: [ConfigModule], inject: [ConfigService], useFactory: (config: ConfigService) => ({
      secret: config.getOrThrow<string>('JWT_SECRET'), signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '1d' },
    }) }),
  ],
  controllers: [AuthController], providers: [AuthService, JwtGuard], exports: [AuthService],
})
export class AuthModule {}
