import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.FRONTEND_URL?.split(',') ?? true, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const config = new DocumentBuilder().setTitle('Menu Flow API').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('api', app, SwaggerModule.createDocument(app, config));
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
